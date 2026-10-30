// P3/P4 消息链路测试：触发判断、分段、去重/队列/冷却、上下文裁剪、协议解析、模型客户端。
//
// 这一层的 bug 都很"安静"：不报错、不崩溃，只是回得不对。
// 所以用例集中在几个真出过问题的地方——
// 上下文被裁剪成以 assistant 开头、长回复被切成十条刷屏、
// 黑名单用户靠随机命中被回复。
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { Cooldown, Dedupe, TaskQueue, decide, split, stripMarkdown, truncate } from '../src/bot';
import { Manager as ContextManager } from '../src/ctxmgr';
import { LlmClient, endpoint, estimateTokens } from '../src/llm/client';
import type { Event } from '../src/onebot/types';
import { atTargets, mentions, parseCQ, plainText } from '../src/onebot/types';
import { build as buildSystem, emptyVars, expand } from '../src/persona';
import { Store } from '../src/store';
import { defaultSettings, type BotSettings } from '../src/store/types';

const tmpDirs: string[] = [];
after(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function tempStore(): Store {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-bot-'));
  tmpDirs.push(dir);
  return new Store(join(dir, 'qqbot.db'));
}

function botSettings(patch: Partial<BotSettings> = {}): BotSettings {
  return { ...defaultSettings().bot, ...patch };
}

function ev(patch: Partial<Event> = {}): Event {
  return {
    time: 0,
    self_id: 10000,
    post_type: 'message',
    message_type: 'group',
    message_id: 1,
    user_id: 20000,
    group_id: 30000,
    message: [{ type: 'text', data: { text: '你好' } }],
    raw: {},
    ...patch,
  };
}

// ---- 分段 ----

describe('回复分段', () => {
  it('单句不切', () => {
    assert.deepEqual(split('今天天气不错。'), ['今天天气不错。']);
  });

  it('整段不超长时不切，且保留英文句后空格', () => {
    const out = split('Hello! How are you? I am fine.', { maxSegments: 4, maxRunes: 120 });
    assert.deepEqual(out, ['Hello! How are you? I am fine.']);
  });

  it('按句末标点切段，切点落在句子边界', () => {
    const out = split('Hello! How are you? I am fine.', { maxSegments: 4, maxRunes: 10 });
    assert.deepEqual(out, ['Hello!', 'How are you?', 'I am fine.']);
  });

  it('单句超过 maxRunes 时不再硬切（宁可超长也不截断半句）', () => {
    const long = '这是一个很长很长的句子没有句号结尾但是超过了限制';
    assert.deepEqual(split(long, { maxSegments: 4, maxRunes: 5 }), [long]);
  });

  it('短句合并到不超过 maxRunes', () => {
    const out = split('一。二。三。四。', { maxSegments: 8, maxRunes: 5 });
    assert.deepEqual(out, ['一。二。', '三。四。']);
  });

  it('累积长度按拼好的整段算，空白多时也不会超限', () => {
    // 句子保留了原文空白（"Hello! How" 里的空格），若按 trim 后的长度累加、
    // 却把未 trim 的原文塞进去，段长会随空白量漂出去。
    const out = split('aaa。   bbb。   ccc。', { maxSegments: 9, maxRunes: 10 });
    for (const s of out) {
      assert.ok([...s].length <= 10, `段超限: ${JSON.stringify(s)}`);
    }
  });

  it('超出段数上限时合并到最后一段并补省略号', () => {
    const text = '这是第一句话。这是第二句话。这是第三句话。这是第四句话。';
    const out = split(text, { maxSegments: 2, maxRunes: 8 });
    assert.equal(out.length, 2);
    assert.ok(out[1]!.endsWith('…'), `最后一段应带省略号: ${out[1]}`);
    assert.ok([...out[1]!].length <= 8);
  });

  it('空文本返回空数组', () => {
    assert.deepEqual(split('   '), []);
  });

  it('truncate 按字符计并补省略号', () => {
    assert.equal(truncate('一二三四五', 3), '一二…');
    assert.equal(truncate('一二三', 3), '一二三');
  });

  it('清理 Markdown 记号并折叠空行', () => {
    assert.equal(stripMarkdown('**加粗** 和 `代码`'), '加粗 和 代码');
    assert.equal(stripMarkdown('# 标题\n\n\n\n正文'), '标题\n\n正文');
    assert.equal(stripMarkdown('- 第一项\n- 第二项'), '第一项\n第二项');
    assert.equal(stripMarkdown('### 小标题'), '小标题');
  });

  it('清理 Markdown 不会改坏算式与正文里的减号/星号', () => {
    // 这两条规则原本是全文替换，'5 - 3 = 2' 会变成 '53 = 2'；
    // 而这段清理对每一条回复都生效，用户和模型都不会察觉内容被改了。
    assert.equal(stripMarkdown('5 - 3 = 2'), '5 - 3 = 2');
    assert.equal(stripMarkdown('2 * 3 = 6'), '2 * 3 = 6');
    assert.equal(stripMarkdown('C# 语言'), 'C# 语言');
    assert.equal(stripMarkdown('docker run - d'), 'docker run - d');
  });
});

// ---- 触发判断 ----

describe('触发判断', () => {
  it('黑名单优先于一切，包括 @', () => {
    const s = botSettings({ blacklist_users: [20000] });
    const d = decide(ev(), s, 10000, new Cooldown());
    assert.equal(d.respond, false);
    assert.equal(d.reason, '用户在黑名单');
  });

  it('私聊直接回复', () => {
    const d = decide(
      ev({ message_type: 'private', group_id: 0 }),
      botSettings(),
      10000,
      new Cooldown(),
    );
    assert.equal(d.respond, true);
    assert.equal(d.reason, '私聊');
    assert.equal(d.direct, true);
  });

  it('群白名单非空时只处理白名单内的群', () => {
    const s = botSettings({ whitelist_groups: [99999] });
    const d = decide(ev(), s, 10000, new Cooldown());
    assert.equal(d.respond, false);
    assert.equal(d.reason, '群不在白名单');

    const ok = decide(ev(), botSettings({ whitelist_groups: [30000] }), 10000, new Cooldown());
    // 白名单内但没 @ 也没唤醒词 → 走被动概率，这里只断言它没被白名单拦
    assert.notEqual(ok.reason, '群不在白名单');
  });

  it('@ 机器人触发，且正文里去掉唤醒词', () => {
    const s = botSettings({ wake_words: ['小Q'] });
    const d = decide(
      ev({
        message: [
          { type: 'at', data: { qq: '10000' } },
          { type: 'text', data: { text: ' 小Q 今天几号' } },
        ],
      }),
      s,
      10000,
      new Cooldown(),
    );
    assert.equal(d.respond, true);
    assert.equal(d.reason, '被@');
    assert.equal(d.text, '今天几号');
    assert.equal(d.direct, true);
  });

  it('私聊与群里的冷却互不影响', () => {
    // 同一个 Cooldown 里两个键：私聊 p:<qq>、群内 u:<qq>。
    // 共用一个键的话，用户刚在群里 @ 过一次、紧接着私聊一句，
    // 私聊那条会被判"冷却中"直接丢掉——不回复，正文也不进历史。
    const cool = new Cooldown();
    const s = botSettings({ wake_words: [] });

    const priv = decide(ev({ message_type: 'private', group_id: 0 }), s, 10000, cool);
    assert.equal(priv.respond, true);
    assert.equal(priv.reason, '私聊');

    const inGroup = decide(
      ev({ message: [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text: 'hi' } }] }),
      s,
      10000,
      cool,
    );
    assert.equal(inGroup.respond, true, '群里的 @ 不该被私聊的冷却压掉');
    assert.equal(inGroup.reason, '被@');

    // 反方向同理：紧接着再私聊一句仍然可以（私聊自己的冷却早就过了吗？没过，
    // 所以这里再立刻私聊应当仍被私聊冷却挡住——冷却本身还在工作）
    const priv2 = decide(ev({ message_type: 'private', group_id: 0 }), s, 10000, cool);
    assert.equal(priv2.respond, false);
    assert.equal(priv2.reason, '私聊冷却中');
  });

  it('@ 别人不触发', () => {
    const d = decide(
      ev({ message: [{ type: 'at', data: { qq: '99999' } }, { type: 'text', data: { text: 'hi' } }] }),
      botSettings({ passive_rate: 0 }),
      10000,
      new Cooldown(),
    );
    assert.equal(d.respond, false);
  });

  it('唤醒词触发并剥离前缀', () => {
    const s = botSettings({ wake_words: ['小Q'] });
    const d = decide(
      ev({ message: [{ type: 'text', data: { text: '小Q 讲个笑话' } }] }),
      s,
      10000,
      new Cooldown(),
    );
    assert.equal(d.respond, true);
    assert.equal(d.reason, '命中唤醒词');
    assert.equal(d.text, '讲个笑话');
  });

  it('被动接话关闭时不回复普通消息', () => {
    const d = decide(ev(), botSettings({ passive_rate: 0 }), 10000, new Cooldown());
    assert.equal(d.respond, false);
    assert.equal(d.reason, '被动接话已关闭');
  });

  it('被动概率 1 时普通消息也回复，且 direct 为 false', () => {
    const d = decide(ev(), botSettings({ passive_rate: 1 }), 10000, new Cooldown());
    assert.equal(d.respond, true);
    assert.equal(d.reason, '被动接话');
    assert.equal(d.direct, false);
  });

  it('被动接话受群冷却限制', () => {
    const cool = new Cooldown();
    const s = botSettings({ passive_rate: 1, group_cooldown_sec: 30 });
    assert.equal(decide(ev(), s, 10000, cool).respond, true);
    const second = decide(ev({ message_id: 2 }), s, 10000, cool);
    assert.equal(second.respond, false);
    assert.equal(second.reason, '群冷却中');
  });

  it('@ 触发也受用户冷却限制（防连刷）', () => {
    const cool = new Cooldown();
    const s = botSettings();
    const msg = {
      message: [{ type: 'at', data: { qq: '10000' } }, { type: 'text', data: { text: 'hi' } }],
    };
    assert.equal(decide(ev(msg), s, 10000, cool).respond, true);
    const second = decide(ev({ ...msg, message_id: 2 }), s, 10000, cool);
    assert.equal(second.respond, false);
    assert.equal(second.reason, '用户冷却中');
  });

  it('没有可读文本（纯 @）时不进被动分支', () => {
    const d = decide(
      ev({ message: [{ type: 'at', data: { qq: '99999' } }] }),
      botSettings({ passive_rate: 1 }),
      10000,
      new Cooldown(),
    );
    assert.equal(d.respond, false);
    assert.equal(d.reason, '无可读文本');
  });
});

