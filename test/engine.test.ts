// 引擎与设置的接线测试。
//
// 这一层最容易出的问题是"设置存进去了但引擎没读"——面板上改完、
// 保存成功、提示也弹了，行为却一点没变。用户只会觉得"这软件坏了"。
// 所以这里逐条钉住：并发上限、引用回复、分段延迟、跟进里的图标记。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { Engine, type Sender } from '../src/bot';
import { ApprovalQueue } from '../src/bot/computer-approval';
import {
  contentText,
  type LlmClient,
  type Message as LlmMessage,
  type Result,
  type ToolDef,
} from '../src/llm/client';
import { Logger } from '../src/log/logger';
import type { Event, Segment } from '../src/onebot/types';
import { Store } from '../src/store';
import { normalizeOverrides } from '../src/store/overrides';
import type { Settings } from '../src/store/types';

const tmpDirs: string[] = [];
after(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

interface Sent {
  kind: string;
  target: number;
  segs: Segment[];
}

interface Harness {
  engine: Engine;
  store: Store;
  sent: Sent[];
  /** 引擎用的待批准队列。电脑操作用例靠它模拟"面板上点了批准"。 */
  approvals: ApprovalQueue;
  cleanup: () => void;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function textOf(segs: Segment[]): string {
  return segs
    .filter((s) => s.type === 'text')
    .map((s) => String(s.data['text']))
    .join('');
}

function makeHarness(opts: {
  patch?: (v: Settings) => void;
  reply?: string;
  echo?: string;
  /** 第二参数是本次请求带的工具：联网搜索用例靠它断言"带没带 web_search"。 */
  llm?: (msgs: LlmMessage[], tools?: ToolDef[]) => Promise<Result>;
  /** 联网搜索用的 fetch。不传就是真的全局 fetch——用例必须都传。 */
  searchFetch?: typeof fetch;
  /** 取群名。不传就是稳定成功；群名缓存用例靠它模拟"第一次就失败"。 */
  groupInfo?: (groupId: number) => Promise<string>;
} = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-engine-'));
  tmpDirs.push(dir);
  const store = new Store(join(dir, 'qqbot.db'));
  store.settings.update((v) => {
    // 群消息走被动接话：钉成必触发，用例才不依赖随机数
    v.bot.passive_rate = 1;
    v.bot.group_cooldown_sec = 0;
    // 段间延迟归零：这里测的是"读没读设置"，不是真的等 300ms
    v.bot.seg_delay_min_ms = 0;
    v.bot.seg_delay_max_ms = 0;
    opts.patch?.(v);
  });

  const sent: Sent[] = [];
  const sender: Sender = {
    sendGroup: async (id, segs) => {
      sent.push({ kind: 'group', target: id, segs });
      return 1;
    },
    sendPrivate: async (id, segs) => {
      sent.push({ kind: 'private', target: id, segs });
      return 1;
    },
    groupInfo: async (id: number) => (opts.groupInfo ? opts.groupInfo(id) : '测试群'),
  };

  const llm = {
    chat: async (_cfg: unknown, msgs: LlmMessage[], _signal?: AbortSignal, tools?: ToolDef[]) => {
      if (opts.llm) return opts.llm(msgs, tools);
      const last = contentText(msgs[msgs.length - 1]!.content);
      const isEcho = last.includes('内部指令');
      return {
        content: isEcho ? (opts.echo ?? '对了，后来呢？') : (opts.reply ?? '第一句。第二句。'),
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        firstTokenMs: 1,
      };
    },
  } as unknown as LlmClient;

  const approvals = new ApprovalQueue();
  const engine = new Engine({
    store,
    log: Logger.create({ level: 'error', format: 'text' }),
    llm,
    searchFetch: opts.searchFetch,
    // 工作目录就用临时目录：电脑操作真的会在这台机器上落文件，
    // 默认 cwd 指到仓库里会在跑测试时污染工作区。
    dataDir: dir,
    approvals,
  });
  engine.setSender(sender);
  engine.setSelf(10000, 'bot');

  return { engine, store, sent, approvals, cleanup: () => store.close() };
}

function groupEv(patch: Partial<Event> = {}): Event {
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

function privateEv(userId: number, messageId: number): Event {
  return {
    time: 0,
    self_id: 10000,
    post_type: 'message',
    message_type: 'private',
    message_id: messageId,
    user_id: userId,
    group_id: 0,
    message: [{ type: 'text', data: { text: '你好' } }],
    raw: {},
  };
}

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('等待超时');
    await sleep(20);
  }
}

describe('引用回复开关', () => {
  it('默认引用原消息（reply 段在最前面）', async () => {
    const h = makeHarness();
    try {
      h.engine.handleEvent(groupEv());
      await waitFor(() => h.sent.length >= 1);
      assert.equal(h.sent[0]!.segs[0]!.type, 'reply');
      assert.equal(h.sent[0]!.segs[0]!.data['id'], '1');
    } finally {
      h.cleanup();
    }
  });

  it('关掉引用后改成 @ 对方，不再带 reply 段', async () => {
    const h = makeHarness({ patch: (v) => (v.bot.quote_reply = false) });
    try {
      h.engine.handleEvent(groupEv());
      await waitFor(() => h.sent.length >= 1);
      const types = h.sent[0]!.segs.map((s) => s.type);
      assert.deepEqual(types, ['at', 'text', 'text'], '首段应是 @ 而不是 reply');
      assert.equal(h.sent[0]!.segs[0]!.data['qq'], '20000');
    } finally {
      h.cleanup();
    }
  });

  it('私聊永远不带引用/@', async () => {
    const h = makeHarness();
    try {
      h.engine.handleEvent(privateEv(20000, 5));
      await waitFor(() => h.sent.length >= 1);
      assert.deepEqual(
        h.sent[0]!.segs.map((s) => s.type),
        ['text'],
      );
    } finally {
      h.cleanup();
    }
  });
});

describe('跨会话并发上限', () => {
  it('max_concurrent=1 时两个会话不会同时调模型', async () => {
    let running = 0;
    let peak = 0;
    const h = makeHarness({
      patch: (v) => (v.bot.max_concurrent = 1),
      llm: async () => {
        running++;
        peak = Math.max(peak, running);
        await sleep(40);
        running--;
        return {
          content: '好的。',
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          firstTokenMs: 1,
        };
      },
    });
    try {
      h.engine.handleEvent(privateEv(20001, 1));
      h.engine.handleEvent(privateEv(20002, 2));
      await waitFor(() => h.sent.length >= 2);
      assert.equal(peak, 1, '上限是 1，模型调用不该并发');
    } finally {
      h.cleanup();
    }
  });

  it('max_concurrent=3 时两个会话可以并发', async () => {
    let running = 0;
    let peak = 0;
    const h = makeHarness({
      llm: async () => {
        running++;
        peak = Math.max(peak, running);
        await sleep(40);
        running--;
        return {
          content: '好的。',
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          firstTokenMs: 1,
        };
      },
    });
    try {
      h.engine.handleEvent(privateEv(20001, 1));
      h.engine.handleEvent(privateEv(20002, 2));
      await waitFor(() => h.sent.length >= 2);
      assert.equal(peak, 2, '两个不同会话应该并行');
    } finally {
      h.cleanup();
    }
  });
});

describe('图片识别（引擎接线）', () => {
  /** 1×1 PNG：文件头是真的，取图链路能一路走通，不需要网络。 */
  const PNG_B64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

  function imageEv(segs: Segment[]): Event {
    return groupEv({
      message: [
        { type: 'at', data: { qq: '10000' } },
        ...segs,
        { type: 'image', data: { file: `base64://${PNG_B64}` } },
      ],
    });
  }

  const result = (content: string): Result => ({
    content,
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    firstTokenMs: 1,
  });

  it('发图时模型收到 image_url 块，历史里只记张数', async () => {
    let got: LlmMessage[] = [];
    const h = makeHarness({
      llm: async (msgs) => {
        got = msgs;
        return result('这图不错。');
      },
    });
    try {
      h.engine.handleEvent(imageEv([{ type: 'text', data: { text: '这是什么' } }]));
      await waitFor(() => h.sent.length >= 1);

      const last = got[got.length - 1]!;
      assert.equal(last.role, 'user');
      assert.ok(Array.isArray(last.content), '带图时必须升级成内容块数组');
      const parts = last.content as { type: string; text?: string; image_url?: { url: string } }[];
      assert.ok(
        parts.some(
          (p) => p.type === 'image_url' && p.image_url!.url.startsWith('data:image/png;base64,'),
        ),
        '应该有一个 png 的 data URL',
      );
      assert.ok(parts.some((p) => p.type === 'text' && p.text === '这是什么'), '文字要保留');
      assert.ok(
        contentText(got[0]!.content).includes('结合图片内容回应'),
        '带图时系统提示要补上看图约束',
      );

      // 历史里绝不能出现 base64：库会几天涨到 GB
      const userRow = h.store.sessions
        .recent('group:30000', 10)
        .filter((m) => m.role === 'user')
        .pop()!;
      assert.equal(userRow.content, '这是什么（附图 1 张）');
    } finally {
      h.cleanup();
    }
  });

  it('只发图不打字：照样问模型，而不是回「在的，怎么了？」', async () => {
    let last = '';
    const h = makeHarness({
      llm: async (msgs) => {
        last = contentText(msgs[msgs.length - 1]!.content);
        return result('看到一只猫。');
      },
    });
    try {
      h.engine.handleEvent(imageEv([]));
      await waitFor(() => h.sent.length >= 1);
      assert.ok(last.includes('只发了图片'), `应给模型一句说明，实际: ${last}`);
      const text = textOf(h.sent[0]!.segs);
      assert.ok(!text.includes('在的'), '有图就不该走"只 @ 了一下"的兜底');
      assert.ok(text.includes('猫'));
    } finally {
      h.cleanup();
    }
  });

  it('图一张都没加载出来时直说，不装作没看见', async () => {
    const h = makeHarness({ llm: async () => result('不该走到模型') });
    try {
      // 只有图没有文字，且 base64 是空的 → 取不到任何图
      h.engine.handleEvent(
        groupEv({
          message: [
            { type: 'at', data: { qq: '10000' } },
            { type: 'image', data: { file: 'base64://' } },
          ],
        }),
      );
      await waitFor(() => h.sent.length >= 1);
      const text = textOf(h.sent[0]!.segs);
      assert.ok(text.includes('没加载出来'), `应告诉用户图没取到，实际: ${text}`);
    } finally {
      h.cleanup();
    }
  });

  it('关掉开关后退化成纯文字，图片段被忽略', async () => {
    let got: LlmMessage[] = [];
    const h = makeHarness({
      patch: (v) => (v.vision.enabled = false),
      llm: async (msgs) => {
        got = msgs;
        return result('好的。');
      },
    });
    try {
      h.engine.handleEvent(imageEv([{ type: 'text', data: { text: '看图' } }]));
      await waitFor(() => h.sent.length >= 1);
      const last = got[got.length - 1]!;
      assert.equal(last.content, '看图', '关掉后不该出现内容块数组');
      assert.ok(
        !contentText(got[0]!.content).includes('结合图片内容回应'),
        '没带图就不该注入看图约束',
      );
    } finally {
      h.cleanup();
    }
  });
});

describe('跟进里的图标记', () => {
  it('模型在跟进里输出 [图:xx] 时，标记被剥掉而不是发给用户', async () => {
    const h = makeHarness({
      patch: (v) => {
        Object.assign(v.proactive, {
          echo_enabled: true,
          echo_rate: 1,
          echo_min_sec: 0,
          echo_max_sec: 0,
          echo_cooldown_min: 0,
          echo_daily_limit: 10,
        });
      },
      echo: '对了，那个[图:猫.jpg]后来怎么样了？',
    });
    try {
      h.engine.handleEvent(privateEv(20000, 1));
      await waitFor(() => h.sent.length >= 2);

      const echoText = textOf(h.sent[1]!.segs);
      assert.ok(!echoText.includes('[图'), `跟进里不该出现图标记: ${echoText}`);
      assert.ok(echoText.includes('后来怎么样了'), '正文要保留');
    } finally {
      h.cleanup();
    }
  });
});

describe('按会话指定人格', () => {
  const say = (content: string): Result => ({
    content,
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    firstTokenMs: 1,
  });

  it('绑定过人格的会话用自己的提示词，没绑的仍跟随全局', async () => {
    const prompts: string[] = [];
    const h = makeHarness({
      llm: async (msgs) => {
        prompts.push(contentText(msgs[0]!.content));
        return say('好吧。');
      },
    });
    try {
      const tsun = h.store.personas.upsert('tsundere', '你嘴上嫌弃，其实很在意对方，句尾爱带"哼"');
      h.store.personas.bind('private:20001', tsun.id);

      h.engine.handleEvent(privateEv(20001, 1));
      await waitFor(() => h.sent.length >= 1);
      h.engine.handleEvent(privateEv(20002, 2));
      await waitFor(() => h.sent.length >= 2);

      assert.equal(prompts.length, 2);
      assert.ok(prompts[0]!.includes('句尾爱带"哼"'), '绑定的人格要进 system');
      assert.ok(!prompts[0]!.includes('You are a helpful assistant'), '不该再叠默认人格');
      assert.ok(prompts[1]!.includes('You are a helpful assistant'), '没绑定的会话跟随全局');
    } finally {
      h.cleanup();
    }
  });

  it('解绑后立即回到全局人格（不必重启）', async () => {
    const prompts: string[] = [];
    const h = makeHarness({
      llm: async (msgs) => {
        prompts.push(contentText(msgs[0]!.content));
        return say('嗯。');
      },
    });
    try {
      // 用群消息而不是私聊连发：私聊有 3 秒直聊冷却，
      // 这里要验的是"绑定读得新不新"，不是去等冷却。
      const tsun = h.store.personas.upsert('tsundere', '傲娇人格标记');
      h.store.personas.bind('group:30000', tsun.id);

      h.engine.handleEvent(groupEv({ message_id: 1 }));
      await waitFor(() => h.sent.length >= 1);
      assert.ok(prompts[0]!.includes('傲娇人格标记'));

      h.store.personas.bind('group:30000', 0);
      h.engine.handleEvent(groupEv({ message_id: 2 }));
      await waitFor(() => h.sent.length >= 2);
      assert.ok(!prompts[1]!.includes('傲娇人格标记'), '解绑后不该再用原人格');
      assert.ok(prompts[1]!.includes('You are a helpful assistant'));
    } finally {
      h.cleanup();
    }
  });
});

describe('会话列表里的对话对象名字', () => {
  const say = (content: string): Result => ({
    content,
    usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
    firstTokenMs: 1,
  });

  it('群聊记群名（复用算 {{group_name}} 时拉到的结果）', async () => {
    const h = makeHarness({ llm: async () => say('好。') });
    try {
      h.engine.handleEvent(groupEv());
      await waitFor(() => h.sent.length >= 1);
      const row = h.store.sessions.list()[0]!;
      assert.equal(row.id, 'group:30000');
      assert.equal(row.name, '测试群');
    } finally {
      h.cleanup();
    }
  });

  it('私聊记对方昵称；拿不到就留空，不能拿 QQ 号当名字', async () => {
    const h = makeHarness({ llm: async () => say('嗯。') });
    try {
      h.engine.handleEvent({
        ...privateEv(20001, 1),
        sender: { user_id: 20001, nickname: '小王', card: '', role: 'friend' },
      });
      await waitFor(() => h.sent.length >= 1);
      assert.equal(h.store.sessions.list()[0]!.name, '小王');

      // 事件里没有 sender 时（协议端没带），名字要留空而不是写成一串号码，
      // 否则面板会出现「2083882365 / private:2083882365」的重复
      h.engine.handleEvent(privateEv(20002, 2));
      await waitFor(() => h.sent.length >= 2);
      const anon = h.store.sessions.list().find((s) => s.id === 'private:20002')!;
      assert.equal(anon.name, undefined);
    } finally {
      h.cleanup();
    }
  });
});

describe('联网搜索', () => {
  const say = (content: string, extra: Partial<Result> = {}): Result => ({
    content,
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
    firstTokenMs: 1,
    ...extra,
  });

  const callOf = (id: string, query: string) => ({
    id,
    type: 'function',
    function: { name: 'web_search', arguments: JSON.stringify({ query }) },
  });

  /** 假的搜索后端：按 DeepSeek Search API 的形状回结果，并记录被调了几次。 */
  function searchStub(hits: unknown[] = [], status = 200): { fetchImpl: typeof fetch; calls: string[] } {
    const calls: string[] = [];
    const f = (async (url: string) => {
      calls.push(String(url));
      return new Response(JSON.stringify({ results: hits }), { status });
    }) as unknown as typeof fetch;
    return { fetchImpl: f, calls };
  }

  /** 开启搜索的一组设置。搜索复用模型 Key，所以顺手把模型 Key 也配上。 */
  const onSearch = (v: Settings): void => {
    v.llm.api_key = 'sk-test';
    v.search.enabled = true;
    v.search.max_calls = 2;
    v.search.max_results = 3;
  };

  it('模型要查时执行搜索，把结果作为 tool 消息回填后再问一次', async () => {
    const seen: { msgs: LlmMessage[]; tools?: ToolDef[] }[] = [];
    const s = searchStub([{ title: '天气网', url: 'https://w.test/bj', summary: '北京今晚晴，12 度' }]);
    const h = makeHarness({
      patch: onSearch,
      searchFetch: s.fetchImpl,
      llm: async (msgs, tools) => {
        seen.push({ msgs, tools });
        return seen.length === 1 ? say('', { toolCalls: [callOf('call_1', '北京 今晚 天气')] }) : say('北京今晚晴，12 度左右。');
      },
    });
    try {
      h.engine.handleEvent(groupEv());
      await waitFor(() => h.sent.length >= 1);

      assert.equal(textOf(h.sent[0]!.segs), '北京今晚晴，12 度左右。');
      assert.equal(s.calls.length, 1, '应该只搜一次');
      assert.equal(seen.length, 2, '搜完必须再问一次模型');

      // 第一轮把工具递了过去
      assert.equal(seen[0]!.tools?.[0]?.function.name, 'web_search');

      // 第二轮要带上 assistant(tool_calls) 与配对的 tool 结果，否则端点会 400
      const second = seen[1]!.msgs;
      const toolMsg = second.find((m) => m.role === 'tool');
      assert.ok(toolMsg, '必须有 role=tool 的消息');
      assert.equal(toolMsg!.tool_call_id, 'call_1');
      assert.ok(contentText(toolMsg!.content).includes('天气网'), '工具结果里要有搜到的标题');
      const asstMsg = second.find((m) => m.role === 'assistant');
      assert.equal(asstMsg!.tool_calls?.[0]!.id, 'call_1');

      // 历史只留用户原话与最终答复，搜索结果不进库（否则每轮都被重新计费）
      const rows = h.store.sessions.recent('group:30000', 10);
      assert.equal(rows.length, 2);
      assert.equal(rows[1]!.content, '北京今晚晴，12 度左右。');
      assert.ok(!rows.some((r) => r.content.includes('天气网')));
    } finally {
      h.cleanup();
    }
  });

  it('开关关着时不带 tools、也不碰搜索源', async () => {
    const tools: (ToolDef[] | undefined)[] = [];
    const s = searchStub();
    const h = makeHarness({
      searchFetch: s.fetchImpl,
      llm: async (_msgs, t) => {
        tools.push(t);
        return say('在的。');
      },
    });
    try {
      h.engine.handleEvent(groupEv());
      await waitFor(() => h.sent.length >= 1);
      assert.equal(tools.length, 1);
      assert.equal(tools[0], undefined, '关着就不该带 tools 字段');
      assert.equal(s.calls.length, 0);
    } finally {
      h.cleanup();
    }
  });

  it('搜索源报错时把失败原话交给模型，回复照发', async () => {
    const s = searchStub([], 500);
    let sawFailure = false;
    const h = makeHarness({
      patch: onSearch,
      searchFetch: s.fetchImpl,
      llm: async (msgs) => {
        const tool = msgs.find((m) => m.role === 'tool');
        if (!tool) return say('', { toolCalls: [callOf('c1', 'q')] });
        sawFailure = contentText(tool.content).includes('搜索失败');
        return say('查不到，可能网不好。');
      },
    });
    try {
      h.engine.handleEvent(groupEv());
      await waitFor(() => h.sent.length >= 1);
      assert.equal(textOf(h.sent[0]!.segs), '查不到，可能网不好。');
      assert.ok(sawFailure, '工具结果里要说清楚是搜索失败，别让模型当成"没结果"');
    } finally {
      h.cleanup();
    }
  });

  it('端点不认 tools 时降级成普通对话，用户照样收到回复', async () => {
    const tools: (ToolDef[] | undefined)[] = [];
    let n = 0;
    const h = makeHarness({
      patch: onSearch,
      searchFetch: searchStub().fetchImpl,
      llm: async (_msgs, t) => {
        tools.push(t);
        n++;
        if (n === 1) throw new Error('模型返回 HTTP 400: {"error":{"message":"tools is not supported"}}');
        return say('好吧，我不查了。');
      },
    });
    try {
      h.engine.handleEvent(groupEv());
      await waitFor(() => h.sent.length >= 1);
      assert.equal(textOf(h.sent[0]!.segs), '好吧，我不查了。');
      assert.equal(tools.length, 2);
      assert.equal(tools[0]!.length, 1, '第一次带工具');
      assert.equal(tools[1], undefined, '降级后不再带工具');
    } finally {
      h.cleanup();
    }
  });

  it('一次要查两条但额度只剩一条时，多出来的明确拒绝而不是偷偷多花钱', async () => {
    const s = searchStub([{ title: 'a', url: 'https://a.test', summary: 'c' }]);
    const seen: LlmMessage[][] = [];
    const h = makeHarness({
      patch: (v) => {
        onSearch(v);
        v.search.max_calls = 1;
      },
      searchFetch: s.fetchImpl,
      llm: async (msgs) => {
        seen.push(msgs);
        if (msgs.some((m) => m.role === 'tool')) return say('好。');
        return say('', { toolCalls: [callOf('c1', 'q1'), callOf('c2', 'q2')] });
      },
    });
    try {
      h.engine.handleEvent(groupEv());
      await waitFor(() => h.sent.length >= 1);

      assert.equal(s.calls.length, 1, '额度是 1 就只能发一次搜索请求');
      const toolMsgs = seen[1]!.filter((m) => m.role === 'tool');
      assert.equal(toolMsgs.length, 2, '每个 tool_call_id 都必须有回复，漏一个就 400');
      assert.ok(toolMsgs.some((m) => contentText(m.content).includes('搜索次数已用完')));
    } finally {
      h.cleanup();
    }
  });

  it('模型只提工具不查（额度已尽）时，不再给工具也不算失败', async () => {
    let n = 0;
    const tools: (ToolDef[] | undefined)[] = [];
    const h = makeHarness({
      patch: (v) => {
        onSearch(v);
        v.search.max_calls = 1;
      },
      searchFetch: searchStub([{ title: 'a', url: 'https://a.test', summary: 'c' }]).fetchImpl,
      llm: async (_msgs, t) => {
        tools.push(t);
        n++;
        return n === 1 ? say('', { toolCalls: [callOf('c1', 'q1')] }) : say('就这些。');
      },
    });
    try {
      h.engine.handleEvent(groupEv());
      await waitFor(() => h.sent.length >= 1);
      assert.equal(textOf(h.sent[0]!.segs), '就这些。');
      assert.equal(tools[1], undefined, '额度用完后这一轮不再带工具');
    } finally {
      h.cleanup();
    }
  });
});

describe('按会话的设置覆盖', () => {
  /**
   * 给某个会话写一份覆盖。
   *
   * 走 normalizeOverrides 而不是手搓对象：面板 PUT 之后库里就是这个形状，
   * 用例要是自己拼一个"更完整"的对象，测的就不是线上那条路径了。
   */
  function setOv(h: Harness, sid: string, ov: Record<string, unknown>): void {
    h.store.sessionSettings.set(sid, normalizeOverrides(ov, h.store.settings.get()), {
      kind: sid.startsWith('group:') ? 'group' : 'private',
    });
  }

  /** 群事件：文本可自定义，群号可换。 */
  function g(groupId: number, text = '你好', userId = 20000, messageId = 1): Event {
    return groupEv({ group_id: groupId, message: [{ type: 'text', data: { text } }], user_id: userId, message_id: messageId });
  }

  it('唤醒词按会话：群 1 认、群 2 不认', async () => {
    // 关掉被动接话，测的就只剩唤醒词这一条路径
    const h = makeHarness({ patch: (v) => { v.bot.passive_rate = 0; } });
    try {
      setOv(h, 'group:30001', { bot: { wake_words: ['小助手'] } });

      h.engine.handleEvent(g(30001, '小助手 在吗'));
      await waitFor(() => h.sent.length >= 1);
      assert.equal(h.sent.length, 1, '群 1 配了唤醒词，应该回');
      assert.equal(h.sent[0]!.target, 30001);

      h.engine.handleEvent(g(30002, '小助手 在吗', 20000, 2));
      await sleep(120);
      assert.equal(h.sent.length, 1, '群 2 没配唤醒词，不应回');
      assert.equal(h.engine.stats().ignored, 1);
    } finally {
      h.cleanup();
    }
  });

  it('接话概率按会话：全局开、群 1 关', async () => {
    const h = makeHarness(); // 全局 passive_rate = 1
    try {
      setOv(h, 'group:30001', { bot: { passive_rate: 0 } });

      h.engine.handleEvent(g(30001, '随便聊聊'));
      await sleep(150);
      assert.equal(h.sent.length, 0, '群 1 覆盖成 0，不该接话');

      h.engine.handleEvent(g(30002, '随便聊聊', 20000, 2));
      await waitFor(() => h.sent.length >= 1);
      assert.equal(h.sent[0]!.target, 30002, '群 2 跟全局，应该接话');
    } finally {
      h.cleanup();
    }
  });

  it('全局黑名单不能被会话覆盖放宽', async () => {
    const h = makeHarness({ patch: (v) => { v.bot.blacklist_users = [20000]; } });
    try {
      // 会话里写空数组，试图"解禁"
      setOv(h, 'group:30001', { bot: { blacklist_users: [] } });

      h.engine.handleEvent(g(30001, '@bot 你好'));
      await sleep(150);
      assert.equal(h.sent.length, 0, '全局拉黑的人在任何会话都不该被回复');
    } finally {
      h.cleanup();
    }
  });

  it('会话可以追加自己的黑名单', async () => {
    const h = makeHarness();
    try {
      setOv(h, 'group:30001', { bot: { blacklist_users: [20000] } });

      h.engine.handleEvent(g(30001, '你好', 20000, 1));
      await sleep(150);
      assert.equal(h.sent.length, 0, '本群拉黑的人不回复');

      h.engine.handleEvent(g(30001, '你好', 20001, 2));
      await waitFor(() => h.sent.length >= 1);
      assert.equal(h.sent.length, 1, '同群其他人照常');
    } finally {
      h.cleanup();
    }
  });

  it('上下文轮数按会话：覆盖成 0 就不带历史', async () => {
    const seen: LlmMessage[][] = [];
    const h = makeHarness({
      llm: async (msgs) => {
        seen.push(msgs);
        return { content: '嗯。', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }, firstTokenMs: 1 };
      },
    });
    try {
      // 两个群都先攒两条历史（messages 对 sessions 有外键，行要先建出来）
      for (const [sid, id] of [['group:30001', 30001], ['group:30002', 30002]] as const) {
        h.store.sessions.touch(sid, 'group', id, '群');
        h.store.sessions.append(sid, 'user', '昨天的旧问题', 10);
        h.store.sessions.append(sid, 'assistant', '昨天的旧回答', 10);
      }

      setOv(h, 'group:30001', { context: { max_turns: 0 } });

      h.engine.handleEvent(g(30001, '今天呢', 20000, 1));
      await waitFor(() => h.sent.length >= 1);
      // system + 本轮用户，历史被整段丢掉
      assert.equal(seen[0]!.length, 2, '覆盖成 0 轮时只带 system + 本轮');

      h.engine.handleEvent(g(30002, '今天呢', 20000, 2));
      await waitFor(() => h.sent.length >= 2);
      assert.ok(seen[1]!.length >= 4, '没覆盖的群应带上历史');
    } finally {
      h.cleanup();
    }
  });

  it('联网搜索按会话：群 1 关掉后不再带工具', async () => {
    const tools: (ToolDef[] | undefined)[] = [];
    const h = makeHarness({
      patch: (v) => {
        v.search.enabled = true;
        v.llm.api_key = 'sk-test';
      },
      searchFetch: (async () => new Response('{"results":[]}')) as unknown as typeof fetch,
      llm: async (_msgs, t) => {
        tools.push(t);
        return { content: '好。', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }, firstTokenMs: 1 };
      },
    });
    try {
      setOv(h, 'group:30001', { search: { enabled: false } });

      h.engine.handleEvent(g(30001, '今天有什么新闻', 20000, 1));
      await waitFor(() => h.sent.length >= 1);
      assert.equal(tools[0], undefined, '群 1 关掉搜索，请求里不该带 tools');

      h.engine.handleEvent(g(30002, '今天有什么新闻', 20000, 2));
      await waitFor(() => h.sent.length >= 2);
      assert.ok(Array.isArray(tools[1]) && tools[1]!.length === 1, '群 2 跟全局，应带 web_search');
    } finally {
      h.cleanup();
    }
  });

  it('改完全局设置，已覆盖的会话不受影响', async () => {
    const h = makeHarness({ patch: (v) => { v.bot.passive_rate = 0; } });
    try {
      setOv(h, 'group:30001', { bot: { passive_rate: 1 } });

      h.engine.handleEvent(g(30001, '你好', 20000, 1));
      await waitFor(() => h.sent.length >= 1);
      assert.equal(h.sent.length, 1, '覆盖成 1，应接话');

      // 面板上把全局调回 0.5：已覆盖的会话必须还是 1（否则"独立"就是假的）
      h.store.settings.update((v) => { v.bot.passive_rate = 0.5; });
      h.engine.handleEvent(g(30001, '再聊一句', 20000, 2));
      await waitFor(() => h.sent.length >= 2);
      assert.equal(h.sent.length, 2, '全局变了，覆盖值不应被带走');

      // 没覆盖的群跟着全局的 0.5 —— 这条会随机，所以只断言"不是必定回复"，
      // 用同一个 rand 源没法注入，改成把全局改成 0 更确定
      h.store.settings.update((v) => { v.bot.passive_rate = 0; });
      h.engine.handleEvent(g(30002, '你好', 20000, 3));
      await sleep(150);
      assert.equal(h.sent.length, 2, '没覆盖的群跟随全局的 0');
    } finally {
      h.cleanup();
    }
  });

  it('覆盖只影响自己那个会话：同一个号码换个 kind 互不干扰', async () => {
    const seen: LlmMessage[][] = [];
    const h = makeHarness({
      llm: async (msgs) => {
        seen.push(msgs);
        return { content: '嗯。', usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 }, firstTokenMs: 1 };
      },
    });
    try {
      // 群 30001 与私聊 30001 是两条完全不同的会话，只是号码撞了
      for (const [sid, kind] of [['group:30001', 'group'], ['private:30001', 'private']] as const) {
        h.store.sessions.touch(sid, kind, 30001, '同名');
        h.store.sessions.append(sid, 'user', '旧问题', 10);
        h.store.sessions.append(sid, 'assistant', '旧回答', 10);
      }
      // 只给私聊关掉历史
      setOv(h, 'private:30001', { context: { max_turns: 0 } });

      h.engine.handleEvent(privateEv(30001, 1));
      await waitFor(() => h.sent.length >= 1);
      assert.equal(seen[0]!.length, 2, '私聊按覆盖走：不带历史');

      h.engine.handleEvent(g(30001, '你好', 20000, 2));
      await waitFor(() => h.sent.length >= 2);
      assert.ok(seen[1]!.length >= 4, '群同号不应沾到私聊的覆盖');
    } finally {
      h.cleanup();
    }
  });
});

