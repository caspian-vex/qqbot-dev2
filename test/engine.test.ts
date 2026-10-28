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
import type { LlmClient, Result } from '../src/llm/client';
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
  llm?: (msgs: { role: string; content: string }[]) => Promise<Result>;
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
    chat: async (_cfg: unknown, msgs: { role: string; content: string }[]) => {
      if (opts.llm) return opts.llm(msgs);
      const last = msgs[msgs.length - 1]!.content;
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
