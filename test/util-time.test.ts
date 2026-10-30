// 可中断 sleep 的两条契约：说到点就到点，说别泄漏就别泄漏。
//
// 第二条曾经是个真实缺陷：{ once: true } 只在 abort 真的触发时才摘监听，
// 而传进来的 signal 是进程级的（main 的 ac.signal 活到退出）。未登录状态下
// 每 5 秒轮询一次、每条多段回复每个间隔一次，一天就是上万个永不释放的闭包，
// 顺带刷满 Node 的 MaxListeners 告警。
import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import { describe, it } from 'node:test';
import { sleep } from '../src/util/time';

describe('sleep(ms, signal)', () => {
  it('到点返回', async () => {
    const t0 = Date.now();
    await sleep(20);
    assert.ok(Date.now() - t0 >= 10);
  });

  it('signal 已 abort 时立即返回', async () => {
    const ac = new AbortController();
    ac.abort();
    const t0 = Date.now();
    await sleep(60_000, ac.signal);
    assert.ok(Date.now() - t0 < 500);
  });

  it('abort 能提前唤醒', async () => {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 20);
    const t0 = Date.now();
    await sleep(60_000, ac.signal);
    assert.ok(Date.now() - t0 < 500);
  });

  it('正常结束时摘掉 abort 监听，不会随调用次数累积', async () => {
    const ac = new AbortController();
    for (let i = 0; i < 12; i++) await sleep(1, ac.signal);
    assert.equal(getEventListeners(ac.signal, 'abort').length, 0);
  });

  it('被 abort 唤醒后也不留监听', async () => {
    const ac = new AbortController();
    const p = sleep(60_000, ac.signal);
    ac.abort();
    await p;
    assert.equal(getEventListeners(ac.signal, 'abort').length, 0);
  });
});