// ---- 去重 / 队列 / 冷却 ----

describe('去重', () => {
  it('同一 message_id 第二次返回 true', () => {
    const d = new Dedupe();
    assert.equal(d.seenBefore(1), false);
    assert.equal(d.seenBefore(1), true);
    assert.equal(d.size, 1);
  });

  it('message_id 为 0 时不登记（部分协议端不给）', () => {
    const d = new Dedupe();
    assert.equal(d.seenBefore(0), false);
    assert.equal(d.seenBefore(0), false);
    assert.equal(d.size, 0);
  });
});

describe('任务队列', () => {
  it('同一会话排队超过上限时丢弃', async () => {
    const q = new TaskQueue(1, 1);
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    assert.equal(q.submit('a', () => gate), true);
    assert.equal(q.submit('a', () => undefined), false, '同会话第二个应被丢弃');
    assert.equal(q.submit('b', () => undefined), true, '不同会话不受影响');

    release();
    await gate;
  });

  it('同一会话严格串行', async () => {
    const q = new TaskQueue(4, 4);
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    q.submit('s', async () => {
      order.push('first-in');
      await gate;
      order.push('first-out');
    });
    q.submit('s', () => {
      order.push('second');
    });

    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(order, ['first-in'], '第二个任务必须等第一个完成');
    release();
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(order, ['first-in', 'first-out', 'second']);
  });

  it('并发上限可在运行时调整，调大后立刻放行等待中的会话', async () => {
    const q = new TaskQueue(1, 8);
    const order: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });

    q.submit('a', async () => {
      order.push('a-in');
      await gate;
      order.push('a-out');
    });
    q.submit('b', () => {
      order.push('b');
    });

    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(order, ['a-in'], '上限为 1 时 b 应排队');
    assert.equal(q.concurrency, 1);

    q.setConcurrency(2);
    await new Promise((r) => setTimeout(r, 30));
    assert.deepEqual(order, ['a-in', 'b'], '调大上限后 b 应立刻开始跑');
    assert.equal(q.concurrency, 2);

    release();
    await gate;
  });

  it('并发上限被调成 0 或非法值时收敛到 1', () => {
    const q = new TaskQueue(3, 3);
    q.setConcurrency(0);
    assert.equal(q.concurrency, 1);
    q.setConcurrency(Number.NaN);
    assert.equal(q.concurrency, 1);
  });

  it('accepts() 与 submit() 判定一致（定时消息靠它先问空位）', () => {
    const q = new TaskQueue(4, 1);
    assert.equal(q.accepts('s'), true);
    q.submit('s', () => undefined);
    assert.equal(q.accepts('s'), false, '排满后不能再塞');
    assert.equal(q.accepts('other'), true, '别的会话不受影响');
  });

  it('任务抛错时回调 onError，而不是静默消失', async () => {
    const seen: [string, unknown][] = [];
    const q = new TaskQueue(1, 3, (key, err) => seen.push([key, err]));
    q.submit('s', () => {
      throw new Error('db is locked');
    });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(seen.length, 1);
    assert.equal(seen[0]![0], 's');
    assert.equal((seen[0]![1] as Error).message, 'db is locked');

    // 前一个任务失败不能把整条链断掉
    let ran = false;
    q.submit('s', () => {
      ran = true;
    });
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(ran, true);
  });
});

