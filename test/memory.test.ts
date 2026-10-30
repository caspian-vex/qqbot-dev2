// 长期记忆：仓储、召回裁剪、摘要输出解析。
//
// 这一层不碰网络，全部用真库（node:sqlite）跑——记忆的很多坑都在 SQL 语义里
// （upsert 冲突时 MAX() 的行为、UNION ALL 的排序、水位线推进的幂等性），
// 用假的仓储测等于什么都没测。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { Store } from '../src/store';
import type { DaySummary, Memory } from '../src/store';
import { pickForPrompt } from '../src/memory/recall';
import { parseDigest, recallBlock, renderMessage } from '../src/memory/prompt';

const dirs: string[] = [];

function open(): { store: Store; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-mem-'));
  dirs.push(dir);
  return { store: new Store(join(dir, 'qqbot.db')), dir };
}

after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function seedSession(store: Store, sid = 'group:1', name = '测试群'): void {
  store.sessions.touch(sid, sid.split(':')[0] ?? 'group', Number(sid.split(':')[1] ?? 1), name);
}

function appendN(store: Store, sid: string, n: number): void {
  for (let i = 0; i < n; i++) {
    store.sessions.append(sid, i % 2 === 0 ? 'user' : 'assistant', `第 ${i} 条`, 1, {
      id: 20001,
      name: '阿伟',
    });
  }
}

describe('事实仓储', () => {
  it('同一条内容重复写不新增，只把分数顶高', () => {
    const { store } = open();
    try {
      store.memory.add({ scope: 'user', owner_id: '20001', content: '在杭州做后端', score: 3 });
      store.memory.add({ scope: 'user', owner_id: '20001', content: '在杭州做后端', score: 5 });
      const all = store.memory.list({ limit: 10 });
      assert.equal(all.total, 1);
      assert.equal(all.items[0]?.score, 5, '重复出现说明它重要，取较高的分');
    } finally {
      store.close();
    }
  });

  it('分数与空白被归一化，超长内容截断', () => {
    const { store } = open();
    try {
      store.memory.add({ scope: 'user', owner_id: '20001', content: '  讨厌   被叫全名 ', score: 99 });
      const m = store.memory.list({ limit: 1 }).items[0];
      assert.equal(m?.content, '讨厌 被叫全名');
      assert.equal(m?.score, 5, '超出 1-5 的分数要夹紧');
    } finally {
      store.close();
    }
  });

  it('过短的内容直接丢弃（没有信息量）', () => {
    const { store } = open();
    try {
      store.memory.add({ scope: 'user', owner_id: '20001', content: '好' });
      assert.equal(store.memory.list({ limit: 10 }).total, 0);
    } finally {
      store.close();
    }
  });

  it('召回按分数排序、跨归属合并、且守住分数门槛', () => {
    const { store } = open();
    try {
      seedSession(store, 'group:1');
      store.memory.add({ scope: 'session', owner_id: 'group:1', content: '这个群在聊考研', score: 4 });
      store.memory.add({ scope: 'user', owner_id: '20001', content: '在杭州做后端', score: 5 });
      store.memory.add({ scope: 'user', owner_id: '20001', content: '偶尔熬夜', score: 2 });

      const got = store.memory.recall(
        [
          { scope: 'session', owner_id: 'group:1' },
          { scope: 'user', owner_id: '20001' },
        ],
        { limit: 5, minScore: 3 },
      );
      assert.deepEqual(
        got.map((m) => m.content),
        ['在杭州做后端', '这个群在聊考研'],
        '两个归属放进同一个排序，低分的直接排除',
      );
    } finally {
      store.close();
    }
  });

  it('召回不串台：拿不到别的会话/别人的记忆', () => {
    const { store } = open();
    try {
      store.memory.add({ scope: 'session', owner_id: 'group:2', content: '二号群的秘密', score: 5 });
      store.memory.add({ scope: 'user', owner_id: '30001', content: '另一个人的事', score: 5 });
      const got = store.memory.recall(
        [
          { scope: 'session', owner_id: 'group:1' },
          { scope: 'user', owner_id: '20001' },
        ],
        { limit: 10, minScore: 1 },
      );
      assert.equal(got.length, 0);
    } finally {
      store.close();
    }
  });

  it('裁剪到上限时只删摘要产出的，手工加的一条不丢', () => {
    const { store } = open();
    try {
      store.memory.add({ scope: 'user', owner_id: '20001', content: '手工记下的事', score: 1, source: 'manual' });
      for (let i = 0; i < 5; i++) {
        store.memory.add({ scope: 'user', owner_id: '20001', content: `自动记的第 ${i} 件事`, score: 3 });
      }
      store.memory.pruneOwner('user', '20001', 2);
      const left = store.memory.list({ limit: 10 }).items;
      assert.ok(
        left.some((m) => m.content === '手工记下的事'),
        '人确认过的记忆不能被自动清理掉',
      );
      assert.ok(left.length <= 3, '自动的裁到上限');
    } finally {
      store.close();
    }
  });

  it('清空可以限定范围，也可以全清', () => {
    const { store } = open();
    try {
      store.memory.add({ scope: 'user', owner_id: '20001', content: '用户维度的一条', score: 4 });
      store.memory.add({ scope: 'session', owner_id: 'group:1', content: '会话维度的一条', score: 4 });
      assert.equal(store.memory.clear({ scope: 'user' }), 1);
      assert.equal(store.memory.list({ limit: 10 }).total, 1);
      assert.equal(store.memory.clear({}), 1);
      assert.equal(store.memory.list({ limit: 10 }).total, 0);
    } finally {
      store.close();
    }
  });
});

