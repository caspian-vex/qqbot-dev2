// 拟人节奏的纯函数测试。
//
// 这一层出的 bug 不会让机器人说错话，只会让它"看起来像机器"或者
// "慢到像挂了"，两种都很难在生产里发现——没人会盯着日志看延迟分布。
// 所以这里把分布的形状、上限、以及关掉开关后的退化行为逐条钉死。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  Engine,
  MAX_LEAD_MS,
  MAX_SEG_TYPING_MS,
  lateDelayMs,
  planSpeech,
  speakUnits,
  typingMs,
  weightedBetween,
  type Sender,
} from '../src/bot';
import type { LlmClient } from '../src/llm/client';
import { Logger } from '../src/log/logger';
import type { Event } from '../src/onebot/types';
import { Store } from '../src/store';
import { defaultTiming, type Settings, type TimingSettings } from '../src/store/types';

/** 按序返回给定值的随机源；用完之后一律返回 0，省得每个用例算准个数。 */
function seq(...vals: number[]): () => number {
  let i = 0;
  return () => vals[i++] ?? 0;
}

/** 关掉迟到的配置：多数用例只验停顿，不该被一条随机迟到打乱。 */
function cfg(patch: Partial<TimingSettings> = {}): TimingSettings {
  return { ...defaultTiming(), late_rate: 0, ...patch };
}

describe('长尾采样', () => {
  it('rand=0 取下限，趋近 1 取上限', () => {
    assert.equal(weightedBetween(100, 1000, () => 0), 100);
    assert.equal(weightedBetween(100, 1000, () => 0.999999), 1000);
  });

  it('多数采样挤在区间前段：rand=0.4 只走到 20%', () => {
    // 0.4 < 0.8（FAST_SHARE）→ 落在前 40% 的 1/4 处
    assert.equal(weightedBetween(0, 1000, () => 0.4), 200);
  });

  it('上界小于下界时退化为下界（脏数据不该产生负延迟）', () => {
    assert.equal(weightedBetween(500, 100, () => 0.9), 500);
  });

  it('负的 rand 与小到离谱的区间都不会越界', () => {
    assert.equal(weightedBetween(10, 10, () => 0.5), 10);
    assert.equal(weightedBetween(10, 20, () => -1), 10);
  });
});

describe('打字耗时的字数折算', () => {
  it('汉字与全角标点各算一个字', () => {
    assert.equal(speakUnits('你好'), 2);
    assert.equal(speakUnits('好的。'), 3);
  });

  it('英文按半字计，空白不计', () => {
    assert.equal(speakUnits('hi'), 1);
    assert.equal(speakUnits('你好 hi'), 3);
    assert.equal(speakUnits('  '), 0);
  });

  it('按字数除以速度，且不超过单段上限', () => {
    assert.equal(typingMs('一二三四五', 5), 1000);
    assert.equal(typingMs('', 5), 0);
    assert.equal(typingMs('一'.repeat(500), 5), MAX_SEG_TYPING_MS);
  });

  it('速度被写成 0 时不产生 Infinity 与 NaN', () => {
    const v = typingMs('一二三', 0);
    assert.ok(Number.isFinite(v) && v > 0, `应为有限正数: ${v}`);
  });
});

describe('发言节奏规划', () => {
  it('关掉开关后完全退化：不等待、不迟到', () => {
    const p = planSpeech(['第一句。', '第二句。'], { ...cfg(), enabled: false });
    assert.deepEqual(p, { leadMs: 0, gapsMs: [0, 0], lateMs: 0 });
  });

  it('没有分段时不排任何停顿', () => {
    assert.deepEqual(planSpeech([], cfg()).gapsMs, []);
  });

  it('首段之前 = 思考 + 打第一段', () => {
    const p = planSpeech(['一二三四五。'], cfg({ think_min_ms: 400, think_max_ms: 400, typing_cps: 5 }), () => 0);
    // 6 个字 / 5 字每秒 = 1200ms，加固定 400ms 思考
    assert.equal(p.leadMs, 1600);
  });

  it('段间隔 = 下一段打字耗时 + 手停，且第一段不重复计', () => {
    const p = planSpeech(
      ['一二三四五。', '六七。'],
      cfg({ think_min_ms: 0, think_max_ms: 0, typing_cps: 5 }),
      // 第一个随机数给思考（区间 0 不影响），第二个给段间手停
      seq(0, 0),
    );
    assert.equal(p.gapsMs[0], 0, '第一段的停顿已含在 leadMs 里');
    // 3 个字 / 5 = 600ms，手停下限 120ms
    assert.equal(p.gapsMs[1], 720);
  });

  it('首段停顿有硬上限：脏配置里的超大思考时间不会让人等到天荒地老', () => {
    // 面板会拦住这种值，但引擎不该信任配置——库里手改一行就能造出来
    const p = planSpeech(['好。'], cfg({ think_min_ms: 30_000, think_max_ms: 30_000 }), () => 0);
    assert.equal(p.leadMs, MAX_LEAD_MS);
  });

  it('单段打字时间也有上限，长段不会把 lead 撑爆', () => {
    const p = planSpeech(['一'.repeat(400)], cfg({ think_min_ms: 0, think_max_ms: 0 }), () => 0);
    assert.equal(p.leadMs, MAX_SEG_TYPING_MS);
  });

  it('迟发概率为 0 时不迟到；概率为 1 时落在配置区间内', () => {
    assert.equal(
      planSpeech(['好。'], cfg({ late_rate: 0 }), () => 0).lateMs,
      0,
    );
    const p = planSpeech(
      ['好。'],
      cfg({ late_rate: 1, late_min_sec: 60, late_max_sec: 300, think_min_ms: 0, think_max_ms: 0 }),
      seq(0, 0, 0),
    );
    assert.equal(p.lateMs, 60_000, 'rand=0 时取迟到下限');
  });
});

