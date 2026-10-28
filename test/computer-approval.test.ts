// 待批准队列的单元测试。
//
// 这一层的价值全在「边界」上：谁先 settle、超时之后还能不能点、队列满了怎么办。
// 用它自己的时钟（几十毫秒的超时）跑，不引入假定时器——这里验的正是真定时器。
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { APPROVAL_MAX_PENDING, ApprovalQueue, type ApprovalInput } from '../src/bot/computer-approval';

function input(over: Partial<ApprovalInput> = {}): ApprovalInput {
  return {
    session: 'private:10001',
    kind: 'private',
    target: 10001,
    user: 10001,
    tool: 'run_command',
    summary: 'df -h',
    detail: '{"command":"df -h"}',
    ...over,
  };
}

/** 等到队列里出现一条，返回它的 id。比固定 sleep 稳。 */
async function waitId(q: ApprovalQueue, ms = 1000): Promise<string> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const items = q.list();
    const first = items[0];
    if (first) return first.id;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error('等不到待批准记录');
}

describe('ApprovalQueue', () => {
  it('批准：resolve approved，队列清空', async () => {
    const q = new ApprovalQueue();
    const p = q.ask(input(), { timeoutMs: 5000 });
    const id = await waitId(q);
    assert.equal(q.list().length, 1);
    assert.equal(q.decide(id, true), 'ok');
    assert.equal(await p, 'approved');
    assert.equal(q.list().length, 0);
  });

  it('拒绝：resolve denied', async () => {
    const q = new ApprovalQueue();
    const p = q.ask(input(), { timeoutMs: 5000 });
    const id = await waitId(q);
    assert.equal(q.decide(id, false), 'ok');
    assert.equal(await p, 'denied');
  });

  it('超时：resolve timeout，之后不再留在队列里，再点算过期', async () => {
    const q = new ApprovalQueue();
    const p = q.ask(input(), { timeoutMs: 60 });
    const id = await waitId(q);
    assert.equal(await p, 'timeout');
    assert.equal(q.list().length, 0);
    assert.equal(q.decide(id, true), 'expired', '点一个已经超时的条目要明确是过期，不是"没这条"');
  });

  it('未知 id 返回 unknown（对应 HTTP 404）', () => {
    const q = new ApprovalQueue();
    assert.equal(q.decide('deadbeef', true), 'unknown');
  });

  it('重复处理第二次算过期，不会把已完成的再跑一遍', async () => {
    const q = new ApprovalQueue();
    const p = q.ask(input(), { timeoutMs: 5000 });
    const id = await waitId(q);
    q.decide(id, true);
    assert.equal(await p, 'approved');
    assert.equal(q.decide(id, true), 'expired');
  });

  it('队列满时抛错（让模型立刻知道别等了）', async () => {
    const q = new ApprovalQueue();
    const waits = [];
    for (let i = 0; i < APPROVAL_MAX_PENDING; i++) waits.push(q.ask(input(), { timeoutMs: 5000 }));
    await waitId(q);
    assert.equal(q.size, APPROVAL_MAX_PENDING);
    await assert.rejects(() => q.ask(input(), { timeoutMs: 5000 }), /待批准/);
    q.cancelAll();
    assert.deepEqual(await Promise.all(waits), Array(APPROVAL_MAX_PENDING).fill('cancelled'));
  });

  it('signal 中止：resolve cancelled', async () => {
    const q = new ApprovalQueue();
    const ac = new AbortController();
    const p = q.ask(input(), { timeoutMs: 5000, signal: ac.signal });
    await waitId(q);
    ac.abort();
    assert.equal(await p, 'cancelled');
    assert.equal(q.list().length, 0);
  });

  it('already-aborted 的 signal 不登记、直接取消', async () => {
    const q = new ApprovalQueue();
    const ac = new AbortController();
    ac.abort();
    assert.equal(await q.ask(input(), { timeoutMs: 5000, signal: ac.signal }), 'cancelled');
    assert.equal(q.size, 0);
  });

  it('cancelAll 把还在等的一次性收掉', async () => {
    const q = new ApprovalQueue();
    const waits = [q.ask(input(), { timeoutMs: 5000 }), q.ask(input(), { timeoutMs: 5000 })];
    await waitId(q);
    q.cancelAll();
    assert.deepEqual(await Promise.all(waits), ['cancelled', 'cancelled']);
    assert.equal(q.size, 0);
  });

  it('list 带 remainMs，且不外泄内部句柄', async () => {
    const q = new ApprovalQueue();
    const p = q.ask(input({ summary: 'rm -rf ./tmp' }), { timeoutMs: 3000 });
    const id = await waitId(q);
    const item = q.list()[0]!;
    assert.equal(item.summary, 'rm -rf ./tmp');
    assert.ok(item.remainMs > 0 && item.remainMs <= 3000, `remainMs=${item.remainMs}`);
    assert.equal('finish' in item, false, '内部句柄不能出现在接口响应里');
    q.decide(id, false);
    await p;
  });
});