describe('冷却窗口', () => {
  it('窗口内拒绝、过期后放行', () => {
    const c = new Cooldown();
    assert.equal(c.allow('k', 40), true);
    assert.equal(c.allow('k', 40), false);
    assert.ok(c.peek('k', 40) > 0);
    assert.equal(c.peek('other', 40), 0);
  });

  it('窗口为 0 时永远放行且不记录', () => {
    const c = new Cooldown();
    assert.equal(c.allow('k', 0), true);
    assert.equal(c.allow('k', 0), true);
    assert.equal(c.peek('k', 0), 0);
  });
});

// ---- 上下文裁剪 ----

describe('上下文窗口', () => {
  it('空历史时只含 system + 本轮 user', () => {
    const st = tempStore();
    try {
      const m = new ContextManager(st);
      const msgs = m.build('group:1', { max_turns: 10, token_budget: 3000 }, 'SYS', '你好');
      assert.deepEqual(
        msgs.map((x) => x.role),
        ['system', 'user'],
      );
      assert.equal(msgs[1]!.content, '你好');
    } finally {
      st.close();
    }
  });

  it('保留最近若干轮，且不出现以 assistant 开头的上下文', () => {
    const st = tempStore();
    try {
      st.sessions.touch('group:1', 'group', 1);
      for (let i = 0; i < 6; i++) {
        st.sessions.append('group:1', 'user', `问题${i}`, 0);
        st.sessions.append('group:1', 'assistant', `回答${i}`, 0);
      }
      const m = new ContextManager(st);
      const msgs = m.build('group:1', { max_turns: 2, token_budget: 3000 }, 'SYS', '新问题');
      // system + 最近 2 轮（4 条）+ 本轮 user
      assert.equal(msgs.length, 6);
      assert.equal(msgs[0]!.role, 'system');
      assert.equal(msgs[1]!.role, 'user', '历史必须从 user 开始');
      assert.equal(msgs[4]!.content, '回答5');
      assert.equal(msgs[5]!.content, '新问题');
    } finally {
      st.close();
    }
  });

  it('预算极小时至少保留最近一条历史', () => {
    const st = tempStore();
    try {
      st.sessions.touch('group:1', 'group', 1);
      st.sessions.append('group:1', 'user', '一条很长很长的历史消息'.repeat(20), 0);
      st.sessions.append('group:1', 'assistant', '一条同样长的回复'.repeat(20), 0);
      const m = new ContextManager(st);
      const msgs = m.build('group:1', { max_turns: 10, token_budget: 200 }, 'SYS', '你好');
      assert.ok(msgs.length >= 2, '不能只剩 system + user');
    } finally {
      st.close();
    }
  });

  it('max_turns 为 0 表示不带历史（面板上的 0 不是"用默认值"）', () => {
    const st = tempStore();
    try {
      st.sessions.touch('group:1', 'group', 1);
      st.sessions.append('group:1', 'user', '旧问题', 0);
      st.sessions.append('group:1', 'assistant', '旧回答', 0);
      const m = new ContextManager(st);
      const msgs = m.build('group:1', { max_turns: 0, token_budget: 3000 }, 'SYS', '新问题');
      assert.deepEqual(
        msgs.map((x) => x.role),
        ['system', 'user'],
        '0 轮就是完全没有历史',
      );
      assert.equal(msgs[1]!.content, '新问题');
    } finally {
      st.close();
    }
  });
});

