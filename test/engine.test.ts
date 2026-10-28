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
    groupInfo: async () => '测试群',
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

  const engine = new Engine({
    store,
    log: Logger.create({ level: 'error', format: 'text' }),
    llm,
    searchFetch: opts.searchFetch,
  });
  engine.setSender(sender);
  engine.setSelf(10000, 'bot');

  return { engine, store, sent, cleanup: () => store.close() };
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
