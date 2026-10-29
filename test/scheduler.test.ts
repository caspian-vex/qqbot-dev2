// 时钟驱动的主动发言：决策函数 + 引擎 tick 链路。
//
// 这一层比"回复"危险得多：回复错了是答非所问，主动说错了是"这号有病"，
// 而且没人看着（对方可能在睡觉）。所以用例集中在闸门与"闭嘴"上：
// 免打扰、日限、群聊不插话、对方已经接着说上了、模型输出空。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  Engine,
  IDLE_MIN_GAP_MS,
  alarmInstruction,
  idleInstruction,
  inQuietHours,
  planIdle,
  type IdleState,
  type Sender,
} from '../src/bot';
import type { LlmClient } from '../src/llm/client';
import { Logger } from '../src/log/logger';
import { Store } from '../src/store';
import { defaultProactive, type ProactiveSettings } from '../src/store/types';

const tmpDirs: string[] = [];
after(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

// ---- 纯函数 ----

describe('免打扰时段', () => {
  const at = (h: number): Date => {
    const d = new Date();
    d.setHours(h, 30, 0, 0);
    return d;
  };

  it('跨零点的窗：23 点到 8 点', () => {
    assert.equal(inQuietHours(at(23), 23, 8), true);
    assert.equal(inQuietHours(at(2), 23, 8), true);
    assert.equal(inQuietHours(at(7), 23, 8), true);
    assert.equal(inQuietHours(at(8), 23, 8), false, '右端开区间');
    assert.equal(inQuietHours(at(12), 23, 8), false);
  });

  it('不跨零点的窗按普通区间判断', () => {
    assert.equal(inQuietHours(at(13), 13, 15), true);
    assert.equal(inQuietHours(at(15), 13, 15), false);
  });

  it('起止相同表示不启用', () => {
    assert.equal(inQuietHours(at(3), 0, 0), false);
  });

  it('0-24 表示全天静默，不会被当成"不启用"', () => {
    assert.equal(inQuietHours(at(3), 0, 24), true);
    assert.equal(inQuietHours(at(23), 0, 24), true);
  });
});

describe('闲置唤醒决策', () => {
  const now = Date.now();
  const hold = 45 * 60_000;
  const opt = (globalLeft = 10): Parameters<typeof planIdle>[1] => ({ now, globalLeft });
  const st = (patch: Partial<IdleState> = {}): IdleState => ({
    sid: 'private:20000',
    kind: 'private',
    target: 20000,
    lastRole: 'user',
    lastAt: now - 60 * 60_000,
    spokeToday: 0,
    lastSpokeAt: 0,
    holdMs: hold,
    rate: 1,
    dailyLimit: 3,
    ...patch,
  });

  it('没到闲置时长不开口', () => {
    const d = planIdle([st({ lastAt: now - 10 * 60_000 })], opt());
    assert.equal(d.state, null);
  });

  it('最后一句是机器人说的，归回声跟进管，这里不抢', () => {
    assert.equal(planIdle([st({ lastRole: 'assistant' })], opt()).state, null);
  });

  it('群里永远不主动插话', () => {
    assert.equal(planIdle([st({ kind: 'group', sid: 'group:30000' })], opt()).state, null);
  });

  it('超过本会话日限不再开口；上限为 0 视为本会话关闭', () => {
    assert.equal(planIdle([st({ spokeToday: 3 })], opt()).state, null);
    assert.equal(planIdle([st({ dailyLimit: 0 })], opt()).state, null);
  });

  it('距上次主动开口不足 90 分钟不再开口', () => {
    const s = st({ lastSpokeAt: now - IDLE_MIN_GAP_MS + 60_000 });
    assert.equal(planIdle([s], opt()).state, null);
  });

  it('概率未命中时这一轮沉默（不会排队到下一轮）', () => {
    assert.equal(planIdle([st({ rate: 0 })], opt()).state, null);
  });

  it('进程级额度用尽时一律沉默', () => {
    assert.equal(planIdle([st()], opt(0)).state, null);
  });

  it('一次只挑一个：等得最久的先开口', () => {
    const young = st({ sid: 'private:1', lastAt: now - 50 * 60_000 });
    const old = st({ sid: 'private:2', lastAt: now - 300 * 60_000 });
    const d = planIdle([young, old], opt());
    assert.equal(d.state?.sid, 'private:2');
    assert.equal(d.satForMin, 300);
  });

  it('门槛与概率按会话各自生效：全局关着、单独开着也能开口', () => {
    // 这正是把 holdMs/rate 放进状态而不是统一读全局设置的原因：
    // 否则"这个会话单独打开了闲置唤醒"会永远不生效，而面板上写着"独立"。
    const on = st({ sid: 'private:7' });
    const off = st({ sid: 'private:8', holdMs: 0, rate: 0 });
    assert.equal(planIdle([off], opt()).state, null);
    assert.equal(planIdle([on, off], opt()).state?.sid, 'private:7');
  });
});

describe('内部指令', () => {
  it('闲置指令带上对方原话与等待时长，并给出闭嘴权', () => {
    const s = idleInstruction(45, '今天好累');
    assert.ok(s.includes('今天好累'));
    assert.ok(s.includes('45 分钟'));
    assert.ok(s.includes('空字符串'), '必须允许模型什么都不说');
    assert.ok(s.includes('在干嘛'), '要显式禁止试探式开场');
  });

  it('对方最后发的是图片时不留空白引号', () => {
    assert.ok(idleInstruction(10, '  ').includes('图片'));
  });

  it('闹钟指令要求别提时间机制，也别用"系统""提醒事项"这类词', () => {
    const s = alarmInstruction(0);
    assert.ok(s.includes('不要提"定时"'));
    assert.ok(s.includes('提醒事项'));
  });
});

// ---- 引擎 tick 链路 ----

interface Hit {
  kind: string;
  target: number;
  texts: string[];
}

interface Harness {
  engine: Engine;
  store: Store;
  hits: Hit[];
  cleanup: () => void;
}

function harness(patch: (p: ProactiveSettings) => void, reply = '你刚才说的那个事，后来定了吗？'): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-sched-'));
  tmpDirs.push(dir);
  const store = new Store(join(dir, 'qqbot.db'));
  store.settings.update((v) => {
    v.timing.enabled = false;
    v.bot.seg_delay_min_ms = 0;
    v.bot.seg_delay_max_ms = 0;
    patch(v.proactive);
  });

  const hits: Hit[] = [];
  const sender: Sender = {
    sendGroup: async (id, segs) => {
      hits.push({ kind: 'group', target: id, texts: segs.map((s) => String(s.data['text'])) });
      return 1;
    },
    sendPrivate: async (id, segs) => {
      hits.push({ kind: 'private', target: id, texts: segs.map((s) => String(s.data['text'])) });
      return 1;
    },
    groupInfo: async () => '测试群',
  };

  const llm = {
    // 按最后一条是不是内部指令区分"主动开口"与"普通回复"：
    // 两者用同一段假文本的话，用例分不清是谁说的话。
    chat: async (_cfg: unknown, msgs: { content: unknown }[]) => {
      const last = String(msgs[msgs.length - 1]?.content ?? '');
      const active = last.includes('内部指令');
      return {
        content: active ? reply : '我看到了，你说。',
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        firstTokenMs: 1,
      };
    },
  } as unknown as LlmClient;

  const engine = new Engine({ store, log: Logger.create({ level: 'error', format: 'text' }), llm });
  engine.setSender(sender);
  engine.setSelf(10000, 'bot');
  return { engine, store, hits, cleanup: () => store.close() };
}