describe('电脑操作', () => {
  const OWNER = 20000;
  const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };

  /** 打开电脑操作，主人是 OWNER，每次执行要批准。 */
  function cmp(opts: {
    patch?: (v: Settings) => void;
    llm?: (msgs: LlmMessage[], tools?: ToolDef[]) => Promise<Result>;
  }): Harness {
    return makeHarness({
      patch: (v) => {
        v.computer.enabled = true;
        v.computer.owner_qq = OWNER;
        v.computer.require_approval = true;
        v.computer.timeout_sec = 10;
        v.computer.max_calls = 1;
        opts.patch?.(v);
      },
      llm: opts.llm,
    });
  }

  function call(id: string, name: string, args: unknown) {
    return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
  }

  /** 发一条消息，sender 带上 role（私聊为空串，群聊按用例要给 owner/admin/member）。 */
  function say(h: Harness, ev: Event): void {
    h.engine.handleEvent({ ...ev, sender: { user_id: ev.user_id ?? 0, nickname: 'n', card: '', role: '' } });
  }

  /** 写一份会话覆盖，走 normalizeOverrides（与面板 PUT 之后库里形状一致）。 */
  function setOv(h: Harness, sid: string, ov: Record<string, unknown>): void {
    h.store.sessionSettings.set(sid, normalizeOverrides(ov, h.store.settings.get()), {
      kind: sid.startsWith('group:') ? 'group' : 'private',
    });
  }

  it('主人私聊：电脑操作工具 + 定时消息一起下发，system 里带工作目录', async () => {
    const seen: { msgs: LlmMessage[]; tools?: ToolDef[] }[] = [];
    const h = cmp({
      llm: async (msgs, tools) => {
        seen.push({ msgs, tools });
        return { content: '好的。', usage, firstTokenMs: 1 };
      },
    });
    try {
      say(h, privateEv(OWNER, 1));
      await waitFor(() => h.sent.length === 1);

      const first = seen[0]!;
      const names = (first.tools ?? []).map((t) => t.function.name).sort();
      // schedule_message 与电脑操作共用同一道权限：能在这台机器上动手的人，
      // 才配让这个号替自己到点说话。所以它出现在这里而不是另一套白名单里。
      assert.deepEqual(names, [
        'list_dir',
        'read_file',
        'run_command',
        'schedule_message',
        'write_file',
      ]);
      assert.match(contentText(first.msgs[0]!.content), /默认工作目录/);
      assert.match(contentText(first.msgs[0]!.content), /schedule_message/);
    } finally {
      h.cleanup();
    }
  });

  it('不在白名单的人：不下发工具，也不注入说明', async () => {
    const seen: { msgs: LlmMessage[]; tools?: ToolDef[] }[] = [];
    const h = cmp({
      llm: async (msgs, tools) => {
        seen.push({ msgs, tools });
        return { content: '好的。', usage, firstTokenMs: 1 };
      },
    });
    try {
      say(h, privateEv(99999, 1));
      await waitFor(() => h.sent.length === 1);
      assert.equal(seen[0]!.tools, undefined, '没有权限就不该带 tools 字段');
      assert.doesNotMatch(contentText(seen[0]!.msgs[0]!.content), /默认工作目录/);
    } finally {
      h.cleanup();
    }
  });

  it('白名单群：群主/管理员能用，普通成员不能用', async () => {
    for (const role of ['owner', 'admin', 'member']) {
      const seen: { tools?: ToolDef[] }[] = [];
      const h = cmp({
        patch: (v) => {
          v.computer.allow_groups = [30000];
        },
        llm: async (_msgs, tools) => {
          seen.push({ tools });
          return { content: '好的。', usage, firstTokenMs: 1 };
        },
      });
      try {
        h.engine.handleEvent({ ...groupEv(), sender: { user_id: 20000, nickname: 'n', card: '', role } });
        await waitFor(() => h.sent.length === 1);
        const has = (seen[0]!.tools ?? []).some((t) => t.function.name === 'run_command');
        assert.equal(has, role !== 'member', `${role} 的判定不对`);
      } finally {
        h.cleanup();
      }
    }
  });

  it('批准之后才执行，结果回灌给模型', async () => {
    const seen: LlmMessage[][] = [];
    const h = cmp({
      llm: async (msgs, tools) => {
        seen.push(msgs);
        if (msgs.some((m) => m.role === 'tool')) return { content: '磁盘还剩 8G。', usage, firstTokenMs: 1 };
        if ((tools ?? []).some((t) => t.function.name === 'run_command')) {
          return { content: '', usage, firstTokenMs: 1, toolCalls: [call('c1', 'run_command', { command: 'echo hi' })] };
        }
        return { content: '没有工具可用。', usage, firstTokenMs: 1 };
      },
    });
    try {
      say(h, privateEv(OWNER, 1));
      await waitFor(() => h.approvals.list().length === 1);
      h.approvals.decide(h.approvals.list()[0]!.id, true);
      await waitFor(() => h.sent.length === 1);

      assert.match(textOf(h.sent[0]!.segs), /磁盘还剩 8G/);
      const toolMsg = seen[1]!.find((m) => m.role === 'tool');
      assert.ok(toolMsg, '第二轮应该带一条工具结果');
      assert.match(contentText(toolMsg.content), /退出码 0/);
      assert.match(contentText(toolMsg.content), /hi/);
    } finally {
      h.cleanup();
    }
  });

  it('拒绝之后不执行，回灌一句"没批准"', async () => {
    const seen: LlmMessage[][] = [];
    const h = cmp({
      llm: async (msgs, tools) => {
        seen.push(msgs);
        if (msgs.some((m) => m.role === 'tool')) return { content: '那先不看了。', usage, firstTokenMs: 1 };
        if ((tools ?? []).some((t) => t.function.name === 'run_command')) {
          return { content: '', usage, firstTokenMs: 1, toolCalls: [call('c1', 'run_command', { command: 'echo hi' })] };
        }
        return { content: '没有工具可用。', usage, firstTokenMs: 1 };
      },
    });
    try {
      say(h, privateEv(OWNER, 1));
      await waitFor(() => h.approvals.list().length === 1);
      h.approvals.decide(h.approvals.list()[0]!.id, false);
      await waitFor(() => h.sent.length === 1);

      const toolMsg = seen[1]!.find((m) => m.role === 'tool');
      assert.match(contentText(toolMsg!.content), /没有得到批准/);
    } finally {
      h.cleanup();
    }
  });

  it('同一次要调两个：第二个回"次数已用完"，不会静默丢掉 tool_call_id', async () => {
    const seen: LlmMessage[][] = [];
    const h = cmp({
      llm: async (msgs, tools) => {
        seen.push(msgs);
        const tools2 = msgs.filter((m) => m.role === 'tool');
        if (tools2.length > 0) return { content: '好。', usage, firstTokenMs: 1 };
        if ((tools ?? []).some((t) => t.function.name === 'run_command')) {
          return {
            content: '',
            usage,
            firstTokenMs: 1,
            toolCalls: [call('c1', 'run_command', { command: 'echo a' }), call('c2', 'run_command', { command: 'echo b' })],
          };
        }
        return { content: '没有工具可用。', usage, firstTokenMs: 1 };
      },
    });
    try {
      say(h, privateEv(OWNER, 1));
      await waitFor(() => h.approvals.list().length === 1);
      h.approvals.decide(h.approvals.list()[0]!.id, true);
      await waitFor(() => h.sent.length === 1);

      const results = seen[1]!.filter((m) => m.role === 'tool');
      assert.equal(results.length, 2, '两个 call 都必须有回执，少一个下一轮就是 400');
      assert.match(contentText(results[0]!.content), /退出码 0/);
      assert.match(contentText(results[1]!.content), /次数已用完/);
    } finally {
      h.cleanup();
    }
  });

  it('危险命令连批准都不进', async () => {
    const seen: LlmMessage[][] = [];
    const h = cmp({
      llm: async (msgs, tools) => {
        seen.push(msgs);
        if (msgs.some((m) => m.role === 'tool')) return { content: '这个不能做。', usage, firstTokenMs: 1 };
        if ((tools ?? []).some((t) => t.function.name === 'run_command')) {
          return { content: '', usage, firstTokenMs: 1, toolCalls: [call('c1', 'run_command', { command: 'rm -rf /' })] };
        }
        return { content: '没有工具可用。', usage, firstTokenMs: 1 };
      },
    });
    try {
      say(h, privateEv(OWNER, 1));
      await waitFor(() => h.sent.length === 1);

      const toolMsg = seen[1]!.find((m) => m.role === 'tool');
      assert.match(contentText(toolMsg!.content), /硬性拒绝/);
      assert.equal(h.approvals.list().length, 0, '硬拒的命令不该在面板上留待批准');
    } finally {
      h.cleanup();
    }
  });

  it('会话里关掉电脑操作：这个会话就不带工具了', async () => {
    const seen: { tools?: ToolDef[] }[] = [];
    const h = cmp({
      llm: async (_msgs, tools) => {
        seen.push({ tools });
        return { content: '好的。', usage, firstTokenMs: 1 };
      },
    });
    try {
      setOv(h, `private:${OWNER}`, { computer: { enabled: false } });
      say(h, privateEv(OWNER, 1));
      await waitFor(() => h.sent.length === 1);
      assert.equal(seen[0]!.tools, undefined);
    } finally {
      h.cleanup();
    }
  });
});

