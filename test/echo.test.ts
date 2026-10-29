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
import {
  echoDelayMs,
  echoInstruction,
  isAwaitingAnswer,
  repeatsLastReply,
  shouldEcho,
  Engine,
  type Sender,
} from '../src/bot';
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

describe('时机闸门：上一条是否在等回答', () => {
  // 判据是"任意位置含问号"或"以语气词 / 了没 收尾"——
  // 线上那句的问号藏在颜文字里（（・ω・？），按尾部判会漏。
  const cases: [string, boolean][] = [
    ['', false],
    ['晚上好呀，游戏现在跑顺点了没（・ω・？', true], // 线上原文
    ['画质调好了没', true],
    ['还没', false],
    ['真的？', true],
    ['晚安。', false],
    ['你就说嘛', true], // 语气词收尾，保守方向：宁可少补一句
    ['要不要我帮你看看配置', false], // 已知缺口：V 不 V 问句不识别
  ];
  for (const [text, want] of cases) {
    it(`${JSON.stringify(text)} → ${want}`, () => {
      assert.equal(isAwaitingAnswer(text), want);
    });
  }
});

describe('跟进重复检测', () => {
  const dup: [string, string][] = [
    ['游戏你调过画质之后有没有好点呀？', '那游戏你调过画质之后有没有好点呀'],
    ['要不要我帮你看看配置文件？', '要不要我帮你看看配置文件'],
    ['画质调过之后画面顺了不少吧，现在应该不卡了', '画质调过之后画面顺了不少'],
    ['嗯', '嗯'],
    ['画质调了之后好点没', '你画质调了之后好点没'],
  ];
  for (const [echo, last] of dup) {
    it(`判重：${echo}`, () => {
      assert.equal(repeatsLastReply(echo, last), true);
    });
  }

  const ok: [string, string][] = [
    ['行', '嗯'],
    ['好呀那我去睡了', '好呀'],
    ['行吧', '行'],
    ['我刚吃完', '你吃了吗'],
    // 已知缺口，如实钉在这里：这两句在语义上是同一件事，但字面几乎不重叠
    // （二元组交集只有「游戏」，Jaccard≈0.04），这个函数判不出来。
    // 真正治它的是时机闸门 + 指令里带上一条原文，别指望调阈值。
    ['那你还玩别的游戏吗', '那游戏你调过画质之后有没有好点呀'],
  ];
  for (const [echo, last] of ok) {
    it(`不判重：${echo}`, () => {
      assert.equal(repeatsLastReply(echo, last), false);
    });
  }
});

describe('跟进指令', () => {
  it('带上一条原文，且不再要求"抛出小问题"', () => {
    const t = echoInstruction('晚上好呀，游戏现在跑顺点了没');
    assert.ok(t.includes('（内部指令'), '测试靠这四个字区分两跳，不能改');
    assert.ok(t.includes('你上一句已经发出去的是「晚上好呀，游戏现在跑顺点了没」'));
    assert.ok(!t.includes('抛出一个具体的小问题'), '这句是重复追问的直接诱因');
    assert.ok(t.includes('空字符串'), '必须保留模型的闭嘴权');
  });

  it('没有上一条文字（纯发图）时也给一版自洽的措辞', () => {
    const t = echoInstruction('  ');
    assert.ok(t.includes('（内部指令'));
    assert.ok(!t.includes('「」'), '不能出现空的引文');
    assert.ok(t.includes('空字符串'));
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

function makeHarness(
  echoPatch: Record<string, unknown> = {},
  llmPatch: { reply?: string; echo?: string } = {},
): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-echo-'));
  tmpDirs.push(dir);
  const store = new Store(join(dir, 'qqbot.db'));
  store.settings.update((v) => {
    // 群消息走被动接话：钉成必触发，用例才不依赖随机数
    v.bot.passive_rate = 1;
    v.bot.group_cooldown_sec = 0;
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

  // 假模型：最后一次问是内部指令时输出跟进内容，否则输出普通回复。
  // 两跳靠「内部指令」这个字面量区分（engine.test.ts 同约定），
  // 所以 echoInstruction 里必须保留这四个字。
  const prompts: string[] = [];
  const llm = {
    chat: async (_cfg: unknown, msgs: { role: string; content: string }[]) => {
      prompts.push(msgs.map((m) => `${m.role}:${m.content}`).join('\n'));
      const last = msgs[msgs.length - 1]!.content;
      const content = last.includes('内部指令')
        ? (llmPatch.echo ?? '对了，刚才那个事后来怎么样了？')
        : (llmPatch.reply ?? '你好呀');
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
      // 跟进请求里必须带着上一条原文：不告诉它自己刚才说了什么，
      // 它就只能把那句换个说法再问一遍（线上就是这么连发了两条）。
      assert.ok(
        h.prompts.some(
          (p) => p.includes('内部指令') && p.includes('你上一句已经发出去的是「你好呀」'),
        ),
        '请求里应带上一条原文',
      );
      assert.equal(h.engine.pendingEchoCount(), 0);
    } finally {
      h.cleanup();
    }
  });

  it('回复已经在问对方问题时，不排跟进', async () => {
    // 线上 2026-10-29：用户只说「晚上好」，回复是「…跑顺点了没（・ω・？」，
    // 40 秒后又补了一句「…调过画质之后有没有好点呀」，看着像同一个消息回了两遍。
    const h = makeHarness({}, { reply: '晚上好呀，游戏现在跑顺点了没（・ω・？' });
    try {
      h.engine.handleEvent(ev());
      await waitFor(() => h.sent.length >= 1);
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(h.sent.length, 1, '已在等对方回答，不该再补一句');
      assert.equal(h.engine.pendingEchoCount(), 0, '连定时器都不该挂');
      assert.equal(h.prompts.length, 1, '不该有第二跳模型调用');
    } finally {
      h.cleanup();
    }
  });

  it('跟进内容与上一条重复时丢弃，不发也不记', async () => {
    const h = makeHarness({}, { reply: '晚安，早点睡', echo: '晚安，早点睡' });
    try {
      h.engine.handleEvent(ev());
      await waitFor(() => h.sent.length >= 1);
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(h.sent.length, 1, '复读的内容不该发出去');
      assert.equal(h.store.sessions.recent('private:20000', 10).length, 2, '也不该落库');
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