// ---- 协议解析 ----

describe('OneBot 消息解析', () => {
  it('CQ 码切出 text 与 at 段', () => {
    const segs = parseCQ('你好[CQ:at,qq=123]世界');
    assert.deepEqual(segs, [
      { type: 'text', data: { text: '你好' } },
      { type: 'at', data: { qq: '123' } },
      { type: 'text', data: { text: '世界' } },
    ]);
  });

  it('CQ 转义正确还原', () => {
    const segs = parseCQ('&#91;a&#93; &#44; &amp;');
    assert.deepEqual(segs, [{ type: 'text', data: { text: '[a] , &' } }]);
  });

  it('未闭合的 CQ 码不吞消息', () => {
    const segs = parseCQ('前[CQ:at,qq=1');
    assert.equal(segs.length, 2);
    assert.equal(segs[1]!.data['text'], '[CQ:at,qq=1');
  });

  it('plainText 忽略 at 与图片段', () => {
    const e = ev({
      message: [
        { type: 'at', data: { qq: '10000' } },
        { type: 'text', data: { text: ' 你好 ' } },
        { type: 'image', data: { file: 'a.jpg' } },
      ],
    });
    assert.equal(plainText(e), '你好');
  });

  it('纯 @ 消息的 plainText 为空（不回退到 raw_message）', () => {
    const e = ev({
      message: [{ type: 'at', data: { qq: '10000' } }],
      raw_message: '[CQ:at,qq=10000]',
    });
    assert.equal(plainText(e), '', '回退成 CQ 码会让模型认真回答这串符号');
  });

  it('字符串形式的消息（CQ 码）也能解析', () => {
    const e = ev({ message: '你好[CQ:at,qq=10000]' });
    assert.equal(plainText(e), '你好');
    assert.deepEqual(atTargets(e), [10000]);
    assert.equal(mentions(e, 10000), true);
  });

  it('@全体不算 @ 机器人', () => {
    const e = ev({ message: [{ type: 'at', data: { qq: 'all' } }] });
    assert.deepEqual(atTargets(e), []);
  });
});