describe('群名缓存', () => {
  it('取群名失败不会永久缓存空名，过一阵会重新取', async (t) => {
    // 老实现把失败结果（空串）永久写进缓存：协议端启动慢一点，
    // 这个群在整个进程生命周期里就再也没名字了，且没有任何痕迹。
    t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
    // Date 被冻住了，waitFor 的"超时判断"会永远为假——回归时不是失败而是挂死。
    // 所以这里按"轮询次数"等，与时钟无关。
    const waitTicks = async (cond: () => boolean, tries = 300): Promise<void> => {
      for (let i = 0; i < tries; i++) {
        if (cond()) return;
        await sleep(10);
      }
      throw new Error('等待超时');
    };
    let calls = 0;
    const prompts: string[] = [];
    const h = makeHarness({
      groupInfo: async () => {
        calls++;
        if (calls === 1) throw new Error('协议端未就绪');
        return '测试群';
      },
      llm: async (msgs) => {
        prompts.push(contentText(msgs[0]!.content));
        return {
          content: '好的。',
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          firstTokenMs: 1,
        };
      },
    });
    try {
      h.engine.handleEvent(groupEv({ message_id: 1 }));
      await waitTicks(() => h.sent.length >= 1);
      assert.equal(calls, 1);
      assert.ok(!prompts[0]!.includes('当前群聊'), '第一次没取到，不该有群名');

      // 越过失败缓存的重试间隔（60 秒）
      t.mock.timers.tick(61_000);

      h.engine.handleEvent(groupEv({ message_id: 2 }));
      await waitTicks(() => h.sent.length >= 2);
      assert.equal(calls, 2, '过了重试间隔要再问一次');
      assert.ok(prompts[1]!.includes('当前群聊：测试群'), '第二次应带上群名');
    } finally {
      h.cleanup();
    }
  });
});

