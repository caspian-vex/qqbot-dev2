// P5 扫码登录测试：NapCat WebUI 客户端 + 面板 /api/qq/* 接口。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { LogHub } from '../src/log/hub';
import { Logger } from '../src/log/logger';
import { NapCatError, NapCatWebUI } from '../src/napcat/webui';
import { hashPassword } from '../src/panel/auth';
import { PanelServer } from '../src/panel/server';
import { Store } from '../src/store';
import { startFakeNapCat, type FakeNapCat } from './fakes/napcat';

const TOKEN = 'webui-token-abc123';
const PASSWORD = 'correct-horse-battery';
const tmpDirs: string[] = [];

after(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

const log = (): Logger => Logger.create({ level: 'error', format: 'text' });

async function withFake(fn: (f: FakeNapCat) => Promise<void>): Promise<void> {
  const f = await startFakeNapCat(TOKEN);
  try {
    await fn(f);
  } finally {
    await f.close();
  }
}

describe('NapCat WebUI 客户端', () => {
  it('用 sha256(token + ".napcat") 换 Credential，并复用到后续调用', async () => {
    await withFake(async (f) => {
      const c = new NapCatWebUI(f.base, TOKEN, log());
      await c.status();
      await c.status();
      await c.loginInfo();
      assert.equal(f.loginCount(), 1, '凭据应被复用，不该每次调用都登录');
    });
  });

  it('token 错误时报鉴权失败', async () => {
    await withFake(async (f) => {
      const c = new NapCatWebUI(f.base, 'wrong-token', log());
      await assert.rejects(() => c.status(), (e: unknown) => {
        assert.ok(e instanceof NapCatError);
        assert.match(e.message, /token 校验失败/);
        return true;
      });
    });
  });

  it('status 归一化真机字段（isLogin / loginPhase / nick）', async () => {
    await withFake(async (f) => {
      const c = new NapCatWebUI(f.base, TOKEN, log());

      const before = await c.status();
      assert.equal(before.login, false);
      assert.equal(before.phase, 'waiting_qrcode');

      f.state.uin = '10001';
      f.state.nick = '测试号';
      const after = await c.status();
      assert.equal(after.login, true);
      assert.equal(after.uin, '10001');
      assert.equal(after.nick, '测试号');
    });
  });

  it('并发调用只换一次凭据（轮询与页面请求会同时进来）', async () => {
    await withFake(async (f) => {
      const c = new NapCatWebUI(f.base, TOKEN, log());
      // 修复前：三次并发都看到 credential 为空，各跑一次 login，
      // 后写的覆盖前面的，先到的那批请求带着作废凭据 → 401
      await Promise.all([c.status(), c.status(), c.status()]);
      assert.equal(f.loginCount(), 1);
    });
  });

  it('二维码返回 PNG data URL（不是那个会跳转的 URL）', async () => {
    await withFake(async (f) => {
      const c = new NapCatWebUI(f.base, TOKEN, log());
      const qr = await c.qrcode();
      assert.match(qr.image, /^data:image\/png;base64,[A-Za-z0-9+/=]+$/);
      assert.ok(qr.image.length > 500, '应该是一张真实图片');
      assert.match(qr.content, /^https:\/\//);
    });
  });

  it('刷新二维码会真的让协议端重建（过期后能换到新码）', async () => {
    await withFake(async (f) => {
      const c = new NapCatWebUI(f.base, TOKEN, log());
      const first = await c.qrcode();
      assert.equal(first.stale, false);

      // 修复前的 bug 就长这样：不带 force（也就是只重复调 GetQQLoginQrcode），
      // 协议端一直返回缓存里那张，二维码失效后就再也换不掉。
      const again = await c.qrcode({ force: true });
      assert.equal(f.state.qrRefreshes, 1, 'force 必须打 RefreshQRcode，光重复读是拿不到新码的');
      assert.notEqual(again.content, first.content);
      assert.notEqual(again.image, first.image, '内容变了，渲染出来的图也必须跟着变');
      assert.equal(again.stale, false);
      // 实机验证：RefreshQRcode 是同步返回新码的（字段 qrcodeurl），
      // 所以 force 那一次不需要再 Get 一遍，省一次往返也不依赖时序假设。
      const gets = f.calls.filter((p) => p === '/api/QQLogin/GetQQLoginQrcode').length;
      assert.equal(gets, 1, '只有首次取码该走 Get，刷新那次直接用 RefreshQRcode 的返回值');
    });
  });

  it('协议端不换码时如实报 stale，不假装刷新成功', async () => {
    await withFake(async (f) => {
      const c = new NapCatWebUI(f.base, TOKEN, log());
      const first = await c.qrcode();
      // 账号被踢下线时 RefreshQRcode 会回成功，但内核不再推新码
      f.state.qrRotateOnRefresh = false;

      const again = await c.qrcode({ force: true });
      assert.equal(f.state.qrRefreshes, 1);
      assert.equal(again.stale, true);
      assert.equal(again.content, first.content);
      // 图还是要给出去：用户能看出"还是这张"，总比二维码框整块空白强
      assert.match(again.image, /^data:image\/png;base64,/);
    });
  });

  it('不刷新时不打 RefreshQRcode（别把用户正在扫的码作废）', async () => {
    await withFake(async (f) => {
      const c = new NapCatWebUI(f.base, TOKEN, log());
      await c.qrcode();
      await c.qrcode();
      await c.qrcode();
      assert.equal(f.state.qrRefreshes, 0);
    });
  });

  it('协议端没有刷新接口时退回已缓存的码，不把扫码页打挂', async () => {
    await withFake(async (f) => {
      const c = new NapCatWebUI(f.base, TOKEN, log());
      const first = await c.qrcode();
      // 老版本 NapCat 没有 RefreshQRcode，调用会失败；这不该连累取码
      f.state.failNextWith = { code: -1, message: 'Not Found' };

      const again = await c.qrcode({ force: true });
      assert.equal(again.logined, false);
      assert.equal(again.content, first.content);
      assert.equal(again.stale, true, '没换成就要如实说，别让用户对着死码等');
      assert.match(again.image, /^data:image\/png;base64,/);
    });
  });

  it('快捷登录列表归一化，空列表不报错', async () => {
    await withFake(async (f) => {
      const c = new NapCatWebUI(f.base, TOKEN, log());
      assert.deepEqual(await c.quickLoginList(), []);

      f.state.saved = [
        { uin: '10001', nick: '一号' },
        { uin: '10002', nick: '二号' },
      ];
      assert.deepEqual(await c.quickLoginList(), [
        { uin: '10001', nick: '一号' },
        { uin: '10002', nick: '二号' },
      ]);
    });
  });

  it('快捷登录不存在的账号时抛出协议端原文', async () => {
    await withFake(async (f) => {
      const c = new NapCatWebUI(f.base, TOKEN, log());
      await assert.rejects(
        () => c.quickLogin('99999'),
        (e: unknown) => e instanceof NapCatError && /没有可快捷登录的账号/.test(e.message),
      );
    });
  });

  it('凭据被协议端作废后，下一次调用自动重新登录', async () => {
    await withFake(async (f) => {
      const c = new NapCatWebUI(f.base, TOKEN, log());
      await c.status();
      assert.equal(f.loginCount(), 1);

      // 模拟 NapCat 重启：旧 Credential 失效
      f.state.invalidateCredential = true;
      await assert.rejects(() => c.status(), /鉴权失败/);

      // 缓存已清，下一次调用应重新登录并成功
      const st = await c.status();
      assert.equal(st.login, false);
      assert.equal(f.loginCount(), 2);
    });
  });

  it('未配置地址或 token 时 configured 为 false', () => {
    assert.equal(new NapCatWebUI('', TOKEN, log()).configured, false);
    assert.equal(new NapCatWebUI('http://127.0.0.1:1', '', log()).configured, false);
    assert.equal(new NapCatWebUI('http://127.0.0.1:1', TOKEN, log()).configured, true);
  });
});

// ---- 面板接口 ----

interface Harness {
  base: string;
  cookie: string;
  csrf: string;
  store: Store;
  stop: () => Promise<void>;
}

async function panelWith(f: FakeNapCat): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-qq-'));
  tmpDirs.push(dir);

  const store = new Store(join(dir, 'qqbot.db'));
  store.settings.update((v) => {
    v.panel.password_hash = ''; // 稍后设置，避免异步
  });
  const hash = await hashPassword(PASSWORD);
  store.settings.update((v) => {
    v.panel.admin_user = 'admin';
    v.panel.password_hash = hash;
  });

  const panel = new PanelServer({
    store,
    log: log(),
    hub: new LogHub(20),
    webDir: join(process.cwd(), 'web', 'dist'),
    qq: new NapCatWebUI(f.base, TOKEN, log()),
  });
  const port = await panel.listen('127.0.0.1:0');
  const base = `http://127.0.0.1:${port}`;

  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: PASSWORD }),
  });
  assert.equal(res.status, 200);
  const setCookie = res.headers.getSetCookie();
  const pick = (n: string): string =>
    setCookie.find((c) => c.startsWith(`${n}=`))?.slice(n.length + 1).split(';')[0] ?? '';

  return {
    base,
    cookie: `qqbot_session=${pick('qqbot_session')}; qqbot_csrf=${pick('qqbot_csrf')}`,
    csrf: pick('qqbot_csrf'),
    store,
    stop: async () => {
      await panel.close(500);
      store.close();
    },
  };
}

