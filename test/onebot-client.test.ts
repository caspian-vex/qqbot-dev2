// OneBot 客户端：取消语义的回归测试。
//
// 这里只有一条契约，但它很容易被改坏：调用方给的 signal 已经中止时，
// call() 必须当场失败。挂住不返回的话，上层（面板、引擎）会一直等，
// pending 表也要等到断线才被清掉。
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';
import { WebSocketServer } from 'ws';
import { Logger } from '../src/log/logger';
import { Client } from '../src/onebot/client';

const log = (): Logger => Logger.create({ level: 'error', format: 'text' });

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 起一个"只建连、不回包"的协议端：模拟对端卡死。 */
async function withStuckServer(fn: (url: string) => Promise<void>): Promise<void> {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((r) => wss.once('listening', () => r()));
  wss.on('connection', () => {
    // 故意什么都不回
  });
  const port = (wss.address() as AddressInfo).port;
  try {
    await fn(`ws://127.0.0.1:${port}`);
  } finally {
    for (const c of wss.clients) c.terminate();
    await new Promise<void>((r) => wss.close(() => r()));
  }
}

describe('动作调用的取消语义', () => {
  it('signal 已中止时立刻失败，不会挂到 20 秒超时', async () => {
    await withStuckServer(async (url) => {
      const ac = new AbortController();
      const client = new Client(url, '', log());
      void client.run(ac.signal);

      const deadline = Date.now() + 3000;
      while (!client.status().connected) {
        if (Date.now() > deadline) throw new Error('没能连上假协议端');
        await sleep(20);
      }

      // 用 race 而不是 assert.rejects：真挂住时这里要给出可读的失败，而不是把测试拖死
      const outcome = await Promise.race([
        client
          .call('get_status', {}, AbortSignal.abort())
          .then(() => 'resolved' as const, (e: Error) => e.message),
        sleep(1500).then(() => 'timeout' as const),
      ]);
      assert.match(String(outcome), /已取消/, `应立刻以"已取消"失败，实际: ${outcome}`);

      ac.abort();
      client.close();
    });
  });

  it('连接存在时正常取消也会立刻结束调用', async () => {
    await withStuckServer(async (url) => {
      const ac = new AbortController();
      const client = new Client(url, '', log());
      void client.run(ac.signal);

      const deadline = Date.now() + 3000;
      while (!client.status().connected) {
        if (Date.now() > deadline) throw new Error('没能连上假协议端');
        await sleep(20);
      }

      const ctrl = new AbortController();
      const pending = client.call('get_status', {}, ctrl.signal);
      const outcome = Promise.race([
        pending.then(() => 'resolved' as const, (e: Error) => e.message),
        sleep(1500).then(() => 'timeout' as const),
      ]);
      ctrl.abort();
      assert.match(String(await outcome), /已取消/);

      ac.abort();
      client.close();
    });
  });
});