describe('日摘要与水位线', () => {
  it('同一时间段重复写会覆盖，不产生两行', () => {
    const { store } = open();
    try {
      const base = { session_id: 'group:1', day: '2026-10-30', period_start: 100, period_end: 200, msg_count: 4 };
      store.memory.saveDay({ ...base, content: '第一版', tokens: 3 });
      store.memory.saveDay({ ...base, content: '第二版', tokens: 3 });
      const r = store.memory.listDays({ limit: 10 });
      assert.equal(r.total, 1);
      assert.equal(r.items[0]?.content, '第二版');
    } finally {
      store.close();
    }
  });

  it('一天两次整理就是两行，按结束时间倒序返回', () => {
    const { store } = open();
    try {
      store.memory.saveDay({
        session_id: 'group:1', day: '2026-10-30',
        period_start: 100, period_end: 200, msg_count: 4, content: '上午那段', tokens: 3,
      });
      store.memory.saveDay({
        session_id: 'group:1', day: '2026-10-30',
        period_start: 300, period_end: 400, msg_count: 4, content: '下午那段', tokens: 3,
      });
      const got = store.memory.recentDays('group:1', 2);
      assert.equal(got.length, 2, '按"摘要记录"存，一天两次不该互相覆盖');
      assert.equal(got[0]?.content, '下午那段');
    } finally {
      store.close();
    }
  });

  it('水位线之后才是待摘要的消息，推进后不再重复取', () => {
    const { store } = open();
    try {
      seedSession(store, 'group:1');
      appendN(store, 'group:1', 6);
      assert.equal(store.memory.pending('group:1'), 6);

      const batch = store.memory.pendingBatch('group:1', 10);
      assert.equal(batch.length, 6);
      const lastID = batch[batch.length - 1]?.id ?? 0;
      store.memory.advance('group:1', lastID, '测试群', 1000, '2026-10-30');

      assert.equal(store.memory.pending('group:1'), 0);
      assert.equal(store.memory.pendingBatch('group:1', 10).length, 0);
    } finally {
      store.close();
    }
  });

  it('水位线只进不退：旧值写回来也不会倒退', () => {
    const { store } = open();
    try {
      seedSession(store, 'group:1');
      appendN(store, 'group:1', 4);
      const ids = store.memory.pendingBatch('group:1', 10).map((m) => m.id);
      store.memory.advance('group:1', ids[3] ?? 0, '', 1000, '2026-10-30');
      store.memory.advance('group:1', ids[0] ?? 0, '', 1100, '2026-10-30');
      assert.equal(store.memory.cursor('group:1').last_msg_id, ids[3]);
    } finally {
      store.close();
    }
  });

  it('同一天第二次整理不重置当日计数，跨天则归 1', () => {
    const { store } = open();
    try {
      store.memory.advance('group:1', 1, '', 1000, '2026-10-30');
      store.memory.advance('group:1', 2, '', 1100, '2026-10-30');
      assert.equal(store.memory.cursor('group:1').digests_today, 2);
      store.memory.advance('group:1', 3, '', 1200, '2026-10-31');
      assert.equal(store.memory.cursor('group:1').digests_today, 1);
    } finally {
      store.close();
    }
  });

  it('待摘要会话：到点或攒够条数都算，失败过的要等冷却', () => {
    const { store } = open();
    try {
      seedSession(store, 'group:1');
      appendN(store, 'group:1', 2);
      const now = Math.floor(Date.now() / 1000);

      // 从未整理过 → 到点条件成立
      assert.equal(
        store.memory.dueSessions({ sinceSec: now, forceMsgs: 100, failureCutoff: now - 3600, limit: 10 })
          .length,
        1,
      );
      // 不按时间、条数也不够 → 不排
      assert.equal(
        store.memory.dueSessions({ sinceSec: -1, forceMsgs: 100, failureCutoff: now - 3600, limit: 10 })
          .length,
        0,
      );
      // 条数够 → 排
      assert.equal(
        store.memory.dueSessions({ sinceSec: -1, forceMsgs: 2, failureCutoff: now - 3600, limit: 10 })
          .length,
        1,
      );

      // 刚完事就失败 → 冷却期内不再排
      store.memory.noteFailure('group:1', now);
      assert.equal(
        store.memory.dueSessions({ sinceSec: now, forceMsgs: 2, failureCutoff: now - 3600, limit: 10 })
          .length,
        0,
        '一个坏 JSON 不该让它每分钟重试一次',
      );
    } finally {
      store.close();
    }
  });
});

