// 回声式跟进测试：纯函数闸门 + 假 LLM/假协议端驱动的引擎级链路。
//
// 主动消息出 bug 比回复出 bug 更糟——回复错了是答非所问，
// 主动发错了是"这个机器人有病"。所以用例集中在：
// 排了但被取消、日限额兜底、临时指令绝不落库。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { ECHO_INSTRUCTION, echoDelayMs, shouldEcho, Engine, type Sender } from '../src/bot';
import { Logger } from '../src/log/logger';
import type { LlmClient } from '../src/llm/client';
import type { Event } from '../src/onebot/types';
import { Store } from '../src/store';
import { defaultSettings } from '../src/store/types';

const tmpDirs: string[] = [];
after(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

// ---- 纯函数 ----

describe('跟进延迟采样', () => {
  const base = { ...defaultSettings().proactive, echo_min_sec: 30, echo_max_sec: 90 };

  it('rand=0 时取下限', () => {
    assert.equal(echoDelayMs(base, () => 0), 30_000);
  });

  it('rand→1 时趋近上限', () => {
    const v = echoDelayMs(base, () => 0.999);
    assert.ok(v > 89_000 && v <= 90_000, `应接近上限: ${v}`);
  });

  it('上限小于下限时退化为下限（旧数据可能不合法）', () => {
    assert.equal(echoDelayMs({ ...base, echo_min_sec: 60, echo_max_sec: 10 }, () => 0.9), 60_000);
  });
});

describe('跟进闸门', () => {
  const base = defaultSettings().proactive;

  it('开关关闭时一律不触发', () => {
    assert.equal(
      shouldEcho({ ...base, echo_enabled: false, echo_rate: 1 }, { sentToday: 0, cooldownOk: true }),
      false,
    );
  });

  it('日限额用尽后不再触发，哪怕概率是 1', () => {
    const s = { ...base, echo_enabled: true, echo_rate: 1, echo_daily_limit: 2 };
    assert.equal(shouldEcho(s, { sentToday: 2, cooldownOk: true }), false);
    assert.equal(shouldEcho(s, { sentToday: 1, cooldownOk: true }), true);
  });

  it('会话冷却未过时不触发', () => {
    const s = { ...base, echo_enabled: true, echo_rate: 1 };
    assert.equal(shouldEcho(s, { sentToday: 0, cooldownOk: false }), false);
  });

  it('概率为 0 时永不触发；日限额为 0 视为完全关闭', () => {
    assert.equal(
      shouldEcho({ ...base, echo_enabled: true, echo_rate: 0 }, { sentToday: 0, cooldownOk: true }),
      false,
    );
    assert.equal(
      shouldEcho(
        { ...base, echo_enabled: true, echo_rate: 1, echo_daily_limit: 0 },
        { sentToday: 0, cooldownOk: true },
      ),
      false,
    );
  });
});

// ---- 引擎级链路 ----

interface SentMsg {
  kind: string;
  target: number;
  texts: string[];
}

interface Harness {
  engine: Engine;
  store: Store;
  sent: SentMsg[];
  prompts: string[];
  cleanup: () => void;
}

function ev(patch: Partial<Event> = {}): Event {
  return {
    time: 0,
    self_id: 10000,
    post_type: 'message',
    message_type: 'private',
    message_id: 1,
    user_id: 20000,
    group_id: 0,
    message: [{ type: 'text', data: { text: '你好' } }],
    raw: {},
    ...patch,
  };
}

function makeHarness(echoPatch: Record<string, unknown> = {}): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-echo-'));
  tmpDirs.push(dir);
  const store = new Store(join(dir, 'qqbot.db'));
  store.settings.update((v) => {
    // 群消息走被动接话：钉成必触发，用例才不依赖随机数
    v.bot.passive_rate = 1;
    v.bot.group_cooldown_sec = 0;
    // 拟人节奏关掉：这里要验的是"排没排、发没发"，不是真的等几秒
    v.timing.enabled = false;
    Object.assign(v.proactive, {
      echo_enabled: true,
      echo_rate: 1,
      echo_min_sec: 0,
      echo_max_sec: 0,
      echo_cooldown_min: 0,
      echo_daily_limit: 10,
      ...echoPatch,
    });
  });

  const sent: SentMsg[] = [];
  const sender: Sender = {
    sendGroup: async (id, segs) => {
      sent.push({ kind: 'group', target: id, texts: segs.map((s) => String(s.data['text'])) });
      return 1;
    },
    sendPrivate: async (id, segs) => {
      sent.push({ kind: 'private', target: id, texts: segs.map((s) => String(s.data['text'])) });
      return 1;
    },
    groupInfo: async () => '测试群',
  };

  // 假模型：最后一问是内部指令时输出跟进内容，否则输出普通回复
  const prompts: string[] = [];
  const llm = {
    chat: async (_cfg: unknown, msgs: { role: string; content: string }[]) => {
      prompts.push(msgs.map((m) => `${m.role}:${m.content}`).join('\n'));
      const last = msgs[msgs.length - 1]!.content;
      const content = last.includes('内部指令') ? '对了，刚才那个事后来怎么样了？' : '你好呀';
      return {
        content,
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
  return {
    engine,
    store,
    sent,
    prompts,
    cleanup: () => store.close(),
  };
}

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('等待超时');
    await new Promise((r) => setTimeout(r, 20));
  }
}

describe('回声式跟进链路', () => {
  it('回复后延迟跟进：无事件直发、指令不落库、内容记为 assistant', async () => {
    const h = makeHarness();
    try {
      h.engine.handleEvent(ev());
      await waitFor(() => h.sent.length >= 2);

      assert.equal(h.sent[0]!.texts[0], '你好呀', '第一跳是正常回复');
      assert.equal(h.sent[1]!.kind, 'private');
      assert.equal(h.sent[1]!.target, 20000);
      assert.equal(h.sent[1]!.texts[0], '对了，刚才那个事后来怎么样了？');

      // 历史里是 user → assistant → assistant；临时指令绝不能出现
      const history = h.store.sessions.recent('private:20000', 10);
      assert.deepEqual(
        history.map((m) => m.role),
        ['user', 'assistant', 'assistant'],
      );
      assert.equal(history[0]!.content, '你好');
      assert.equal(history[1]!.content, '你好呀');
      assert.equal(history[2]!.content, '对了，刚才那个事后来怎么样了？');
      for (const m of history) {
        assert.ok(!m.content.includes('内部指令'), '内部指令不能进历史');
      }
      assert.ok(h.prompts.some((p) => p.includes(ECHO_INSTRUCTION)), '请求里应带内部指令');
      assert.equal(h.engine.pendingEchoCount(), 0);
    } finally {
      h.cleanup();
    }
  });

  it('跟进没话说（空输出）时正常放弃，不发也不记', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-echo-'));
    tmpDirs.push(dir);
    const store = new Store(join(dir, 'qqbot.db'));
    store.settings.update((v) => {
      v.timing.enabled = false;
      Object.assign(v.proactive, {
        echo_enabled: true,
        echo_rate: 1,
        echo_min_sec: 0,
        echo_max_sec: 0,
        echo_cooldown_min: 0,
        echo_daily_limit: 10,
      });
    });

    const sent: SentMsg[] = [];
    const sender: Sender = {
      sendGroup: async () => 1,
      sendPrivate: async (id, segs) => {
        sent.push({ kind: 'private', target: id, texts: segs.map((s) => String(s.data['text'])) });
        return 1;
      },
      groupInfo: async () => '',
    };
    const llm = {
      chat: async (_c: unknown, msgs: { content: string }[]) => {
        const last = msgs[msgs.length - 1]!.content;
        return {
          content: last.includes('内部指令') ? '  ' : '你好呀',
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
          firstTokenMs: 1,
        };
      },
    } as unknown as LlmClient;
    const engine = new Engine({ store, log: Logger.create({ level: 'error', format: 'text' }), llm });
    engine.setSender(sender);
    engine.setSelf(10000, 'bot');

    try {
      engine.handleEvent(ev());
      await waitFor(() => sent.length >= 1);
      // 跟进要么不发、要么放弃，总之最终只有 1 条
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(sent.length, 1, '空输出不应发送任何内容');
      const history = store.sessions.recent('private:20000', 10);
      assert.equal(history.length, 2, '空输出也不落库');
    } finally {
      store.close();
    }
  });

  it('跟进未发出前用户又说话 → 立即作废', async () => {
    const h = makeHarness({ echo_min_sec: 60, echo_max_sec: 60 });
    try {
      h.engine.handleEvent(ev());
      await waitFor(() => h.sent.length >= 1);
      assert.equal(h.engine.pendingEchoCount(), 1, '回复后应挂起一个跟进');

      // 新消息会在判定前就拆掉跟进（哪怕这条消息本身被冷却拦下）
      h.engine.handleEvent(ev({ message_id: 2 }));
      assert.equal(h.engine.pendingEchoCount(), 0);
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(h.sent.length, 1, '跟进不应发出');
    } finally {
      h.cleanup();
    }
  });

  it('同一会话的日限额用尽后不再跟进', async () => {
    const h = makeHarness({ echo_daily_limit: 1 });
    const g = (mid: number): Event =>
      ev({ message_type: 'group', group_id: 30000, user_id: 20000, message_id: mid });
    try {
      h.engine.handleEvent(g(1));
      await waitFor(() => h.sent.length >= 2, 3000);
      assert.equal(h.sent[1]!.texts[0], '对了，刚才那个事后来怎么样了？');

      // 同一会话第二条：回复照常，跟进被本会话额度拦住
      h.engine.handleEvent(g(2));
      await waitFor(() => h.sent.length >= 3, 3000);
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(h.sent.length, 3, '额度用尽后不应再跟进');
      assert.equal(h.engine.pendingEchoCount(), 0);
    } finally {
      h.cleanup();
    }
  });

  it('日限额按会话各自计算：一个会话用尽不影响另一个', async () => {
    // 曾经是全局累计：群 1 用掉额度，私聊也跟着哑掉。改成按会话之后，
    // 用户才能"这个群多补几句、那个群少补几句"，覆盖才像真的生效。
    const h = makeHarness({ echo_daily_limit: 1 });
    try {
      h.engine.handleEvent(ev({ user_id: 20000 }));
      await waitFor(() => h.sent.length >= 2, 3000);
      assert.equal(h.sent[1]!.texts[0], '对了，刚才那个事后来怎么样了？');

      // 另一个会话有自己的额度，照常跟进
      h.engine.handleEvent(ev({ user_id: 20001, message_id: 2 }));
      await waitFor(() => h.sent.length >= 4, 3000);
      assert.equal(h.sent[3]!.texts[0], '对了，刚才那个事后来怎么样了？', '第二个会话应拿到自己的额度');
    } finally {
      h.cleanup();
    }
  });

  it('同一会话冷却期内不再排第二个跟进', async () => {
    const h = makeHarness({ echo_cooldown_min: 30 });
    try {
      // 群会话：被动接话概率 1、群冷却 0，连续两条普通消息都能触发回复
      const g = (id: number): Event =>
        ev({
          message_type: 'group',
          group_id: 30000,
          user_id: id,
          message: [{ type: 'text', data: { text: '你好' } }],
        });

      h.engine.handleEvent(g(20000));
      await waitFor(() => h.sent.length >= 2, 3000);
      assert.equal(h.sent[0]!.kind, 'group');
      assert.equal(h.sent[1]!.texts[0], '对了，刚才那个事后来怎么样了？', '第一跳应有跟进');

      h.engine.handleEvent({ ...g(20000), message_id: 2 });
      await waitFor(() => h.sent.length >= 3, 3000);
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(h.sent.length, 3, '冷却期内不应再跟进');
      assert.equal(h.engine.pendingEchoCount(), 0);
    } finally {
      h.cleanup();
    }
  });
});