describe('面板 /api/qq/*', () => {
  it('未配置协议端时 status 返回 configured=false 且不报错', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-qq-'));
    tmpDirs.push(dir);
    const store = new Store(join(dir, 'qqbot.db'));
    const hash = await hashPassword(PASSWORD);
    store.settings.update((v) => {
      v.panel.password_hash = hash;
    });
    const panel = new PanelServer({
      store,
      log: log(),
      hub: new LogHub(20),
      webDir: join(process.cwd(), 'web', 'dist'),
    });
    const port = await panel.listen('127.0.0.1:0');
    try {
      const base = `http://127.0.0.1:${port}`;
      const login = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'admin', password: PASSWORD }),
      });
      const c = login.headers
        .getSetCookie()
        .map((x) => x.split(';')[0])
        .join('; ');

      const res = await fetch(`${base}/api/qq/status`, { headers: { Cookie: c } });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { configured: boolean; login: boolean };
      assert.equal(body.configured, false);
      assert.equal(body.login, false);
    } finally {
      await panel.close(500);
      store.close();
    }
  });

  it('status 透传登录状态', async () => {
    await withFake(async (f) => {
      const h = await panelWith(f);
      try {
        f.state.uin = '10001';
        f.state.nick = '测试号';
        const res = await fetch(`${h.base}/api/qq/status`, { headers: { Cookie: h.cookie } });
        const body = (await res.json()) as {
          configured: boolean;
          login: boolean;
          uin: string;
          nick: string;
        };
        assert.equal(body.configured, true);
        assert.equal(body.login, true);
        assert.equal(body.uin, '10001');
        assert.equal(body.nick, '测试号');
      } finally {
        await h.stop();
      }
    });
  });

  it('qrcode 需要 CSRF，返回可直接塞进 img 的 data URL', async () => {
    await withFake(async (f) => {
      const h = await panelWith(f);
      try {
        const noCsrf = await fetch(`${h.base}/api/qq/qrcode`, {
          method: 'POST',
          headers: { Cookie: h.cookie },
        });
        assert.equal(noCsrf.status, 403);

        const res = await fetch(`${h.base}/api/qq/qrcode`, {
          method: 'POST',
          headers: { Cookie: h.cookie, 'X-CSRF-Token': h.csrf },
        });
        assert.equal(res.status, 200);
        const body = (await res.json()) as { image: string };
        assert.match(body.image, /^data:image\/png;base64,/);
      } finally {
        await h.stop();
      }
    });
  });

  it('/api/qq/qrcode?refresh=1 让协议端重建二维码（「刷新二维码」按钮走这条）', async () => {
    await withFake(async (f) => {
      const h = await panelWith(f);
      try {
        const post = (q: string): Promise<Response> =>
          fetch(`${h.base}/api/qq/qrcode${q}`, {
            method: 'POST',
            headers: { Cookie: h.cookie, 'X-CSRF-Token': h.csrf },
          });

        const first = (await (await post('')).json()) as { image: string };
        assert.equal(f.state.qrRefreshes, 0, '普通取码不该触发重建');

        const second = (await (await post('?refresh=1')).json()) as {
          image: string;
          stale: boolean;
        };
        assert.equal(f.state.qrRefreshes, 1);
        assert.notEqual(second.image, first.image);
        assert.equal(second.stale, false);
      } finally {
        await h.stop();
      }
    });
  });

  it('已登录时取码不是错误：返回 logined 标记而不是抛错', async () => {
    await withFake(async (f) => {
      f.state.uin = '10001';
      f.state.nick = '测试号';
      const c = new NapCatWebUI(f.base, TOKEN, log());

      // 真机对已登录状态下的 GetQQLoginQrcode 回 code≠0 + "QQ Is Logined"。
      // 这条路径以前直接抛 NapCatError，面板把它变成 500 + 一条 ERROR 日志。
      const qr = await c.qrcode();
      assert.equal(qr.logined, true);
      assert.equal(qr.image, '');
      assert.equal(qr.content, '');
    });
  });

  it('其余业务错误照常抛出，别把"已登录"的宽容做成万能兜底', async () => {
    await withFake(async (f) => {
      f.state.failNextWith = { code: -1, message: '内部错误' };
      const c = new NapCatWebUI(f.base, TOKEN, log());
      await assert.rejects(() => c.qrcode(), /内部错误/);
    });
  });

  it('已登录时 /api/qq/qrcode 回 200 + logined，而不是 500', async () => {
    await withFake(async (f) => {
      f.state.uin = '10001';
      f.state.nick = '测试号';
      const h = await panelWith(f);
      try {
        const res = await fetch(`${h.base}/api/qq/qrcode`, {
          method: 'POST',
          headers: { Cookie: h.cookie, 'X-CSRF-Token': h.csrf },
        });
        // 前端拿 logined 去收起登录卡片并刷新状态；报 500 只会让它
        // 在二维码位置显示一句 "QQ Is Logined"
        assert.equal(res.status, 200);
        const b = (await res.json()) as { image: string; logined: boolean; stale: boolean };
        assert.equal(b.image, '');
        assert.equal(b.logined, true);
        assert.equal(b.stale, false);
      } finally {
        await h.stop();
      }
    });
  });

  it('退出登录走的是"清自动登录 + 重启协议端"，没有那条不存在的 Logout 路由', async () => {
    // 这条用例钉住本次的根因：NapCat 的 WebUI 路由表里从来没有 /QQLogin/Logout，
    // 请求它必然 404，面板上就显示成一句「服务器内部错误」。
    await withFake(async (f) => {
      const c = new NapCatWebUI(f.base, TOKEN, log());
      f.state.uin = '10001';
      f.state.nick = '测试号';
      f.state.autoLoginUin = '10001';
      f.state.saved = [{ uin: '10001', nick: '测试号' }];

      await c.logout();

      assert.ok(f.calls.includes('/api/QQLogin/RestartNapCat'), '要靠重启协议端把登录会话带走');
      assert.ok(!f.calls.includes('/api/QQLogin/Logout'), '不该再调根本不存在的路由');
      assert.equal(f.state.restarts, 1);
      assert.equal(f.state.autoLoginUin, '', '自动登录必须先清掉，否则重启后自己登回去');
      assert.equal((await c.status()).login, false, '退出后应停在未登录状态');
    });
  });

  it('自动登录清不掉时如实报错，不假装退出成功', async () => {
    // 老版本协议端没有 SetQuickLoginQQ：清不掉自动登录，重启会静默登回去。
    // 这种情况必须明确失败——否则用户看到的是一次"成功"的退出，实际什么都没变。
    await withFake(async (f) => {
      const c = new NapCatWebUI(f.base, TOKEN, log(), { logoutTimeoutMs: 800 });
      f.state.saved = [{ uin: '10001', nick: '一号' }];
      f.state.uin = '10001';
      f.state.noAutoLoginRoute = true;
      f.state.autoLoginUin = '10001';

      await assert.rejects(() => c.logout(), /仍是登录状态/);
    });
  });

  it('协议端连重启接口都没有时，直接说"退不了"，不去等一个不会来的重启', async () => {
    await withFake(async (f) => {
      const c = new NapCatWebUI(f.base, TOKEN, log(), { logoutTimeoutMs: 200 });
      f.state.uin = '10001';
      f.state.noRestartRoute = true;
      await assert.rejects(() => c.logout(), /没有 RestartNapCat 接口/);
    });
  });

  it('快捷登录与退出登录', async () => {
    await withFake(async (f) => {
      const h = await panelWith(f);
      try {
        f.state.saved = [{ uin: '10001', nick: '一号' }];

        const list = await fetch(`${h.base}/api/qq/quick-login`, { headers: { Cookie: h.cookie } });
        assert.deepEqual(await list.json(), { items: [{ uin: '10001', nick: '一号' }] });

        const post = (path: string, body: unknown): Promise<Response> =>
          fetch(`${h.base}${path}`, {
            method: 'POST',
            headers: {
              Cookie: h.cookie,
              'Content-Type': 'application/json',
              'X-CSRF-Token': h.csrf,
            },
            body: JSON.stringify(body),
          });

        assert.equal((await post('/api/qq/quick-login', { uin: '10001' })).status, 200);
        assert.equal(f.state.uin, '10001');

        const empty = await post('/api/qq/quick-login', { uin: '' });
        assert.equal(empty.status, 400);
        assert.deepEqual(await empty.json(), { error: '账号不能为空' });

        assert.equal((await post('/api/qq/logout', {})).status, 200);
        assert.equal(f.state.uin, '');
      } finally {
        await h.stop();
      }
    });
  });

  it('协议端办不成事时给 502 + 原文，不再是「服务器内部错误」', async () => {
    // 这正是本次故障在界面上的样子：NapCat 明明给了一句具体原因（旧代码是
    // "HTTP 404"，因为路由根本不存在），却被 dispatch 的兜底吞成 500。
    await withFake(async (f) => {
      const h = await panelWith(f);
      try {
        f.state.failNextWith = { code: -1, message: '没有可快捷登录的账号 99999' };
        const res = await fetch(`${h.base}/api/qq/quick-login`, {
          method: 'POST',
          headers: {
            Cookie: h.cookie,
            'Content-Type': 'application/json',
            'X-CSRF-Token': h.csrf,
          },
          body: JSON.stringify({ uin: '99999' }),
        });
        assert.equal(res.status, 502);
        assert.deepEqual(await res.json(), { error: '没有可快捷登录的账号 99999' });
      } finally {
        await h.stop();
      }
    });
  });

  it('扫码登录写审计日志', async () => {
    await withFake(async (f) => {
      const h = await panelWith(f);
      try {
        f.state.saved = [{ uin: '10001', nick: '一号' }];
        await fetch(`${h.base}/api/qq/quick-login`, {
          method: 'POST',
          headers: {
            Cookie: h.cookie,
            'Content-Type': 'application/json',
            'X-CSRF-Token': h.csrf,
          },
          body: JSON.stringify({ uin: '10001' }),
        });

        const actions = h.store.audit.list(10).map((a) => a.action);
        assert.ok(actions.includes('qq.quick_login'), `审计里应记录快捷登录: ${actions.join(',')}`);
      } finally {
        await h.stop();
      }
    });
  });
});