describe('迟到采样', () => {
  const base = cfg({ late_rate: 1, late_min_sec: 60, late_max_sec: 300 });

  it('概率未命中时返回 0（不消耗第二条随机数）', () => {
    assert.equal(lateDelayMs(cfg({ late_rate: 0.1 }), () => 0.99), 0);
  });

  it('概率命中时落在 [下限, 上限] 秒之间', () => {
    const lo = lateDelayMs(base, seq(0, 0));
    const hi = lateDelayMs(base, seq(0, 0.999999));
    assert.equal(lo, 60_000);
    assert.ok(hi <= 300_000 && hi > 290_000, `应接近上限: ${hi}`);
  });

  it('关掉开关后永不迟到', () => {
    assert.equal(lateDelayMs({ ...base, enabled: false }, () => 0), 0);
  });
});

// ---- 引擎接线 ----
//
// 纯函数对了不等于接对了：设置读没读、等待放没放在第一段之前、
// 迟到会不会被打断，都只能在引擎这一层验。

const tmpDirs: string[] = [];
after(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

interface Hit {
  at: number;
  text: string;
}

function ev(messageId = 1): Event {
  return {
    time: 0,
    self_id: 10000,
    post_type: 'message',
    message_type: 'private',
    message_id: messageId,
    user_id: 20000,
    group_id: 0,
    message: [{ type: 'text', data: { text: '在吗' } }],
    raw: {},
  };
}

function harness(
  timing: Partial<TimingSettings>,
  patch?: (v: Settings) => void,
  reply = '好。',
): {
  engine: Engine;
  hits: Hit[];
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-timing-'));
  tmpDirs.push(dir);
  const store = new Store(join(dir, 'qqbot.db'));
  store.settings.update((v) => {
    Object.assign(v.timing, { enabled: true, ...timing });
    patch?.(v);
  });

  const hits: Hit[] = [];
  const sender: Sender = {
    sendGroup: async () => 1,
    sendPrivate: async (_id, segs) => {
      hits.push({
        at: Date.now(),
        text: segs.map((s) => String(s.data['text'])).join(''),
      });
      return 1;
    },
    groupInfo: async () => '',
  };

  const llm = {
    chat: async () => ({
      content: reply,
      usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      firstTokenMs: 1,
    }),
  } as unknown as LlmClient;

  const engine = new Engine({
    store,
    log: Logger.create({ level: 'error', format: 'text' }),
    llm,
  });
  engine.setSender(sender);
  engine.setSelf(10000, 'bot');
  return { engine, hits, cleanup: () => store.close() };
}

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('等待超时');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('节奏接线', () => {
  it('思考停顿真的发生在发送之前', async () => {
    // 打字速度拉满，只留 200ms 思考，测的就是那 200ms
    const h = harness({ think_min_ms: 200, think_max_ms: 200, typing_cps: 1000, late_rate: 0 });
    try {
      const t0 = Date.now();
      h.engine.handleEvent(ev());
      await waitFor(() => h.hits.length >= 1);
      const spent = h.hits[0]!.at - t0;
      assert.ok(spent >= 180, `首段之前应有停顿，实际 ${spent}ms`);
      assert.equal(h.hits[0]!.text, '好。');
    } finally {
      h.cleanup();
    }
  });

  it('关掉 timing 后恢复"立刻发"', async () => {
    const h = harness({ enabled: false, think_min_ms: 5000, think_max_ms: 5000 });
    try {
      const t0 = Date.now();
      h.engine.handleEvent(ev());
      await waitFor(() => h.hits.length >= 1);
      assert.ok(h.hits[0]!.at - t0 < 1000, '关掉开关后不该等那 5 秒');
    } finally {
      h.cleanup();
    }
  });

  it('关掉 timing 时仍保留旧的段间固定抖动', async () => {
    // 全 0 的 plan 会把段间隔也清零——那等于"关掉拟人节奏反而发得更快"，
    // 与"关掉就回到旧行为"正好相反。所以关掉时必须传 undefined。
    //
    // 注意 split 会把短句合并到 120 字以内，所以这里必须造两段"长句"，
    // 否则只会发出一条消息，用例会误判成"没发"。
    const long = `${'甲'.repeat(70)}。${'乙'.repeat(70)}。`;
    const h = harness(
      { enabled: false },
      (v) => {
        v.bot.seg_delay_min_ms = 120;
        v.bot.seg_delay_max_ms = 120;
      },
      long,
    );
    try {
      h.engine.handleEvent(ev());
      await waitFor(() => h.hits.length >= 2);
      const gap = h.hits[1]!.at - h.hits[0]!.at;
      assert.ok(gap >= 100, `段间应保留约 120ms 的旧抖动，实际 ${gap}ms`);
    } finally {
      h.cleanup();
    }
  });

  it('迟到的回复被对方的新消息打断，立刻发出', async () => {
    const h = harness({
      think_min_ms: 0,
      think_max_ms: 0,
      late_rate: 1,
      late_min_sec: 30,
      late_max_sec: 30,
    });
    try {
      h.engine.handleEvent(ev(1));
      // 迟到的 30 秒里不该有任何发送
      await new Promise((r) => setTimeout(r, 200));
      assert.equal(h.hits.length, 0, '迟到期间不应发出');

      // 对方追一句：等待立刻结束，回复马上到
      h.engine.handleEvent(ev(2));
      await waitFor(() => h.hits.length >= 1, 2000);
      assert.equal(h.hits[0]!.text, '好。');
    } finally {
      h.cleanup();
    }
  });
});