describe('机器人总开关', () => {
  it('关掉后群里的消息一律不回复，只记一次忽略', async () => {
    const h = makeHarness({
      patch: (v) => {
        v.bot.enabled = false;
      },
    });
    try {
      h.engine.handleEvent(groupEv());
      await sleep(250);
      assert.equal(h.sent.length, 0, '暂停时不能说话');
      assert.equal(h.engine.stats().ignored, 1);
      assert.equal(h.engine.stats().replied, 0);
    } finally {
      h.cleanup();
    }
  });

  it('暂停期间不消耗冷却，恢复后第一条私聊立刻能回', async () => {
    // 开关判断如果在 decide 之后，暂停时照样会调 cool.allow 把时间戳打上，
    // 恢复后 3 秒内的第一条会被这笔"幽灵冷却"吃掉——用户看到的是"开了但第一条不理我"。
    const h = makeHarness();
    try {
      h.store.settings.update((v) => {
        v.bot.enabled = false;
      });
      h.engine.handleEvent(privateEv(20001, 1));
      await sleep(150);
      assert.equal(h.sent.length, 0, '暂停时不能回');

      h.store.settings.update((v) => {
        v.bot.enabled = true;
      });
      h.engine.handleEvent(privateEv(20001, 2));
      await waitFor(() => h.sent.length >= 1, 2000);
      assert.equal(h.sent.length, 1, '恢复后第一条应该立刻回，不该被暂停期间的冷却挡住');
    } finally {
      h.cleanup();
    }
  });

  it('暂停时 tick 不发到点的定时消息，恢复后照常发', async () => {
    const h = makeHarness();
    try {
      const id = h.store.scheduled.add({
        session_id: 'group:30000',
        kind: 'group',
        target_id: 30000,
        body: '该开会了',
        due_at: Math.floor(Date.now() / 1000) + 1,
      });
      assert.ok(id > 0);

      h.store.settings.update((v) => {
        v.bot.enabled = false;
      });
      await h.engine.tick(Date.now() + 5000);
      await sleep(120);
      assert.equal(h.sent.length, 0, '暂停时定时消息不该发');
      assert.equal(h.store.scheduled.countPending(), 1, '也不能被当成已发掉');

      h.store.settings.update((v) => {
        v.bot.enabled = true;
      });
      await h.engine.tick(Date.now() + 5000);
      await waitFor(() => h.sent.length >= 1, 2000);
      assert.equal(h.sent.length, 1, '恢复后到点的消息照常发');
    } finally {
      h.cleanup();
    }
  });
});