/** 造一个"对方 N 分钟前说了最后一句"的私聊会话。 */
function seedPrivate(store: Store, minutesAgo: number, text = '今天加班到十点'): void {
  const sid = 'private:20000';
  store.sessions.touch(sid, 'private', 20000, '小明');
  store.sessions.append(sid, 'user', text, 10);
  // created_at 是写入时刻，按需往前挪——用例要的是"隔了多久"，不是"刚写的"
  store.db.run(`UPDATE messages SET created_at = ? WHERE session_id = ?`, Math.floor(Date.now() / 1000) - minutesAgo * 60, sid);
}

async function waitFor(cond: () => boolean, ms = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('等待超时');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('闲置唤醒链路', () => {
  it('对方一小时后没被接住，机器人主动补一句', async () => {
    const h = harness((p) => {
      p.idle_after_min = 45;
      p.idle_rate = 1;
      p.proactive_daily_limit = 3;
      p.quiet_start_hour = 0;
      p.quiet_end_hour = 0;
    });
    try {
      seedPrivate(h.store, 60);
      await h.engine.tick();
      await waitFor(() => h.hits.length >= 1);

      assert.equal(h.hits[0]!.kind, 'private');
      assert.equal(h.hits[0]!.target, 20000);
      assert.equal(h.hits[0]!.texts[0], '你刚才说的那个事，后来定了吗？');
      // 历史里要留下这条，否则下一轮模型不知道自己主动说过话
      const history = h.store.sessions.recent('private:20000', 5);
      assert.deepEqual(
        history.map((m) => m.role),
        ['user', 'assistant'],
      );
    } finally {
      h.cleanup();
    }
  });

  it('模型输出空 = 行使闭嘴权：不发也不记', async () => {
    const h = harness((p) => {
      p.idle_after_min = 45;
      p.idle_rate = 1;
      p.quiet_start_hour = 0;
      p.quiet_end_hour = 0;
    }, '   ');
    try {
      seedPrivate(h.store, 60);
      await h.engine.tick();
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(h.hits.length, 0);
      assert.equal(h.store.sessions.recent('private:20000', 5).length, 1, '空输出不该落库');
    } finally {
      h.cleanup();
    }
  });

  it('还没到闲置时长就不开口', async () => {
    const h = harness((p) => {
      p.idle_after_min = 45;
      p.idle_rate = 1;
      p.quiet_start_hour = 0;
      p.quiet_end_hour = 0;
    });
    try {
      seedPrivate(h.store, 5);
      await h.engine.tick();
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(h.hits.length, 0);
    } finally {
      h.cleanup();
    }
  });

  it('免打扰时段内不开口', async () => {
    const h = harness((p) => {
      p.idle_after_min = 45;
      p.idle_rate = 1;
      p.quiet_start_hour = 0;
      p.quiet_end_hour = 24;
    });
    try {
      seedPrivate(h.store, 60);
      await h.engine.tick();
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(h.hits.length, 0);
    } finally {
      h.cleanup();
    }
  });

  it('对方刚又说了话，正在排队的主动开口作废', async () => {
    const h = harness((p) => {
      p.idle_after_min = 45;
      p.idle_rate = 1;
      p.quiet_start_hour = 0;
      p.quiet_end_hour = 0;
    });
    try {
      seedPrivate(h.store, 60);
      // 先让会话"刚刚有人说话"：模拟 tick 之后、执行之前对方追了一句
      h.engine.handleEvent({
        time: 0,
        self_id: 10000,
        post_type: 'message',
        message_type: 'private',
        message_id: 9,
        user_id: 20000,
        group_id: 0,
        message: [{ type: 'text', data: { text: '我又来了' } }],
        raw: {},
      });
      await h.engine.tick();
      await new Promise((r) => setTimeout(r, 200));
      // 只会有一条：正常回复；不该再跟上一条"你刚才说的那个事"
      const proactive = h.hits.filter((x) => x.texts[0] === '你刚才说的那个事，后来定了吗？');
      assert.equal(proactive.length, 0, '对方已经接着说上了，不该再补一句');
    } finally {
      h.cleanup();
    }
  });
});

describe('闹钟链路', () => {
  it('到点发原话，不花模型的钱，也不落成用户消息', async () => {
    const h = harness(() => {});
    try {
      const sid = 'private:20000';
      h.store.sessions.touch(sid, 'private', 20000, '小明');
      h.store.scheduled.add({
        session_id: sid,
        kind: 'private',
        target_id: 20000,
        due_at: Math.floor(Date.now() / 1000) - 5,
        body: '记得交房租',
      });

      await h.engine.tick();
      await waitFor(() => h.hits.length >= 1);
      assert.equal(h.hits[0]!.texts[0], '记得交房租');

      // 发过就标 done，再 tick 一次不该重复
      await h.engine.tick();
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(h.hits.length, 1);
      assert.equal(h.store.scheduled.countPending(), 0);
    } finally {
      h.cleanup();
    }
  });

  it('免打扰不影响闹钟：这是用户让它提醒的事', async () => {
    const h = harness((p) => {
      p.quiet_start_hour = 0;
      p.quiet_end_hour = 24;
    });
    try {
      const sid = 'private:20000';
      h.store.sessions.touch(sid, 'private', 20000, '小明');
      h.store.scheduled.add({
        session_id: sid,
        kind: 'private',
        target_id: 20000,
        due_at: Math.floor(Date.now() / 1000) - 1,
        body: '该吃药了',
      });
      await h.engine.tick();
      await waitFor(() => h.hits.length >= 1);
      assert.equal(h.hits[0]!.texts[0], '该吃药了');
    } finally {
      h.cleanup();
    }
  });

  it('body 为空时让模型自己组织一句', async () => {
    const h = harness(() => {}, '到点了，该出发去车站了。');
    try {
      const sid = 'private:20000';
      h.store.sessions.touch(sid, 'private', 20000, '小明');
      h.store.scheduled.add({
        session_id: sid,
        kind: 'private',
        target_id: 20000,
        due_at: Math.floor(Date.now() / 1000) - 1,
      });
      await h.engine.tick();
      await waitFor(() => h.hits.length >= 1);
      assert.equal(h.hits[0]!.texts[0], '到点了，该出发去车站了。');
    } finally {
      h.cleanup();
    }
  });

  it('过期太久的闹钟不补发', async () => {
    const h = harness(() => {});
    try {
      const sid = 'private:20000';
      h.store.sessions.touch(sid, 'private', 20000, '小明');
      h.store.scheduled.add({
        session_id: sid,
        kind: 'private',
        target_id: 20000,
        due_at: Math.floor(Date.now() / 1000) - 24 * 3600,
        body: '昨天的晚安',
      });
      await h.engine.tick();
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(h.hits.length, 0);
    } finally {
      h.cleanup();
    }
  });
});
