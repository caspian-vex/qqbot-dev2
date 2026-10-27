// /webui 反代测试：把「面板接口优先、其余才转给协议端」这条契约钉死。
//
// 一旦这条次序反过来，症状是：面板能打开、一登录就转圈——因为
// /api/auth/login 被转给了协议端。这类问题在真机上很难看出来，
// 所以在单测里用一个假协议端把次序、凭据注入、会话门禁全测掉。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { LogHub } from '../src/log/hub';
import { Logger } from '../src/log/logger';
import { hashPassword } from '../src/panel/auth';
import { PanelServer } from '../src/panel/server';
import { Store } from '../src/store';

const PASSWORD = 'webui-proxy-pass';
const BEARER = 'server-side-credential';

/** 假协议端：记录收到的请求，按路径返回 WebUI 首页 / 接口 JSON。 */
interface Upstream {
  base: string;
  seen: Array<{ path: string; auth: string }>;
  close: () => Promise<void>;
}

async function fakeNapCat(): Promise<Upstream> {
  const seen: Array<{ path: string; auth: string }> = [];
  const srv: Server = createServer((req, res) => {
    seen.push({ path: req.url ?? '', auth: String(req.headers.authorization ?? '') });
    if ((req.url ?? '').startsWith('/webui')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><title>NapCat WebUI</title>');
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 0, data: { ok: true } }));
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  const port = (srv.address() as AddressInfo).port;
  return {
    base: `http://127.0.0.1:${port}`,
    seen,
    close: () => new Promise<void>((r) => srv.close(() => r())),
  };
}

describe('NapCat WebUI 反代', () => {
  let up: Upstream;
  let store: Store;
  let panel: PanelServer;
  let base: string;
  let dir: string;

  before(async () => {
    up = await fakeNapCat();
    dir = mkdtempSync(join(tmpdir(), 'qqbot-webui-'));
    store = new Store(join(dir, 'qqbot.db'));
    const hash = await hashPassword(PASSWORD);
    store.settings.update((v) => {
      v.panel.admin_user = 'admin';
      v.panel.password_hash = hash;
    });

    panel = new PanelServer({
      store,
      log: Logger.create({ level: 'error', format: 'text' }),
      hub: new LogHub(20),
      webDir: join(process.cwd(), 'web', 'dist'),
      qq: undefined,
      napcatWebUI: { base: up.base, bearer: () => Promise.resolve(BEARER) },
    });
    const port = await panel.listen('127.0.0.1:0');
    base = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    await panel.close(300);
    store.close();
    await up.close();
    rmSync(dir, { recursive: true, force: true });
  });

  async function login(): Promise<string> {
    const res = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: PASSWORD, totp: '' }),
    });
    assert.equal(res.status, 200);
    const setCookie = res.headers.getSetCookie();
    const session = setCookie
      .find((c) => c.startsWith('qqbot_session='))
      ?.slice('qqbot_session='.length)
      .split(';')[0];
    assert.ok(session, '登录后必须下发会话 cookie');
    return `qqbot_session=${session}`;
  }

  it('未登录时不放行 /webui', async () => {
    const res = await fetch(`${base}/webui/`);
    assert.equal(res.status, 401);
    assert.equal(up.seen.some((s) => s.path.startsWith('/webui')), false);
  });

  it('登录后透传 WebUI 静态首页，并注入服务端凭据', async () => {
    const cookie = await login();
    const res = await fetch(`${base}/webui/`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 200);
    assert.match(await res.text(), /NapCat WebUI/);

    const hit = up.seen.find((s) => s.path === '/webui/');
    assert.ok(hit, '上游必须收到 /webui/');
    assert.equal(hit.auth, `Bearer ${BEARER}`);
  });

  it('面板自己的 /api 接口不被抢走', async () => {
    const cookie = await login();
    const before = up.seen.length;

    const res = await fetch(`${base}/api/auth/status`, { headers: { Cookie: cookie } });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { user?: string };
    assert.equal(body.user, 'admin');
    assert.equal(up.seen.length, before, '面板路由命中后不应打到协议端');
  });

  it('未注册的 /api 路径转给协议端，且覆盖客户端伪造的 Authorization', async () => {
    const cookie = await login();
    const res = await fetch(`${base}/api/OB11Config/GetConfig`, {
      headers: { Cookie: cookie, Authorization: 'Bearer forged-by-browser' },
    });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { code: 0, data: { ok: true } });

    const hit = up.seen.find((s) => s.path === '/api/OB11Config/GetConfig');
    assert.ok(hit, '未注册的 /api 必须转发');
    assert.equal(hit.auth, `Bearer ${BEARER}`, '浏览器给的 Authorization 不可信');
  });
});