// ---- 人格提示 ----

describe('人格提示', () => {
  it('expand 只替换已知变量，未知占位符原样保留', () => {
    const v = { time: 'T', groupName: 'G', nickname: 'N', botName: 'B', qq: 'Q', qqNickname: 'RN' };
    assert.equal(
      expand('{{bot_name}}/{{nickname}}/{{qq_nickname}}/{{qq}}/{{group_name}}/{{time}}/{{unknown}}', v),
      'B/N/RN/Q/G/T/{{unknown}}',
    );
  });

  it('{{nickname}} 与 {{qq_nickname}} 各取各的值', () => {
    // 两个占位符前缀相同：分支顺序写错时短的会先吃掉长的那一段
    const v = emptyVars();
    v.nickname = '名片名';
    v.qqNickname = '真名';
    assert.equal(expand('{{nickname}}|{{qq_nickname}}', v), '名片名|真名');
  });

  it('build 依次拼用户人格、上下文变量、格式约束', () => {
    const out = buildSystem('你是猫娘', {
      time: '2024-01-01 10:00',
      groupName: '测试群',
      nickname: '小明',
      botName: '咪咪',
      qq: '123456789',
      qqNickname: '小明',
    });
    assert.ok(out.startsWith('你是猫娘\n\n上下文：\n'));
    assert.ok(out.includes('- 你的名字：咪咪'));
    assert.ok(out.includes('- 当前群聊：测试群'));
    assert.ok(out.includes('- 对方 QQ：123456789'));
    // 号码紧跟称呼：两行说的是同一个人，隔太远模型容易张冠李戴
    assert.ok(out.indexOf('- 对方称呼') < out.indexOf('- 对方 QQ'));
    // 「被问才说」的约束必须和号码同一行，否则等于给了一条无约束的号码
    assert.match(out, /- 对方 QQ：123456789（[^）]*问[^）]*）/);
    assert.ok(out.includes('输出要求：'));
    assert.ok(out.includes('不要使用 Markdown'));
    // 昵称与称呼相同（没设群名片）时不重复输出
    assert.ok(!out.includes('- 对方昵称'));
  });

  it('群名片与 QQ 昵称不同时两行都给', () => {
    const out = buildSystem('你是助手', {
      time: '',
      groupName: '测试群',
      nickname: '3 号床',
      botName: '咪咪',
      qq: '123456789',
      qqNickname: '陈小明',
    });
    assert.ok(out.includes('- 对方称呼：3 号床'));
    assert.ok(out.includes('- 对方昵称：陈小明'));
    // 顺序：称呼 → 昵称 → 号码，说的是同一个人的三件事
    assert.ok(out.indexOf('- 对方称呼') < out.indexOf('- 对方昵称'));
    assert.ok(out.indexOf('- 对方昵称') < out.indexOf('- 对方 QQ'));
  });

  it('没有变量时不输出空上下文段', () => {
    const out = buildSystem('你是助手', {
      time: '',
      groupName: '',
      nickname: '',
      botName: '',
      qq: '',
      qqNickname: '',
    });
    assert.ok(!out.includes('上下文：'));
    assert.ok(!out.includes('对方 QQ'), '不知道号码时不能留一行空的');
    assert.ok(!out.includes('对方昵称'), '不知道昵称时不能留一行空的');
    assert.ok(out.includes('输出要求：'));
  });
});

