// 「登录后自动补反向 WS」的核心是 ensureWsServer 这个纯函数：
// 它只有在真的需要改的时候才返回 true——否则每次登录都会回写配置、
// 让协议端重启一次 OneBot 服务，机器人白掉一次线。
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ensureWsServer } from '../src/panel/api';

describe('ensureWsServer', () => {
  it('空配置里补一条启用的 3001', () => {
    const cfg: Record<string, unknown> = {};
    assert.equal(ensureWsServer(cfg, 3001), true);

    const list = cfg.websocketServers as Array<Record<string, unknown>>;
    assert.equal(list.length, 1);
    assert.equal(list[0]!.port, 3001);
    assert.equal(list[0]!.enable, true);
    assert.equal(list[0]!.enabled, true);
    assert.equal(list[0]!.messagePostFormat, 'array');
  });

  it('已经有启用的 3001 就不动配置', () => {
    const cfg = { websocketServers: [{ port: 3001, enable: true, enabled: true }] };
    assert.equal(ensureWsServer(cfg, 3001), false);
    assert.equal((cfg.websocketServers as unknown[]).length, 1);
  });

  it('3001 存在但被关掉时只改开关，保留用户手写的 token 与 host', () => {
    const cfg = {
      websocketServers: [
        { port: 3001, enable: false, enabled: false, token: 'my-token', host: '127.0.0.1' },
      ],
    };
    assert.equal(ensureWsServer(cfg, 3001), true);
    const s = cfg.websocketServers[0]!;
    assert.equal(s.enable, true);
    assert.equal(s.enabled, true);
    assert.equal(s.token, 'my-token');
    assert.equal(s.host, '127.0.0.1');
  });

  it('配置被 network 包了一层也能认出来', () => {
    const cfg: Record<string, unknown> = { musicSignUrl: '', network: { websocketServers: [] } };
    assert.equal(ensureWsServer(cfg, 3001), true);

    const net = cfg.network as Record<string, unknown>;
    const list = net.websocketServers as Array<Record<string, unknown>>;
    assert.equal(list.length, 1);
    assert.equal(list[0]!.port, 3001);
    // 顶层不应该被写入
    assert.equal(cfg.websocketServers, undefined);
  });

  it('老版本的单对象格式：只把开关打开', () => {
    const cfg: Record<string, unknown> = { websocketServer: { port: 3001, enable: false } };
    assert.equal(ensureWsServer(cfg, 3001), true);
    assert.equal((cfg.websocketServer as Record<string, unknown>).enable, true);

    // 已经开着就不要再改
    assert.equal(ensureWsServer(cfg, 3001), false);
  });

  it('新建的监听带上面板传进来的 access token', () => {
    const cfg: Record<string, unknown> = {};
    assert.equal(ensureWsServer(cfg, 3001, 'secret-token'), true);
    const list = cfg.websocketServers as Array<Record<string, unknown>>;
    // 空 token 等于把 OneBot 控制面（伪造事件、直接调发送接口）敞开
    assert.equal(list[0]!.token, 'secret-token');
    // host 必须保持 0.0.0.0：协议端在另一个容器里，绑回环就连不上
    assert.equal(list[0]!.host, '0.0.0.0');
  });

  it('已有条目里用户写过的 token 永远不被覆盖', () => {
    const cfg = {
      websocketServers: [
        { port: 3001, enable: true, enabled: true, token: 'user-wrote-this' },
      ],
    };
    assert.equal(ensureWsServer(cfg, 3001, 'our-token'), false);
    assert.equal(cfg.websocketServers[0]!.token, 'user-wrote-this');
  });

  it('已有条目 token 为空时补上我们的 token（否则这条监听仍是裸的）', () => {
    const cfg = { websocketServers: [{ port: 3001, enable: true, enabled: true, token: '' }] };
    assert.equal(ensureWsServer(cfg, 3001, 'our-token'), true);
    assert.equal(cfg.websocketServers[0]!.token, 'our-token');

    // 补过之后就是幂等的，不再回写配置（回写会让协议端重启一次）
    assert.equal(ensureWsServer(cfg, 3001, 'our-token'), false);
  });
});
