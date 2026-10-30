// 摘要器：什么时候跑、跑成什么样、失败之后怎么办。
//
// 这一层最容易出的问题全在"失败路径"上：水位线该不该推进、要不要重试、
// 会不会重复写。所以除了成功路径，下面每个用例都在钉一个"出错时不该发生的副作用"。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { Digester, DIGEST_MIN_MSGS } from '../src/memory/digest';
import type { LlmClient, Message as LlmMessage, Result } from '../src/llm/client';
import { Logger } from '../src/log/logger';
import { Store } from '../src/store';
import { defaultSettings, type Settings } from '../src/store/types';
import { localDay } from '../src/util/time';

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

interface Harness {
  store: Store;
  digester: Digester;
  settings: Settings;
  /** 每次请求的 messages，用例据此断言"发了几次、带了什么"。 */
  calls: LlmMessage[][];
  cleanup: () => void;
}

const GOOD = JSON.stringify({
  summary: '今天主要在聊加班，说想换个工作但暂时没定。',
  memories: [
    { scope: 'user', owner_qq: 20001, kind: 'preference', content: '讨厌加班到深夜', score: 4 },
    { scope: 'session', owner_qq: 0, kind: 'fact', content: '群里约定周末去图书馆', score: 3 },
  ],
});

function make(opts: {
  messages?: number;
  reply?: (n: number) => string | Error;
  patch?: (v: Settings) => void;
} = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-digest-'));
  dirs.push(dir);
  const store = new Store(join(dir, 'qqbot.db'));
  const settings = defaultSettings();
  settings.llm.api_key = 'sk-test';
  settings.llm.model = 'test-model';
  settings.memory.enabled = true;
  opts.patch?.(settings);
  store.settings.save(settings);
  store.sessions.touch('group:30000', 'group', 30000, '测试群');

  const n = opts.messages ?? 10;
  for (let i = 0; i < n; i++) {
    store.sessions.append(
      'group:30000',
      i % 2 === 0 ? 'user' : 'assistant',
      `第 ${i} 条消息`,
      1,
      { id: 20001, name: '阿伟' },
    );
  }

  const calls: LlmMessage[][] = [];
  const llm = {
    chat: async (_cfg: unknown, msgs: LlmMessage[]): Promise<Result> => {
      calls.push(msgs);
      const out = opts.reply ? opts.reply(calls.length) : GOOD;
      if (out instanceof Error) throw out;
      return {
        content: out,
        usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
        firstTokenMs: 1,
      };
    },
  } as unknown as LlmClient;

  const digester = new Digester({
    store,
    llm,
    log: Logger.create({ level: 'error', format: 'text' }),
  });
  return { store, digester, settings, calls, cleanup: () => store.close() };
}

describe('该不该跑', () => {
  it('凑不够最少条数就不调模型，也不推进水位线', async () => {
    const h = make({ messages: DIGEST_MIN_MSGS - 1 });
    try {
      const out = await h.digester.digestNow('group:30000', h.settings);
      assert.equal(out.ok, true);
      assert.equal(out.added, 0);
      assert.equal(h.calls.length, 0, '两句话不值当调一次模型');
      assert.equal(h.store.memory.cursor('group:30000').last_msg_id, 0, '这几条要留给下次一起压');
    } finally {
      h.cleanup();
    }
  });

  it('没配 API Key 时连请求都不发', async () => {
    const h = make({ patch: (v) => (v.llm.api_key = '') });
    try {
      const out = await h.digester.digestNow('group:30000', h.settings);
      assert.equal(out.ok, false);
      assert.equal(out.reason, 'no_key');
      assert.equal(h.calls.length, 0);
    } finally {
      h.cleanup();
    }
  });
});

describe('成功路径', () => {
  it('写入概述与事实，并推进水位线', async () => {
    const h = make();
    try {
      const out = await h.digester.digestNow('group:30000', h.settings);
      assert.equal(out.ok, true);
      assert.equal(out.added, 2);

      const days = h.store.memory.listDays({ limit: 10 });
      assert.equal(days.total, 1);
      assert.match(days.items[0]?.content ?? '', /加班/);
      assert.equal(days.items[0]?.msg_count, 10);

      const facts = h.store.memory.list({ limit: 10 });
      assert.equal(facts.total, 2);
      assert.ok(facts.items.some((m) => m.scope === 'user' && m.owner_id === '20001'));
      assert.ok(facts.items.some((m) => m.scope === 'session' && m.owner_id === 'group:30000'));

      assert.ok(h.store.memory.cursor('group:30000').last_msg_id > 0);
      assert.equal(h.store.memory.pending('group:30000'), 0);
    } finally {
      h.cleanup();
    }
  });

  it('再跑一次不重复写、也不再发请求', async () => {
    const h = make();
    try {
      await h.digester.digestNow('group:30000', h.settings);
      const before = h.calls.length;
      const out = await h.digester.digestNow('group:30000', h.settings);
      assert.equal(out.ok, true);
      assert.equal(h.calls.length, before, '水位线之后的条数不足，不该再请求');
      assert.equal(h.store.memory.listDays({ limit: 10 }).total, 1);
      assert.equal(h.store.memory.list({ limit: 10 }).total, 2);
    } finally {
      h.cleanup();
    }
  });

  it('摘要花掉的 token 也记进用量', async () => {
    const h = make();
    try {
      await h.digester.digestNow('group:30000', h.settings);
      const usage = h.store.usage.recent(1)[0];
      assert.ok(usage, '用量表该有一行');
      assert.ok(usage.requests >= 1, '摘要也是真金白银，不记就对不上账');
    } finally {
      h.cleanup();
    }
  });

  it('超过一批时分段摘要再合并，最终只留一条概述', async () => {
    const h = make({ messages: 130 });
    try {
      const out = await h.digester.digestNow('group:30000', h.settings);
      assert.equal(out.ok, true);
      // 120 条 / 每批 60 = 2 批摘要 + 1 次合并
      assert.equal(h.calls.length, 3, '两批摘要加一次合并');
      assert.equal(h.store.memory.listDays({ limit: 10 }).total, 1, '一天多批只留一条概述');
    } finally {
      h.cleanup();
    }
  });
});