// ---- 模型客户端 ----

describe('模型客户端', () => {
  it('endpoint 兼容三种 base_url 写法', () => {
    assert.equal(endpoint('https://api.deepseek.com'), 'https://api.deepseek.com/v1/chat/completions');
    assert.equal(endpoint('https://api.deepseek.com/'), 'https://api.deepseek.com/v1/chat/completions');
    assert.equal(endpoint('https://api.deepseek.com/v1'), 'https://api.deepseek.com/v1/chat/completions');
    assert.equal(
      endpoint('https://x.com/v1/chat/completions'),
      'https://x.com/v1/chat/completions',
    );
  });

  it('estimateTokens 对中文比英文更保守', () => {
    assert.equal(estimateTokens(''), 0);
    assert.equal(estimateTokens('abcd'), 1);
    assert.equal(estimateTokens('你好'), 2);
    assert.ok(estimateTokens('你好世界') > estimateTokens('abcdefgh'));
  });

  it('未配置 Key 时直接报错', async () => {
    const c = new LlmClient();
    await assert.rejects(
      () =>
        c.chat(
          {
            baseURL: 'https://x',
            apiKey: '',
            model: 'm',
            temperature: 1,
            maxTokens: 10,
            thinking: false,
            timeoutMs: 1000,
          },
          [{ role: 'user', content: 'hi' }],
        ),
      /未配置模型 API Key/,
    );
  });
});

