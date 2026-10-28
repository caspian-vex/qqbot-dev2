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
import { contentText, type LlmClient, type Message as LlmMessage, type Result } from '../src/llm/client';
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
  llm?: (msgs: LlmMessage[]) => Promise<Result>;
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
    chat: async (_cfg: unknown, msgs: LlmMessage[]) => {
      if (opts.llm) return opts.llm(msgs);
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
