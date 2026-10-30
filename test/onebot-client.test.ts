// OneBot 客户端：取消语义与访问令牌的回归测试。
//
// 取消那一组守的是一条契约：调用方给的 signal 已经中止时，call() 必须当场失败。
// 挂住不返回的话，上层（面板、引擎）会一直等，pending 表也要等到断线才被清掉。
//
// 令牌那一组守的是另一条：拨号时必须带上配置里的令牌，而运行时换令牌要真的
// 反映到下一次握手。这条以前完全没测过——两条老用例都传空令牌，
// 断言只看 header 之外的取消语义。改坏的风险在于「协议端认新值、我们带旧值」，
// 症状是 401 后无限退避重连，比没配令牌更难查。
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

/** 起一个记录每次握手 Authorization 头的协议端。 */
async function withAuthRecorder(fn: (url: string, seen: string[]) => Promise<void>): Promise<void> {
  const seen: string[] = [];
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>((r) => wss.once('listening', () => r()));
  wss.on('connection', (_ws, req) => {
    seen.push(String(req.headers.authorization ?? ''));
  });
  const port = (wss.address() as AddressInfo).port;
  try {
    await fn(`ws://127.0.0.1:${port}`, seen);
  } finally {
    for (const c of wss.clients) c.terminate();
    await new Promise<void>((r) => wss.close(() => r()));
  }
}

/** 等到条件成立，超时就抛——比固定 sleep 稳，也不会在慢机器上假红。 */
async function waitFor(what: string, ready: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error(`等待超时：${what}`);
    await sleep(20);
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

describe('访问令牌', () => {
  it('令牌非空时每个握手都带 Authorization: Bearer', async () => {
    await withAuthRecorder(async (url, seen) => {
      const ac = new AbortController();
      const client = new Client(url, 't0', log());
      void client.run(ac.signal);

      await waitFor('首次握手', () => seen.length >= 1);
      assert.equal(seen[0], 'Bearer t0', '协议端配了令牌却不带，握手就是 401');

      ac.abort();
      client.close();
    });
  });

  it('令牌为空时不发 Authorization 头', async () => {
    await withAuthRecorder(async (url, seen) => {
      const ac = new AbortController();
      const client = new Client(url, '', log());
      void client.run(ac.signal);

      await waitFor('首次握手', () => seen.length >= 1);
      // 空串拼成 "Bearer " 也是错的：某些实现在"要有令牌但值不对"时直接 403
      assert.equal(seen[0], '');

      ac.abort();
      client.close();
    });
  });

  it('setToken 换值会断开并用新令牌重拨', async () => {
    await withAuthRecorder(async (url, seen) => {
      const ac = new AbortController();
      const client = new Client(url, 't0', log());
      void client.run(ac.signal);

      await waitFor('首次握手', () => seen.length >= 1);
      client.setToken('t1');

      // 退避 1 秒后重拨，这里给足余量
      await waitFor('用新令牌重拨', () => seen.length >= 2);
      assert.equal(seen[1], 'Bearer t1');
      assert.ok(client.status().reconnects >= 1, '重连计数该涨，否则面板上看不出发生过一次换令牌');

      ac.abort();
      client.close();
    });
  });

  it('setToken 传同一个值不打断连接', async () => {
    await withAuthRecorder(async (url, seen) => {
      const ac = new AbortController();
      const client = new Client(url, 't0', log());
      void client.run(ac.signal);

      await waitFor('首次握手', () => seen.length >= 1);
      // 自动补 WS 每次登录都会调一次；无脑断连等于每次扫码后白掉一次线
      client.setToken('t0');
      await sleep(300);
      assert.equal(seen.length, 1);

      ac.abort();
      client.close();
    });
  });
});