describe('失败路径', () => {
  it('传输失败：不推进水位线，记一次失败', async () => {
    const h = make({ reply: () => new Error('boom') });
    try {
      const out = await h.digester.digestNow('group:30000', h.settings);
      assert.equal(out.ok, false);
      assert.equal(out.reason, 'request_failed');
      assert.equal(h.store.memory.cursor('group:30000').last_msg_id, 0, '下次要从同一批重试');
      assert.equal(h.store.memory.cursor('group:30000').failures, 1);
      assert.equal(h.store.memory.list({ limit: 10 }).total, 0);
    } finally {
      h.cleanup();
    }
  });

  it('输出不是 JSON：同样不推进、不产生半条记忆', async () => {
    const h = make({ reply: () => '这段没什么好记的。' });
    try {
      const out = await h.digester.digestNow('group:30000', h.settings);
      assert.equal(out.ok, false);
      assert.equal(out.reason, 'not_json');
      assert.equal(h.store.memory.cursor('group:30000').last_msg_id, 0);
      assert.equal(h.store.memory.list({ limit: 10 }).total, 0);
      assert.equal(h.store.memory.listDays({ limit: 10 }).total, 0, '不能留下空壳概述');
    } finally {
      h.cleanup();
    }
  });

  it('合并失败不算整体失败：拼接版概照旧可用', async () => {
    const h = make({
      messages: 130,
      reply: (n) => (n === 3 ? new Error('merge boom') : GOOD),
    });
    try {
      const out = await h.digester.digestNow('group:30000', h.settings);
      assert.equal(out.ok, true, '合并只是优化，不该让整天白压');
      const days = h.store.memory.listDays({ limit: 10 });
      assert.equal(days.total, 1);
      // 两批各自返回同一段概述，合并失败后拼接成两段
      assert.match(days.items[0]?.content ?? '', /加班/);
      assert.ok((days.items[0]?.content ?? '').length > JSON.parse(GOOD).summary.length);
    } finally {
      h.cleanup();
    }
  });
});

describe('调度', () => {
  it('会话还在聊就不压（避免把一段对话切成两半）', async () => {
    const h = make();
    try {
      // 会话刚 touch 过，idle 阈值 10 分钟 → sweep 不该排
      h.digester.sweep(h.settings);
      assert.equal(h.digester.pendingJobs(), 0);
    } finally {
      h.cleanup();
    }
  });

  it('功能关着时 sweep 什么都不做', async () => {
    const h = make({ patch: (v) => (v.memory.enabled = false) });
    try {
      h.digester.sweep(h.settings);
      assert.equal(h.digester.pendingJobs(), 0);
      assert.equal(h.calls.length, 0);
    } finally {
      h.cleanup();
    }
  });

  // consider() 是「攒够条数立刻压」那条路，原来完全不看配额：
  // 话多的群每几十条就压一次，每会话日上限形同虚设。
  it('攒够条数也要先过日上限，超额不再排队', async () => {
    const h = make({
      messages: 10,
      patch: (v) => {
        v.memory.digest_force_msgs = 10;
        v.memory.digest_daily_limit = 6;
      },
    });
    try {
      seedCursor(h.store, 'group:30000', 6);
      h.digester.consider('group:30000', h.settings);
      assert.equal(h.digester.pendingJobs(), 0, '日上限已满就不该再排队');
      await new Promise((r) => setTimeout(r, 30));
      assert.equal(h.calls.length, 0, '一次模型请求都不该发');
    } finally {
      h.cleanup();
    }
  });

  it('配额没用满时照常排队', async () => {
    const h = make({
      messages: 10,
      patch: (v) => {
        v.memory.digest_force_msgs = 10;
        v.memory.digest_daily_limit = 6;
      },
    });
    try {
      seedCursor(h.store, 'group:30000', 5);
      h.digester.consider('group:30000', h.settings);
      assert.equal(h.digester.pendingJobs(), 1);
      await new Promise((r) => setTimeout(r, 50));
      assert.equal(h.calls.length, 1);
    } finally {
      h.cleanup();
    }
  });

  it('水位线的日期不是今天时，昨天的计数不算数', async () => {
    const h = make({
      messages: 10,
      patch: (v) => {
        v.memory.digest_force_msgs = 10;
        v.memory.digest_daily_limit = 6;
      },
    });
    try {
      // 昨天压满 6 次，今天应该重新有额度
      seedCursor(h.store, 'group:30000', 6, '2000-01-01');
      h.digester.consider('group:30000', h.settings);
      assert.equal(h.digester.pendingJobs(), 1);
      await new Promise((r) => setTimeout(r, 50));
    } finally {
      h.cleanup();
    }
  });
});

/** 直接写一条水位线，模拟「今天已经压过 n 次」。 */
function seedCursor(
  store: Store,
  sessionID: string,
  digestsToday: number,
  day: string = localDay(new Date()),
): void {
  store.db.run(
    `INSERT INTO memory_cursors
       (session_id, owner_name, last_msg_id, last_digest_at, digests_today, day_label, failures, updated_at)
     VALUES (?, '', 0, 0, ?, ?, 0, 0)
     ON CONFLICT(session_id) DO UPDATE SET
       digests_today = excluded.digests_today, day_label = excluded.day_label`,
    sessionID,
    digestsToday,
    day,
  );
}