// ---- OneBot11 网络配置 ----

describe('NapCat 网络配置（OB11Config）', () => {
  it('读出 { config: {...} } 包装的对象形态', async () => {
    await withFake(async (f) => {
      f.state.uin = '10001';
      const c = new NapCatWebUI(f.base, TOKEN, log());
      const n = await c.networkConfig();

      assert.equal(n.asString, false);
      const net = n.config.network as { websocketServers: { port: number }[] };
      assert.equal(net.websocketServers[0]?.port, 3001);
    });
  });

  it('协议端返回 JSON 文本时解析出来，并记住要用文本回传', async () => {
    await withFake(async (f) => {
      f.state.uin = '10001';
      f.state.networkAsString = true;
      const c = new NapCatWebUI(f.base, TOKEN, log());
      const n = await c.networkConfig();

      assert.equal(n.asString, true);
      assert.ok(n.config.network, '应该已经解析成对象');
    });
  });

  it('协议端直接返回本体（无包装）也能认', async () => {
    await withFake(async (f) => {
      f.state.uin = '10001';
      f.state.networkBare = true;
      f.state.network = { websocketServers: [{ enable: true, port: 3001 }] };
      const c = new NapCatWebUI(f.base, TOKEN, log());
      const n = await c.networkConfig();
      assert.equal(n.asString, false);
      assert.ok(Array.isArray(n.config.websocketServers));
    });
  });

  it('未登录时协议端拒绝，错误原文透出', async () => {
    await withFake(async (f) => {
      const c = new NapCatWebUI(f.base, TOKEN, log());
      await assert.rejects(() => c.networkConfig(), /Not Login/);
    });
  });

  it('保存时按读出来的形态回传（字符串形态）', async () => {
    await withFake(async (f) => {
      f.state.uin = '10001';
      f.state.networkAsString = true;
      const c = new NapCatWebUI(f.base, TOKEN, log());
      const n = await c.networkConfig();

      (n.config.network as { websocketServers: unknown[] }).websocketServers.push({
        name: 'ws2',
        enable: true,
        port: 3002,
      });
      await c.setNetworkConfig(n.config, true);

      const net = f.state.network.network as { websocketServers: { port: number }[] };
      assert.equal(net.websocketServers.length, 2);
      assert.equal(net.websocketServers[1]?.port, 3002);
    });
  });

  // 回归：曾经把配置**当对象**发给 SetConfig，NapCat 那边 String() 成
  // "[object Object]" 再 JSON5.parse，于是报
  //   SyntaxError: JSON5: invalid character 'o' at 1:2
  // 表现是「自动开启反向 WS 失败」。SetConfig 只吃文本，两种读出来的形态都得发文本。
  it('对象形态读出来的配置，回传时也必须是文本', async () => {
    await withFake(async (f) => {
      f.state.uin = '10001';
      const c = new NapCatWebUI(f.base, TOKEN, log());
      const n = await c.networkConfig();
      assert.equal(n.asString, false, '前提：这次是从对象形态读出来的');

      await c.setNetworkConfig(n.config, false);

      assert.equal(f.state.setPayloads.length, 1, '一次就该成功，不该拿对象再撞一次');
      assert.equal(
        typeof f.state.setPayloads[0],
        'string',
        `发给 SetConfig 的 config 必须是文本，实际是 ${typeof f.state.setPayloads[0]}`,
      );
      assert.doesNotThrow(() => JSON.parse(f.state.setPayloads[0] as string));
    });
  });

  it('无包装形态读出来的配置，回传时也必须是文本', async () => {
    await withFake(async (f) => {
      f.state.uin = '10001';
      f.state.networkBare = true;
      f.state.network = { websocketServers: [{ enable: true, port: 3001 }] };
      const c = new NapCatWebUI(f.base, TOKEN, log());
      const n = await c.networkConfig();
      assert.equal(n.asString, false);

      await c.setNetworkConfig(n.config, false);

      assert.equal(typeof f.state.setPayloads[0], 'string');
      const net = f.state.network as { websocketServers: { port: number }[] };
      assert.equal(net.websocketServers[0]?.port, 3001);
    });
  });

  it('文本形态回传失败时不拿对象去撞（错误原样抛出）', async () => {
    await withFake(async (f) => {
      f.state.uin = '10001';
      f.state.networkAsString = true;
      const c = new NapCatWebUI(f.base, TOKEN, log());
      const n = await c.networkConfig();
      // 未登录会让 SetConfig 回 Not Login
      f.state.uin = '';

      await assert.rejects(() => c.setNetworkConfig(n.config, true), /Not Login/);
      assert.equal(f.state.setPayloads.length, 0, '被拒的请求不该留下 payload');
    });
  });
});