describe('模型客户端对接真实 HTTP', () => {
  interface Fake {
    server: Server;
    base: string;
    requests: { body: Record<string, unknown>; auth: string }[];
    close: () => Promise<void>;
  }

  async function fake(handler: (n: number) => { status: number; body: string; sse?: boolean }): Promise<Fake> {
    const requests: { body: Record<string, unknown>; auth: string }[] = [];
    const server = createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => {
        raw += String(c);
      });
      req.on('end', () => {
        requests.push({
          body: JSON.parse(raw) as Record<string, unknown>,
          auth: String(req.headers.authorization ?? ''),
        });
        const r = handler(requests.length);
        if (r.sse) {
          res.writeHead(r.status, { 'Content-Type': 'text/event-stream' });
          res.end(r.body);
          return;
        }
        res.writeHead(r.status, { 'Content-Type': 'application/json' });
        res.end(r.body);
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address() as { port: number };
    return {
      server,
      base: `http://127.0.0.1:${addr.port}`,
      requests,
      close: () =>
        new Promise<void>((r) => {
          server.closeAllConnections();
          server.close(() => r());
        }),
    };
  }

  const cfg = (baseURL: string) => ({
    baseURL,
    apiKey: 'sk-test',
    model: 'deepseek-flash',
    temperature: 0.7,
    maxTokens: 128,
    thinking: false,
    timeoutMs: 5000,
  });

  it('非流式请求：带 thinking=disabled、返回内容与用量', async () => {
    const f = await fake(() => ({
      status: 200,
      body: JSON.stringify({
        choices: [{ message: { content: '你好呀' } }],
        usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
      }),
    }));
    try {
      const c = new LlmClient();
      const r = await c.chat(cfg(f.base), [{ role: 'user', content: 'hi' }]);
      assert.equal(r.content, '你好呀');
      assert.equal(r.usage.prompt_tokens, 10);

      const sent = f.requests[0]!;
      assert.equal(sent.auth, 'Bearer sk-test');
      assert.deepEqual(sent.body.thinking, { type: 'disabled' });
      assert.equal(sent.body.temperature, 0.7);
      assert.equal(sent.body.stream, false);
    } finally {
      await f.close();
    }
  });

  it('思考模式开启时不下发 temperature', async () => {
    const f = await fake(() => ({
      status: 200,
      body: JSON.stringify({ choices: [{ message: { content: 'x' } }] }),
    }));
    try {
      const c = new LlmClient();
      await c.chat({ ...cfg(f.base), thinking: true }, [{ role: 'user', content: 'hi' }]);
      const sent = f.requests[0]!;
      assert.deepEqual(sent.body.thinking, { type: 'enabled' });
      assert.equal(sent.body.temperature, undefined);
    } finally {
      await f.close();
    }
  });

  it('5xx 会重试，4xx 不重试', async () => {
    const f5 = await fake(() => ({ status: 500, body: JSON.stringify({ error: { message: 'boom' } }) }));
    try {
      const c = new LlmClient();
      await assert.rejects(() => c.chat(cfg(f5.base), [{ role: 'user', content: 'hi' }]), /HTTP 500/);
      assert.equal(f5.requests.length, 3, '应重试到 3 次');
    } finally {
      await f5.close();
    }

    const f4 = await fake(() => ({ status: 401, body: JSON.stringify({ error: { message: 'bad key' } }) }));
    try {
      const c = new LlmClient();
      await assert.rejects(() => c.chat(cfg(f4.base), [{ role: 'user', content: 'hi' }]), /bad key/);
      assert.equal(f4.requests.length, 1, '4xx 不该重试');
    } finally {
      await f4.close();
    }
  });

  it('流式请求：拼接 delta、取到 usage、回调逐段触发', async () => {
    const sse = [
      'data: {"choices":[{"delta":{"content":"你"}}]}',
      '',
      'data: {"choices":[{"delta":{"content":"好"}}]}',
      '',
      'data: {"choices":[],"usage":{"prompt_tokens":7,"completion_tokens":2,"total_tokens":9}}',
      '',
      'data: [DONE]',
      '',
    ].join('\n');
    const f = await fake(() => ({ status: 200, body: sse, sse: true }));
    try {
      const c = new LlmClient();
      const deltas: string[] = [];
      const r = await c.chatStream(
        cfg(f.base),
        [{ role: 'user', content: 'hi' }],
        (d) => deltas.push(d),
      );
      assert.equal(r.content, '你好');
      assert.deepEqual(deltas, ['你', '好']);
      assert.equal(r.usage.completion_tokens, 2);
      assert.deepEqual(f.requests[0]!.body.stream_options, { include_usage: true });
    } finally {
      await f.close();
    }
  });

  it('流式返回空内容时报错', async () => {
    const f = await fake(() => ({ status: 200, body: 'data: [DONE]\n\n', sse: true }));
    try {
      const c = new LlmClient();
      await assert.rejects(
        () => c.chatStream(cfg(f.base), [{ role: 'user', content: 'hi' }], () => undefined),
        /模型返回空结果/,
      );
    } finally {
      await f.close();
    }
  });

  it('网关不认 thinking 字段时自动降级重发，之后不再重复探测', async () => {
    const f = await fake((n) =>
      n === 1
        ? {
            status: 400,
            body: JSON.stringify({ error: { message: "Unrecognized request argument: thinking" } }),
          }
        : { status: 200, body: JSON.stringify({ choices: [{ message: { content: '好' } }] }) },
    );
    try {
      const c = new LlmClient();
      const r = await c.chat(cfg(f.base), [{ role: 'user', content: 'hi' }]);
      assert.equal(r.content, '好');
      assert.deepEqual(f.requests[0]!.body.thinking, { type: 'disabled' }, '第一次按默认带');
      assert.equal('thinking' in f.requests[1]!.body, false, '被拒后不再带');

      // 第二个请求不该再撞一次 400
      await c.chat(cfg(f.base), [{ role: 'user', content: 'hi' }]);
      assert.equal(f.requests.length, 3);
      assert.equal('thinking' in f.requests[2]!.body, false);
    } finally {
      await f.close();
    }
  });

  it('200 但响应体里带 error 时，报出真实原因而不是"空结果"', async () => {
    const f = await fake(() => ({
      status: 200,
      body: JSON.stringify({ error: { message: '余额不足', type: 'insufficient_quota' } }),
    }));
    try {
      const c = new LlmClient();
      await assert.rejects(
        () => c.chat(cfg(f.base), [{ role: 'user', content: 'hi' }]),
        /模型返回错误: 余额不足/,
      );
    } finally {
      await f.close();
    }
  });
});