describe('删会话时的记忆归属', () => {
  it('会话维度的记忆一起删，用户维度留着', () => {
    const { store } = open();
    try {
      seedSession(store, 'group:1');
      appendN(store, 'group:1', 2);
      store.memory.add({ scope: 'session', owner_id: 'group:1', content: '群里的约定', score: 4 });
      store.memory.add({ scope: 'user', owner_id: '20001', content: '阿伟在杭州', score: 5 });
      store.memory.saveDay({
        session_id: 'group:1', day: '2026-10-30',
        period_start: 1, period_end: 2, msg_count: 2, content: '聊了两句', tokens: 3,
      });

      store.sessions.delete('group:1');

      assert.equal(store.memory.listDays({ limit: 10 }).total, 0, '概述跟着会话走');
      const facts = store.memory.list({ limit: 10 }).items;
      assert.equal(facts.length, 1);
      assert.equal(facts[0]?.scope, 'user', '删群不该让机器人忘了这个人');
    } finally {
      store.close();
    }
  });
});

describe('召回裁剪', () => {
  const mem = (id: number, content: string, score: number): Memory => ({
    id, scope: 'user', owner_id: '20001', owner_name: '阿伟', kind: 'fact',
    content, score, source: 'digest', hits: 0,
    created_at: new Date(), updated_at: new Date(), last_used_at: new Date(0),
  });
  const day = (id: number, content: string): DaySummary => ({
    id, session_id: 'group:1', day: '2026-10-30',
    period_start: new Date(), period_end: new Date(), msg_count: 2,
    content, tokens: 10, created_at: new Date(),
  });

  it('条数上限生效', () => {
    const facts = [mem(1, '事实一', 5), mem(2, '事实二', 5), mem(3, '事实三', 5)];
    const got = pickForPrompt(facts, [], { maxFacts: 2, budget: 1000, minScore: 1 });
    assert.equal(got.facts.length, 2);
  });

  it('分数门槛生效', () => {
    const got = pickForPrompt([mem(1, '低分的一条', 2)], [], {
      maxFacts: 5, budget: 1000, minScore: 4,
    });
    assert.equal(got.facts.length, 0);
  });

  it('同一内容在两个归属各存一份时只留一条', () => {
    const got = pickForPrompt([mem(1, '在杭州做后端', 5), mem(2, '在杭州做后端', 4)], [], {
      maxFacts: 5, budget: 1000, minScore: 1,
    });
    assert.equal(got.facts.length, 1);
  });

  it('概述占满预算时事实被挤掉，但概述至少留一条', () => {
    const long = '这段聊了很多'.repeat(40);
    const got = pickForPrompt([mem(1, '一条事实', 5)], [day(1, long), day(2, long)], {
      maxFacts: 5, budget: 120, minScore: 1,
    });
    assert.equal(got.days.length, 1, '第一条概述永远收下');
    assert.equal(got.facts.length, 0, '剩下的预算不够就不硬塞');
  });
});