describe('面板 /api/qq/network', () => {
  it('已登录时返回配置与 as_string', async () => {
    await withFake(async (f) => {
      f.state.uin = '10001';
      const h = await panelWith(f);
      try {
        const res = await fetch(`${h.base}/api/qq/network`, { headers: { Cookie: h.cookie } });
        assert.equal(res.status, 200);
        const body = (await res.json()) as { config: Record<string, unknown>; as_string: boolean };
        assert.equal(body.as_string, false);
        assert.ok(body.config.network);
      } finally {
        await h.stop();
      }
    });
  });

  it('未登录时返回 502 并带协议端原文', async () => {
    await withFake(async (f) => {
      const h = await panelWith(f);
      try {
        const res = await fetch(`${h.base}/api/qq/network`, { headers: { Cookie: h.cookie } });
        assert.equal(res.status, 502);
        const body = (await res.json()) as { error: string };
        assert.match(body.error, /Not Login/);
      } finally {
        await h.stop();
      }
    });
  });

  it('PUT 保存配置并写审计；非对象入参 400', async () => {
    await withFake(async (f) => {
      f.state.uin = '10001';
      const h = await panelWith(f);
      try {
        const put = (body: unknown): Promise<Response> =>
          fetch(`${h.base}/api/qq/network`, {
            method: 'PUT',
            headers: {
              Cookie: h.cookie,
              'Content-Type': 'application/json',
              'X-CSRF-Token': h.csrf,
            },
            body: JSON.stringify(body),
          });

        const next = {
          network: {
            websocketServers: [{ name: 'ws', enable: true, host: '0.0.0.0', port: 3001 }],
            websocketClients: [{ enable: true, url: 'ws://127.0.0.1:8080' }],
            httpServers: [],
            httpClients: [],
          },
        };
        const r = await put({ config: next, as_string: false });
        assert.equal(r.status, 200);
        assert.deepEqual(await r.json(), { ok: true });

        const saved = f.state.network.network as { websocketClients: unknown[] };
        assert.equal(saved.websocketClients.length, 1);

        const actions = h.store.audit.list(10).map((a) => a.action);
        assert.ok(actions.includes('qq.network_updated'), `审计里应记录: ${actions.join(',')}`);

        // 数组不是合法配置
        assert.equal((await put({ config: [] })).status, 400);
        // 缺少 config 也是 400
        assert.equal((await put({})).status, 400);
      } finally {
        await h.stop();
      }
    });
  });

  it('PUT 缺 CSRF 头时 403', async () => {
    await withFake(async (f) => {
      f.state.uin = '10001';
      const h = await panelWith(f);
      try {
        const res = await fetch(`${h.base}/api/qq/network`, {
          method: 'PUT',
          headers: { Cookie: h.cookie, 'Content-Type': 'application/json' },
          body: JSON.stringify({ config: {} }),
        });
        assert.equal(res.status, 403);
      } finally {
        await h.stop();
      }
    });
  });
});
