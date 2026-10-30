// 预排消息仓储：落库语义 + 重启后仍在。
//
// 这组用例的重点不是 CRUD，而是三条"出了就查不出来"的行为：
//   1. 重启之后闹钟还在（这正是当初决定落库的原因）
//   2. 停机太久的不补发（否则开机一串迟到的自言自语）
//   3. 删会话连带删闹钟（否则死人回来说话）
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { EXPIRE_AFTER_SEC, MAX_PENDING_PER_SESSION, Store } from '../src/store';

const tmpDirs: string[] = [];
after(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function open(): { store: Store; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-sched-'));
  tmpDirs.push(dir);
  return { store: new Store(join(dir, 'qqbot.db')), dir };
}

/** 排一条 N 秒后到期的私聊。 */
function addIn(store: Store, inSec: number, body = '该交房租了', sid = 'private:20000'): number {
  return store.scheduled.add({
    session_id: sid,
    kind: 'private',
    target_id: 20000,
    due_at: Math.floor(Date.now() / 1000) + inSec,
    body,
  });
}

describe('调度表迁移', () => {
  it('新库直接到 v8，表可用', () => {
    const { store } = open();
    try {
      assert.equal(store.db.userVersion(), 8);
      assert.equal(store.scheduled.countPending(), 0);
    } finally {
      store.close();
    }
  });

  it('老库（v6）升级后不丢原有设置', () => {
    const { store, dir } = open();
    store.settings.update((v) => {
      v.llm.model = 'custom-model';
    });
    store.close();

    // 重开一次即走"已存在库"的路径，迁移不应重跑也不应清数据
    const again = new Store(join(dir, 'qqbot.db'));
    try {
      assert.equal(again.settings.get().llm.model, 'custom-model');
      assert.equal(again.db.userVersion(), 8);
    } finally {
      again.close();
    }
  });
});

describe('到点取用', () => {
  it('只取到期的，按时间升序', () => {
    const { store } = open();
    try {
      const now = Math.floor(Date.now() / 1000);
      store.scheduled.add({ session_id: 'private:1', kind: 'private', target_id: 1, due_at: now - 10, body: '早' });
      store.scheduled.add({ session_id: 'private:1', kind: 'private', target_id: 1, due_at: now - 60, body: '更早' });
      addIn(store, 600, '还没到');

      const due = store.scheduled.due(now);
      assert.deepEqual(
        due.map((d) => d.body),
        ['更早', '早'],
        '先到期的排在前面，未到期的不出现',
      );
    } finally {
      store.close();
    }
  });

  it('发过的不会再被取到，且只有 pending 能改动', () => {
    const { store } = open();
    try {
      const now = Math.floor(Date.now() / 1000);
      const id = addIn(store, -1);
      store.scheduled.markDone(id, now);

      assert.equal(store.scheduled.due(now).length, 0);
      // 已完成的再 cancel 一次不该成功——用返回值区分"改到了"和"本来就没了"
      assert.equal(store.scheduled.cancel(id), false);
    } finally {
      store.close();
    }
  });

  it('重复处理同一条不会把它从 done 改回去', () => {
    const { store } = open();
    try {
      const now = Math.floor(Date.now() / 1000);
      const id = addIn(store, -1);
      store.scheduled.markDone(id, now);
      store.scheduled.markDone(id, now + 5);
      const row = store.scheduled.recent(1)[0]!;
      assert.equal(row.status, 'done');
      assert.equal(row.fired_at, now, '首次发出的时间不应被覆盖');
    } finally {
      store.close();
    }
  });
});

describe('重启与过期', () => {
  it('重启后闹钟还在：这是落库的全部意义', () => {
    const { store, dir } = open();
    const id = addIn(store, -30);
    store.close();

    const again = new Store(join(dir, 'qqbot.db'));
    try {
      const due = again.scheduled.due(Math.floor(Date.now() / 1000));
      assert.equal(due.length, 1);
      assert.equal(due[0]!.id, id);
      assert.equal(due[0]!.body, '该交房租了');
    } finally {
      again.close();
    }
  });

  it('停机太久的不补发，标成 expired 而不是 done', () => {
    const { store } = open();
    try {
      const now = Math.floor(Date.now() / 1000);
      // 比过期阈值再多一小时
      const id = store.scheduled.add({
        session_id: 'private:1',
        kind: 'private',
        target_id: 1,
        due_at: now - EXPIRE_AFTER_SEC - 3600,
        body: '前天晚上该说的晚安',
      });

      assert.equal(store.scheduled.expireStale(now), 1);
      assert.equal(store.scheduled.due(now).length, 0, '过期的不该再发');
      const row = store.scheduled.recent(10).find((r) => r.id === id);
      assert.equal(row?.status, 'expired');
    } finally {
      store.close();
    }
  });

  it('刚到期几分钟的不算过期，照常补发', () => {
    const { store } = open();
    try {
      const now = Math.floor(Date.now() / 1000);
      addIn(store, -300);
      assert.equal(store.scheduled.expireStale(now), 0);
      assert.equal(store.scheduled.due(now).length, 1);
    } finally {
      store.close();
    }
  });
});

describe('上限与撤销', () => {
  it('单会话挂满后再排会被拒（抛错而不是静默丢）', () => {
    const { store } = open();
    try {
      for (let i = 0; i < MAX_PENDING_PER_SESSION; i++) addIn(store, 60 + i);
      assert.throws(() => addIn(store, 600), /待发的定时消息/);
      // 拒绝的是"新增"，已有的不动
      assert.equal(store.scheduled.countPending('private:20000'), MAX_PENDING_PER_SESSION);
    } finally {
      store.close();
    }
  });

  it('撤销整个会话，不影响别的会话', () => {
    const { store } = open();
    try {
      addIn(store, 60, 'a', 'private:20000');
      addIn(store, 60, 'b', 'private:20001');
      assert.equal(store.scheduled.cancelSession('private:20000'), 1);
      assert.equal(store.scheduled.countPending('private:20000'), 0);
      assert.equal(store.scheduled.countPending('private:20001'), 1);
    } finally {
      store.close();
    }
  });

  it('删会话连带删除它的闹钟', () => {
    const { store } = open();
    try {
      store.sessions.touch('private:20000', 'private', 20000, '某人');
      const id = addIn(store, 60);
      store.sessions.delete('private:20000');
      const row = store.scheduled.recent(10).find((r) => r.id === id);
      assert.equal(row, undefined, '会话没了，闹钟不该还在');
    } finally {
      store.close();
    }
  });

  it('清理只删已结束的记录，pending 一条不动', () => {
    const { store } = open();
    try {
      const now = Math.floor(Date.now() / 1000);
      const done = addIn(store, -1);
      store.scheduled.markDone(done, now);
      const waiting = addIn(store, 3600);

      assert.equal(store.scheduled.prune(now + 10), 1);
      const left = store.scheduled.recent(10);
      assert.deepEqual(
        left.map((r) => r.id),
        [waiting],
      );
    } finally {
      store.close();
    }
  });
});