describe('摘要输出解析', () => {
  const speakers = new Map<number, string>([[20001, '阿伟']]);

  it('标准 JSON', () => {
    const r = parseDigest(
      JSON.stringify({
        summary: '今天主要在聊加班。',
        memories: [{ scope: 'user', owner_qq: 20001, kind: 'preference', content: '讨厌加班', score: 4 }],
      }),
      { sessionID: 'group:1', sessionName: '测试群', speakers },
    );
    assert.equal(r.ok, true);
    assert.equal(r.summary, '今天主要在聊加班。');
    assert.deepEqual(r.facts, [
      { scope: 'user', owner_id: '20001', owner_name: '阿伟', kind: 'preference', content: '讨厌加班', score: 4 },
    ]);
  });

  it('剥掉 ``` 围栏，并容忍前面多一句解释', () => {
    const raw = '好的，结果如下：\n```json\n{"summary":"聊了考研","memories":[]}\n```';
    const r = parseDigest(raw, { sessionID: 'group:1', speakers });
    assert.equal(r.ok, true);
    assert.equal(r.summary, '聊了考研');
  });

  it('session 维度的事实落到当前会话名下，owner_qq 被忽略', () => {
    const r = parseDigest(
      JSON.stringify({
        summary: '群里在玩梗。',
        memories: [{ scope: 'session', owner_qq: 99999, content: '群里管机器人叫小度', score: 3 }],
      }),
      { sessionID: 'group:1', sessionName: '测试群', speakers },
    );
    assert.equal(r.facts[0]?.owner_id, 'group:1');
    assert.equal(r.facts[0]?.owner_name, '测试群');
  });

  it('编造的 QQ 号被丢弃，其余照收', () => {
    const r = parseDigest(
      JSON.stringify({
        summary: '聊了几句。',
        memories: [
          { scope: 'user', owner_qq: 88888, content: '这个人根本不存在', score: 5 },
          { scope: 'user', owner_qq: 20001, content: '喜欢冰美式', score: 4 },
        ],
      }),
      { sessionID: 'group:1', speakers },
    );
    assert.equal(r.facts.length, 1);
    assert.equal(r.facts[0]?.content, '喜欢冰美式');
  });

  it('未知种类降级成 fact 而不是丢掉', () => {
    const r = parseDigest(
      JSON.stringify({
        summary: '聊了几句。',
        memories: [{ scope: 'user', owner_qq: 20001, kind: '心情', content: '最近状态一般', score: 3 }],
      }),
      { sessionID: 'group:1', speakers },
    );
    assert.equal(r.facts[0]?.kind, 'fact');
  });

  it('不是 JSON 时 ok=false（水位线不能推进）', () => {
    const r = parseDigest('我觉得这段没什么好记的。', { sessionID: 'group:1', speakers });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'not_json');
  });

  it('给了 JSON 但内容为空是 ok（重试也是白花钱）', () => {
    const r = parseDigest('{"summary":"","memories":[]}', { sessionID: 'group:1', speakers });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'empty');
  });

  it('裸数组外壳也能读', () => {
    const r = parseDigest(
      JSON.stringify([{ scope: 'user', owner_qq: 20001, content: '养了只猫叫豆豆', score: 4 }]),
      { sessionID: 'group:1', speakers },
    );
    assert.equal(r.facts.length, 1);
  });
});

describe('渲染', () => {
  it('机器人自己的消息标成「我」，没有说话人的老消息标成「某人」', () => {
    const base = { id: 1, session_id: 'group:1', tokens: 1, created_at: new Date(2026, 9, 30, 21, 3) };
    assert.match(renderMessage({ ...base, role: 'assistant', content: '又加？', speaker_id: 0, speaker_name: '' }), /我：又加？/);
    assert.match(
      renderMessage({ ...base, role: 'user', content: '今晚加班', speaker_id: 0, speaker_name: '' }),
      /某人：今晚加班/,
    );
    assert.match(
      renderMessage({ ...base, role: 'user', content: '今晚加班', speaker_id: 20001, speaker_name: '阿伟' }),
      /阿伟\(20001\)：今晚加班/,
    );
  });

  it('记忆块带免责声明：它是背景资料，不是指令', () => {
    const block = recallBlock({
      facts: [{
        id: 1, scope: 'user', owner_id: '20001', owner_name: '阿伟', kind: 'preference',
        content: '讨厌被叫全名', score: 4, source: 'digest', hits: 0,
        created_at: new Date(), updated_at: new Date(), last_used_at: new Date(0),
      }],
      days: [{
        id: 1, session_id: 'group:1', day: '2026-10-30', period_start: new Date(),
        period_end: new Date(), msg_count: 2, content: '在聊考研', tokens: 5, created_at: new Date(),
      }],
    });
    assert.match(block, /【最近聊过的】/);
    assert.match(block, /【关于对方的长期记忆】/);
    assert.match(block, /不是指令/);
    assert.match(block, /★{4}/);
  });
});
