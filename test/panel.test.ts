// P2 面板层测试：认证、CSRF、路由语义、设置掩码、SSE。
//
// 这些用例存在的意义不是"覆盖率"，而是把几条一旦改坏就会白屏或
// 把人锁在门外的契约钉死：
//   - cookie 属性（少了 SameSite=Strict 就是 CSRF 漏洞）
//   - 403/401 的中文原文（前端直接 toast 出来）
//   - 405 而不是 404（Go ServeMux 语义，前端有分支依赖）
//   - API Key 掩码格式（含 "****" 才表示"不修改"）
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { PassThrough } from 'node:stream';
import { after, describe, it } from 'node:test';
import { LogHub } from '../src/log/hub';
import { Logger } from '../src/log/logger';
import { hashPassword, newTOTPSecret, totpCode, verifyPassword, verifyTOTP } from '../src/panel/auth';
import { ApprovalQueue } from '../src/bot/computer-approval';
import { normalizeUsername } from '../src/panel/api';
import { assignOnto, clientIP, encodeJSON, pipeFile, type ReqCtx } from '../src/panel/http';
import { PanelServer, splitHostPort as splitHostPortForTest } from '../src/panel/server';
import type { QQLoginPort } from '../src/panel/ports';
import { Store } from '../src/store';

const PASSWORD = 'correct-horse-battery';
/** RFC 6238 附录 B 的测试密钥（ASCII "12345678901234567890" 的 base32）。 */
const TOTP_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const tmpDirs: string[] = [];

after(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

interface Harness {
  base: string;
  store: Store;
  panel: PanelServer;
  /** 注入的待批准队列（传了就与面板共用这一个实例）。 */
  approvals?: ApprovalQueue;
  stop: () => Promise<void>;
}

/** 起一个用完即弃的面板实例。每个用例独立实例，避免登录限流互相干扰。 */
async function harness(
  opts: {
    password?: string;
    totp?: boolean;
    approvals?: ApprovalQueue;
    qq?: QQLoginPort;
    onebotPort?: number;
    onebotAccessToken?: string;
  } = {},
): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-panel-'));
  tmpDirs.push(dir);

  const store = new Store(join(dir, 'qqbot.db'));
  const hash = await hashPassword(opts.password ?? PASSWORD);
  store.settings.update((v) => {
    v.panel.admin_user = 'admin';
    v.panel.password_hash = hash;
    if (opts.totp) {
      v.panel.totp_secret = TOTP_SECRET;
      v.panel.totp_enabled = true;
    }
  });

  const panel = new PanelServer({
    store,
    log: Logger.create({ level: 'error', format: 'text' }),
    hub: new LogHub(50),
    webDir: join(process.cwd(), 'web', 'dist'),
    approvals: opts.approvals,
    qq: opts.qq,
    onebotPort: opts.onebotPort,
    onebotAccessToken: opts.onebotAccessToken,
  });
  const port = await panel.listen('127.0.0.1:0');

  return {
    base: `http://127.0.0.1:${port}`,
    store,
    panel,
    approvals: opts.approvals,
    stop: async () => {
      await panel.close(500);
      store.close();
    },
  };
}

interface Cookies {
  session: string;
  csrf: string;
  header: string;
  setCookie: string[];
}

function cookiesOf(res: Response): Cookies {
  const setCookie = res.headers.getSetCookie();
  const pick = (name: string): string => {
    const line = setCookie.find((c) => c.startsWith(`${name}=`));
    return line ? line.slice(name.length + 1).split(';')[0]! : '';
  };
  const session = pick('qqbot_session');
  const csrf = pick('qqbot_csrf');
  return {
    session,
    csrf,
    header: `qqbot_session=${session}; qqbot_csrf=${csrf}`,
    setCookie,
  };
}

async function login(h: Harness, password = PASSWORD, totp?: string): Promise<Response> {
  return fetch(`${h.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password, ...(totp ? { totp } : {}) }),
  });
}

async function authed(h: Harness): Promise<Cookies> {
  const res = await login(h);
  assert.equal(res.status, 200);
  return cookiesOf(res);
}

// ---- 纯函数 ----

describe('JSON 序列化与 Go 对齐', () => {
  it('不转义 < > &，末尾带换行', () => {
    assert.equal(encodeJSON({ a: '<b>&' }), '{"a":"<b>&"}\n');
  });

  it('转义 U+2028 / U+2029', () => {
    assert.equal(encodeJSON({ a: '\u2028' }), '{"a":"\\u2028"}\n');
    assert.equal(encodeJSON({ a: '\u2029' }), '{"a":"\\u2029"}\n');
  });

  it('Date 输出 RFC3339 本地偏移而不是 ISO UTC', () => {
    const s = encodeJSON({ t: new Date(0) });
    // 1970-01-01T00:00:00Z 在不同时区会得到不同偏移，但绝不能是带毫秒的 .000Z
    assert.ok(!s.includes('.000Z'), `不应带毫秒: ${s}`);
    assert.match(s, /"t":"1970-01-01T\d{2}:00:00(Z|[+-]\d{2}:\d{2})"/);
  });
});

describe('assignOnto 等价于 Go 解码到已有结构体', () => {
  it('只覆盖出现的字段', () => {
    const target = { llm: { model: 'a', base_url: 'u' }, n: 1 };
    assignOnto(target, { llm: { model: 'b' } });
    assert.deepEqual(target, { llm: { model: 'b', base_url: 'u' }, n: 1 });
  });

  it('忽略未知字段', () => {
    const target = { a: 1 };
    assignOnto(target, { a: 2, unknown: 3 });
    assert.deepEqual(target, { a: 2 });
  });

  it('null 不生效', () => {
    const target = { a: 1, b: 'x' };
    assignOnto(target, { a: null, b: null });
    assert.deepEqual(target, { a: 1, b: 'x' });
  });

  it('类型不匹配抛错', () => {
    assert.throws(() => assignOnto({ a: 1 }, { a: 'x' }));
  });
});

describe('客户端 IP 解析', () => {
  const req = (remoteAddress: string, headers: Record<string, string>): ReqCtx['req'] =>
    ({ socket: { remoteAddress }, headers }) as unknown as ReqCtx['req'];

  const TRUST = 'QQBOT_TRUST_FORWARDED';
  /** 临时打开"信任转发头"，跑完恢复原值。 */
  function trusting(fn: () => void): void {
    const old = process.env[TRUST];
    process.env[TRUST] = '1';
    try {
      fn();
    } finally {
      if (old === undefined) delete process.env[TRUST];
      else process.env[TRUST] = old;
    }
  }

  it('公网直连不采信转发头（否则换个头就是一次新的登录尝试）', () => {
    assert.equal(clientIP(req('203.0.113.9', { 'x-forwarded-for': '1.1.1.1' })), '203.0.113.9');
    assert.equal(clientIP(req('::ffff:203.0.113.9', { 'cf-connecting-ip': '1.1.1.1' })), '203.0.113.9');
  });

  it('默认不采信转发头：docker-proxy 会把客户端写的头原样透传', () => {
    // 这是关键回归：对端是网桥地址不能证明"前面有可信代理"。
    // 采信了的话，每个请求换一个 XFF 就是一次新的登录尝试，限流形同虚设。
    assert.equal(
      clientIP(req('172.18.0.1', { 'x-forwarded-for': '1.1.1.1', 'cf-connecting-ip': '1.1.1.1' })),
      '172.18.0.1',
    );
  });

  it('显式开启信任后取转发头最后一跳（最右边才是紧邻的代理写的）', () => {
    trusting(() => {
      assert.equal(clientIP(req('172.18.0.1', { 'x-forwarded-for': '1.1.1.1, 2.2.2.2' })), '2.2.2.2');
      assert.equal(clientIP(req('::ffff:172.18.0.1', { 'x-forwarded-for': '1.1.1.1' })), '1.1.1.1');
      assert.equal(clientIP(req('::1', { 'cf-connecting-ip': '3.3.3.3' })), '3.3.3.3');
      assert.equal(clientIP(req('192.168.1.5', { 'x-forwarded-for': '4.4.4.4' })), '4.4.4.4');
    });
  });

  it('转发头里的非 IP 值被忽略（挡住往审计日志里塞换行）', () => {
    trusting(() => {
      // 最后一跳不是合法 IP 就整个不信，不给"往回找第一个合法值"的机会——
      // 那等于把桶的选择权还给客户端
      assert.equal(clientIP(req('172.18.0.1', { 'x-forwarded-for': '1.1.1.1, evil\n2.2.2.2' })), '172.18.0.1');
      assert.equal(clientIP(req('172.18.0.1', { 'x-forwarded-for': 'not-an-ip' })), '172.18.0.1');
      assert.equal(clientIP(req('172.18.0.1', { 'cf-connecting-ip': 'x\ny' })), '172.18.0.1');
      // 尾部空项（部分代理会留一个逗号）不算非法
      assert.equal(clientIP(req('172.18.0.1', { 'x-forwarded-for': '1.1.1.1, ' })), '1.1.1.1');
    });
  });

  it('没有转发头时用 socket 地址，IPv4 映射形式会被剥前缀', () => {
    assert.equal(clientIP(req('127.0.0.1', {})), '127.0.0.1');
    assert.equal(clientIP(req('::ffff:10.1.2.3', {})), '10.1.2.3');
  });
});

describe('监听地址解析', () => {
  it('支持四种写法', () => {
    assert.deepEqual(splitHostPortForTest('0.0.0.0:5666'), { host: '0.0.0.0', port: 5666 });
    assert.deepEqual(splitHostPortForTest(':5666'), { host: '0.0.0.0', port: 5666 });
    assert.deepEqual(splitHostPortForTest('5666'), { host: '0.0.0.0', port: 5666 });
    assert.deepEqual(splitHostPortForTest('127.0.0.1:0'), { host: '127.0.0.1', port: 0 });
    assert.deepEqual(splitHostPortForTest('[::]:5666'), { host: '::', port: 5666 });
  });
});

describe('argon2id', () => {
  it('PHC 格式为 argon2id$v=19$m=65536,t=3,p=2$...', async () => {
    const h = await hashPassword('abc123def456');
    assert.match(h, /^argon2id\$v=19\$m=65536,t=3,p=2\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/);
    // 参数段本身带 "="，所以要拆开只查 salt/hash 两段
    const parts = h.split('$');
    assert.equal(parts.length, 5);
    assert.ok(!parts[3]!.includes('='), 'salt 应为 RawStdEncoding（无 padding）');
    assert.ok(!parts[4]!.includes('='), 'hash 应为 RawStdEncoding（无 padding）');
  });

  it('正确密码通过、错误密码不通过', async () => {
    const h = await hashPassword('abc123def456');
    assert.equal(await verifyPassword('abc123def456', h), true);
    assert.equal(await verifyPassword('abc123def457', h), false);
  });

  it('格式损坏时返回 false 而不是抛异常', async () => {
    assert.equal(await verifyPassword('x', ''), false);
    assert.equal(await verifyPassword('x', 'argon2i$v=19$m=1,t=1,p=1$a$b'), false);
    assert.equal(await verifyPassword('x', 'argon2id$v=16$m=65536,t=3,p=2$a$b'), false);
  });
});

describe('TOTP (RFC 6238)', () => {
  it('官方测试向量：T=59 应为 287082', () => {
    assert.equal(totpCode(TOTP_SECRET, new Date(59_000)), '287082');
  });

  it('官方测试向量：T=1111111109 应为 081804', () => {
    assert.equal(totpCode(TOTP_SECRET, new Date(1_111_111_109_000)), '081804');
  });

  it('新密钥是 32 位无 padding 的 base32', () => {
    const s = newTOTPSecret();
    assert.match(s, /^[A-Z2-7]{32}$/);
  });

  it('空密钥一律不通过（空 key 的 HMAC 会算出一个稳定的"合法"码）', () => {
    // HMAC 接受空 key：不显式判负的话，库里出现 enabled=true + secret='' 的脏状态
    // 就等于两步验证彻底失效——任何人都能算出那个码。
    assert.equal(verifyTOTP('', '123456'), false);
    assert.equal(verifyTOTP('', totpCode('')), false, '连空密钥算出的码也不能放行');
    assert.equal(verifyTOTP('   ', '123456'), false);
  });
});

// ---- HTTP ----

describe('探活', () => {
  it('GET /healthz 免鉴权返回 ok 与 uptime', async () => {
    const h = await harness();
    try {
      const res = await fetch(`${h.base}/healthz`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        status: string;
        uptime: string;
        version: string;
        commit: string;
        build_date: string;
      };
      assert.equal(body.status, 'ok');
      assert.match(body.uptime, /^\d+[hms]/);
      // 登录页在用户登进来之前就要显示版本，只能读这个免鉴权接口，
      // 所以版本必须和探活一起返回，不能挪到 /api/auth/status 里。
      assert.equal(typeof body.version, 'string');
      assert.ok(body.version !== '', '版本号不能是空串');
      assert.equal(typeof body.commit, 'string');
      assert.equal(typeof body.build_date, 'string');
    } finally {
      await h.stop();
    }
  });
});

describe('登录', () => {
  it('密码错误返回 401 且文案统一', async () => {
    const h = await harness();
    try {
      const res = await login(h, 'wrong-password-xx');
      assert.equal(res.status, 401);
      assert.deepEqual(await res.json(), { error: '用户名或密码错误' });
      assert.equal(cookiesOf(res).session, '', '失败时不应下发会话 cookie');
    } finally {
      await h.stop();
    }
  });

  it('用户名错误与密码错误文案一致（不泄露哪个错）', async () => {
    const h = await harness();
    try {
      const res = await fetch(`${h.base}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: 'nobody', password: PASSWORD }),
      });
      assert.equal(res.status, 401);
      assert.deepEqual(await res.json(), { error: '用户名或密码错误' });
    } finally {
      await h.stop();
    }
  });

  it('成功时下发会话与 CSRF 双 cookie，属性齐全', async () => {
    const h = await harness();
    try {
      const res = await login(h);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true, user: 'admin', totp_enabled: false });

      const c = cookiesOf(res);
      const session = c.setCookie.find((x) => x.startsWith('qqbot_session='))!;
      const csrf = c.setCookie.find((x) => x.startsWith('qqbot_csrf='))!;

      assert.match(session, /HttpOnly/);
      assert.match(session, /SameSite=Strict/);
      assert.match(session, /Max-Age=43200/);
      assert.match(session, /Path=\//);

      // CSRF cookie 必须可被 JS 读取，否则前端拼不出请求头
      assert.doesNotMatch(csrf, /HttpOnly/);
      assert.match(csrf, /SameSite=Strict/);
    } finally {
      await h.stop();
    }
  });

  it('连续失败 5 次后触发 429 限流', async () => {
    const h = await harness();
    try {
      for (let i = 0; i < 5; i++) {
        const r = await login(h, 'bad-password-xx');
        assert.equal(r.status, 401);
      }
      const res = await login(h, 'bad-password-xx');
      assert.equal(res.status, 429);
      const body = (await res.json()) as { error: string };
      assert.match(body.error, /^尝试过于频繁，请 \d+ 分钟后再试$/);
    } finally {
      await h.stop();
    }
  });

  it('开启 TOTP 后必须带正确验证码', async () => {
    const h = await harness({ totp: true });
    try {
      const without = await login(h);
      assert.equal(without.status, 401);
      assert.deepEqual(await without.json(), { error: '动态验证码错误' });

      const wrong = await login(h, PASSWORD, '000000');
      assert.equal(wrong.status, 401);

      const right = await login(h, PASSWORD, totpCode(TOTP_SECRET));
      assert.equal(right.status, 200);
    } finally {
      await h.stop();
    }
  });
});

describe('鉴权与 CSRF', () => {
  it('未登录访问业务接口返回 401 原文', async () => {
    const h = await harness();
    try {
      const res = await fetch(`${h.base}/api/settings`);
      assert.equal(res.status, 401);
      assert.deepEqual(await res.json(), { error: '未登录或会话已过期' });
    } finally {
      await h.stop();
    }
  });

  it('已登录但缺 CSRF 头的写操作返回 403 原文', async () => {
    const h = await harness();
    try {
      const c = await authed(h);
      const res = await fetch(`${h.base}/api/settings`, {
        method: 'PUT',
        headers: { Cookie: c.header, 'Content-Type': 'application/json' },
        body: JSON.stringify({ llm: { model: 'x' } }),
      });
      assert.equal(res.status, 403);
      assert.deepEqual(await res.json(), { error: 'CSRF 校验失败，请刷新页面重试' });
    } finally {
      await h.stop();
    }
  });

  it('CSRF 头与 cookie 不一致也拒绝', async () => {
    const h = await harness();
    try {
      const c = await authed(h);
      const res = await fetch(`${h.base}/api/settings`, {
        method: 'PUT',
        headers: { Cookie: c.header, 'Content-Type': 'application/json', 'X-CSRF-Token': 'nope' },
        body: JSON.stringify({ llm: { model: 'x' } }),
      });
      assert.equal(res.status, 403);
    } finally {
      await h.stop();
    }
  });

  it('伪造会话 cookie 无效', async () => {
    const h = await harness();
    try {
      const res = await fetch(`${h.base}/api/settings`, {
        headers: { Cookie: 'qqbot_session=forged-token' },
      });
      assert.equal(res.status, 401);
    } finally {
      await h.stop();
    }
  });

  it('登出后原会话立即失效', async () => {
    const h = await harness();
    try {
      const c = await authed(h);
      const out = await fetch(`${h.base}/api/auth/logout`, {
        method: 'POST',
        headers: { Cookie: c.header, 'X-CSRF-Token': c.csrf },
      });
      assert.equal(out.status, 200);

      const after = await fetch(`${h.base}/api/settings`, { headers: { Cookie: c.header } });
      assert.equal(after.status, 401);
    } finally {
      await h.stop();
    }
  });

  it('登出也要求 CSRF 令牌（否则任何跨站 POST 都能把人踹下线）', async () => {
    const h = await harness();
    try {
      const c = await authed(h);
      const out = await fetch(`${h.base}/api/auth/logout`, {
        method: 'POST',
        headers: { Cookie: c.header },
      });
      assert.equal(out.status, 403);
      // 会话没被销毁
      const still = await fetch(`${h.base}/api/settings`, { headers: { Cookie: c.header } });
      assert.equal(still.status, 200);
    } finally {
      await h.stop();
    }
  });
});

describe('设置接口', () => {
  it('GET 永不回传明文 Key 与凭据哈希', async () => {
    const h = await harness();
    try {
      h.store.settings.update((v) => {
        v.llm.api_key = 'sk-1234567890abcdef';
      });
      const c = await authed(h);
      const res = await fetch(`${h.base}/api/settings`, { headers: { Cookie: c.header } });
      assert.equal(res.status, 200);
      const body = (await res.json()) as {
        llm: { api_key: string; base_url: string };
        panel: { password_hash: string; totp_secret: string };
      };
      assert.equal(body.llm.api_key, 'sk-1****cdef');
      assert.equal(body.panel.password_hash, '');
      assert.equal(body.panel.totp_secret, '');
      assert.ok(body.llm.base_url !== '');
    } finally {
      await h.stop();
    }
  });

  it('短 Key 全掩码', async () => {
    const h = await harness();
    try {
      h.store.settings.update((v) => {
        v.llm.api_key = 'short';
      });
      const c = await authed(h);
      const body = (await (await fetch(`${h.base}/api/settings`, { headers: { Cookie: c.header } })).json()) as {
        llm: { api_key: string };
      };
      assert.equal(body.llm.api_key, '****');
    } finally {
      await h.stop();
    }
  });

  it('PUT 局部字段不清空其余字段', async () => {
    const h = await harness();
    try {
      h.store.settings.update((v) => {
        v.llm.api_key = 'sk-1234567890abcdef';
        v.llm.base_url = 'https://api.example.com';
      });
      const c = await authed(h);
      const res = await fetch(`${h.base}/api/settings`, {
        method: 'PUT',
        headers: { Cookie: c.header, 'Content-Type': 'application/json', 'X-CSRF-Token': c.csrf },
        body: JSON.stringify({ llm: { model: 'deepseek-chat' } }),
      });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { llm: { model: string; base_url: string; api_key: string } };
      assert.equal(body.llm.model, 'deepseek-chat');
      assert.equal(body.llm.base_url, 'https://api.example.com', '未提交的字段必须保留');
      assert.equal(body.llm.api_key, 'sk-1****cdef', '未提交的 Key 必须保留');
    } finally {
      await h.stop();
    }
  });

  it('提交掩码表示不修改 Key', async () => {
    const h = await harness();
    try {
      h.store.settings.update((v) => {
        v.llm.api_key = 'sk-1234567890abcdef';
      });
      const c = await authed(h);
      const res = await fetch(`${h.base}/api/settings`, {
        method: 'PUT',
        headers: { Cookie: c.header, 'Content-Type': 'application/json', 'X-CSRF-Token': c.csrf },
        body: JSON.stringify({ llm: { api_key: 'sk-1****cdef' } }),
      });
      assert.equal(res.status, 200);
      assert.equal(h.store.settings.get().llm.api_key, 'sk-1234567890abcdef');
    } finally {
      await h.stop();
    }
  });

  it('校验失败返回中文原文', async () => {
    const h = await harness();
    try {
      const c = await authed(h);
      const put = (body: unknown): Promise<Response> =>
        fetch(`${h.base}/api/settings`, {
          method: 'PUT',
          headers: { Cookie: c.header, 'Content-Type': 'application/json', 'X-CSRF-Token': c.csrf },
          body: JSON.stringify(body),
        });

      const cases: [unknown, string][] = [
        [{ llm: { base_url: '' } }, '模型地址不能为空'],
        [{ llm: { base_url: 'ftp://x' } }, '模型地址必须以 http(s):// 开头'],
        [{ llm: { base_url: '不是网址' } }, '模型地址不是合法的 URL'],
        // SSRF：地址会带着真实 API Key 一起被请求，链路本地/元数据地址一律拒
        [
          { llm: { base_url: 'http://169.254.169.254/latest/meta-data/' } },
          '模型地址不能指向链路本地或云元数据地址',
        ],
        [
          { llm: { base_url: 'http://[::ffff:169.254.169.254]/' } },
          '模型地址不能指向链路本地或云元数据地址',
        ],
        [{ llm: { model: '' } }, '模型名称不能为空'],
        [{ llm: { max_tokens: 99999 } }, '最大输出 token 应在 1-8192 之间'],
        [{ llm: { timeout_sec: 0 } }, '超时时间应在 1-300 秒之间'],
        [{ bot: { passive_rate: 2 } }, '被动接话概率应在 0-1 之间'],
        [{ bot: { max_concurrent: 0 } }, '并发数应在 1-10 之间'],
        [{ bot: { max_segments: 9 } }, '最大分段数应在 1-8 之间'],
        [{ context: { max_turns: 51 } }, '上下文轮数应在 0-50 之间'],
        [{ context: { token_budget: 100 } }, '上下文 token 预算应在 200-100000 之间'],
        // 名单只校验"是不是数组"是不够的：字符串数组能存进去，
        // 但引擎拿 number 去 includes，白名单/黑名单会静默失效
        [{ bot: { whitelist_groups: ['30000'] } }, '群白名单只能填正整数群号'],
        [{ bot: { blacklist_users: ['20000'] } }, '用户黑名单只能填正整数 QQ 号'],
        [{ bot: { wake_words: [123] } }, '唤醒词只能是文本'],
        [{ vision: { max_images: 5 } }, '单条消息识图上限应在 1-4 张之间'],
        // 电脑操作：范围、路径形态、以及"开了却没人能用"这种语义错
        [{ computer: { timeout_sec: 99 } }, '命令超时应在 1-60 秒之间'],
        [{ computer: { max_calls: 9 } }, '每条消息最多执行几次应在 1-5 之间'],
        [{ computer: { approval_timeout_sec: 10 } }, '批准等待应在 30-300 秒之间'],
        [{ computer: { workdir: 'data' } }, '工作目录要填绝对路径（以 / 开头）'],
        [{ computer: { owner_qq: -1 } }, '主人 QQ 只能填正整数'],
        [{ computer: { allow_users: ['10001'] } }, '允许的好友只能填正整数 QQ 号'],
        [{ computer: { allow_groups: [0] } }, '允许的群只能填正整数群号'],
        [{ computer: { enabled: true } }, '开启前至少要填主人 QQ 或一个白名单好友/群'],
      ];
      for (const [body, msg] of cases) {
        const res = await put(body);
        assert.equal(res.status, 400, JSON.stringify(body));
        assert.deepEqual(await res.json(), { error: msg });
      }
    } finally {
      await h.stop();
    }
  });
});

describe('路由语义（对齐 Go ServeMux）', () => {
  it('路径存在但方法不对返回 405 并带 Allow', async () => {
    const h = await harness();
    try {
      const res = await fetch(`${h.base}/api/settings`, { method: 'DELETE' });
      assert.equal(res.status, 405);
      assert.equal(res.headers.get('allow'), 'GET, HEAD, PUT');
    } finally {
      await h.stop();
    }
  });

  it('未注册路径的 GET 落到 SPA 兜底（200 + html）', async () => {
    const h = await harness();
    try {
      const res = await fetch(`${h.base}/api/does-not-exist`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    } finally {
      await h.stop();
    }
  });

  it('未注册路径的非 GET 返回 405', async () => {
    const h = await harness();
    try {
      const res = await fetch(`${h.base}/api/does-not-exist`, { method: 'POST' });
      assert.equal(res.status, 405);
      assert.equal(res.headers.get('allow'), 'GET, HEAD');
    } finally {
      await h.stop();
    }
  });

  it('HEAD 与 GET 等价且无响应体', async () => {
    const h = await harness();
    try {
      const res = await fetch(`${h.base}/healthz`, { method: 'HEAD' });
      assert.equal(res.status, 200);
      assert.equal(await res.text(), '');
    } finally {
      await h.stop();
    }
  });

  it('静态资源与安全响应头', async () => {
    const h = await harness();
    try {
      const res = await fetch(`${h.base}/app.js`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') ?? '', /application\/javascript/);
      assert.equal(res.headers.get('cache-control'), 'no-cache');
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
      assert.equal(res.headers.get('x-frame-options'), 'SAMEORIGIN');
      assert.equal(res.headers.get('referrer-policy'), 'no-referrer');
      const csp = res.headers.get('content-security-policy') ?? '';
      assert.match(csp, /default-src 'self'/);
      assert.match(csp, /img-src 'self' data:/);
    } finally {
      await h.stop();
    }
  });

  it('目录穿越不会泄露任意文件', async () => {
    const h = await harness();
    try {
      const res = await fetch(`${h.base}/../../../../etc/passwd`);
      // 要么被 URL 规范化，要么回 SPA；绝不能返回 passwd 内容
      const text = await res.text();
      assert.ok(!text.includes('root:x:'), '不应读到系统文件');
    } finally {
      await h.stop();
    }
  });
});

describe('请求入口健壮性', () => {
  it('畸形的请求行不会让进程退出，服务仍可用', async () => {
    const h = await harness();
    try {
      // Node 的 llhttp 接受 "//[" 这种 request-target，但 new URL 解析会抛
      // ERR_INVALID_URL。这条路径在鉴权之前，任何人一条请求就能触发。
      const raw = await new Promise<string>((resolve, reject) => {
        const sock = net.connect(Number(new URL(h.base).port), '127.0.0.1', () => {
          sock.write('GET //[ HTTP/1.1\r\nHost: x\r\n\r\n');
        });
        let buf = '';
        sock.setEncoding('utf8');
        sock.on('data', (d: string) => {
          buf += d;
        });
        sock.on('error', reject);
        sock.on('close', () => resolve(buf));
        setTimeout(() => sock.destroy(), 2000);
      });
      assert.match(raw, /HTTP\/1\.1 400/, '畸形地址应当被当成 400 处理，而不是抛异常');

      // 进程还活着：后面的正常请求照旧能通
      const res = await fetch(`${h.base}/healthz`);
      assert.equal(res.status, 200);
    } finally {
      await h.stop();
    }
  });

  it('静态文件在 stat 之后消失只断连接，不抛未捕获异常', async () => {
    const h = await harness();
    try {
      const res = await fetch(`${h.base}/app.js`);
      assert.equal(res.status, 200);
      await res.text();
    } finally {
      await h.stop();
    }
    // pipeFile 对不存在的路径：只触发 error → destroy，不冒泡成未捕获异常
    const fake = new PassThrough();
    let destroyed = false;
    fake.destroy = (() => {
      destroyed = true;
      return fake;
    }) as typeof fake.destroy;
    pipeFile(fake as unknown as Parameters<typeof pipeFile>[0], join(tmpdir(), 'qqbot-does-not-exist-12345.bin'));
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(destroyed, true, '读流报错时应断掉这条连接');
  });
});

describe('日志 SSE', () => {
  it('先补发历史日志，再推送新日志，并有心跳格式', async () => {
    const h = await harness();
    try {
      const c = await authed(h);
      h.panel.hub.push({ time: '2024-01-01T00:00:00Z', level: 'INFO', msg: '历史一' });

      const ctrl = new AbortController();
      const res = await fetch(`${h.base}/api/logs`, {
        headers: { Cookie: c.header },
        signal: ctrl.signal,
      });
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') ?? '', /text\/event-stream/);
      assert.equal(res.headers.get('x-accel-buffering'), 'no');

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      const readUntil = async (needle: string): Promise<void> => {
        while (!buf.includes(needle)) {
          const { value, done } = await reader.read();
          if (done) return;
          buf += decoder.decode(value, { stream: true });
        }
      };

      await readUntil('历史一');
      assert.match(buf, /^data: \{"time":"2024-01-01T00:00:00Z","level":"INFO","msg":"历史一"\}\n\n/);

      h.panel.hub.push({ time: '2024-01-01T00:00:01Z', level: 'WARN', msg: '实时二' });
      await readUntil('实时二');
      assert.match(buf, /data: \{"time":"2024-01-01T00:00:01Z","level":"WARN","msg":"实时二"\}/);

      ctrl.abort();
    } finally {
      await h.stop();
    }
  });
});

describe('会话与用量接口', () => {
  it('会话列表与消息查询', async () => {
    const h = await harness();
    try {
      h.store.sessions.touch('group:1', 'group', 1, '摸鱼群');
      h.store.sessions.append('group:1', 'user', '你好', 0);
      h.store.sessions.append('group:1', 'assistant', '你好呀', 0);

      const c = await authed(h);
      const list = (await (
        await fetch(`${h.base}/api/sessions`, { headers: { Cookie: c.header } })
      ).json()) as { items: { id: string; messages: number; name?: string }[] };
      assert.equal(list.items.length, 1);
      assert.equal(list.items[0]!.id, 'group:1');
      assert.equal(list.items[0]!.messages, 2);
      // 名字要跟着回给前端，面板那一列才能显示「摸鱼群」而不是 group:1
      assert.equal(list.items[0]!.name, '摸鱼群');

      const msgs = (await (
        await fetch(`${h.base}/api/sessions/messages?id=group%3A1`, { headers: { Cookie: c.header } })
      ).json()) as { items: { role: string; content: string }[] };
      assert.deepEqual(
        msgs.items.map((m) => m.content),
        ['你好', '你好呀'],
      );

      const bad = await fetch(`${h.base}/api/sessions/messages`, { headers: { Cookie: c.header } });
      assert.equal(bad.status, 400);
      assert.deepEqual(await bad.json(), { error: '会话 ID 不能为空' });
    } finally {
      await h.stop();
    }
  });

  it('会话人格绑定：列表回带绑定，未绑定时给全局默认，解绑后回落', async () => {
    const h = await harness();
    try {
      h.store.sessions.touch('private:1', 'private', 1);
      h.store.sessions.touch('group:2', 'group', 2);
      const coder = h.store.personas.upsert('coder', 'you write code');

      const c = await authed(h);
      const list = async () =>
        (await (
          await fetch(`${h.base}/api/sessions`, { headers: { Cookie: c.header } })
        ).json()) as {
          items: { id: string; persona_id: number; persona_name: string }[];
          default_persona: { id: number; name: string };
        };
      const bind = (payload: unknown): Promise<Response> =>
        fetch(`${h.base}/api/sessions/persona`, {
          method: 'POST',
          headers: { Cookie: c.header, 'Content-Type': 'application/json', 'X-CSRF-Token': c.csrf },
          body: JSON.stringify(payload),
        });

      // 初始：全部跟随全局默认
      const before = await list();
      assert.equal(before.default_persona.name, 'default');
      assert.ok(before.items.every((s) => s.persona_id === 0 && s.persona_name === ''));

      assert.equal((await bind({ id: 'private:1', persona_id: coder.id })).status, 200);

      const after = await list();
      const one = after.items.find((s) => s.id === 'private:1');
      assert.equal(one?.persona_id, coder.id);
      assert.equal(one?.persona_name, 'coder');
      assert.equal(after.items.find((s) => s.id === 'group:2')?.persona_id, 0, '别的会话不受影响');

      // 0 = 解除绑定
      assert.equal((await bind({ id: 'private:1', persona_id: 0 })).status, 200);
      assert.equal((await list()).items.find((s) => s.id === 'private:1')?.persona_id, 0);

      // 非法输入
      const noPersona = await bind({ id: 'private:1', persona_id: 99999 });
      assert.equal(noPersona.status, 400);
      assert.deepEqual(await noPersona.json(), { error: '人格不存在' });
      const noId = await bind({ id: '  ', persona_id: coder.id });
      assert.equal(noId.status, 400);
      assert.deepEqual(await noId.json(), { error: '会话 ID 不能为空' });
      const badPid = await bind({ id: 'private:1', persona_id: -3 });
      assert.equal(badPid.status, 400);
      assert.deepEqual(await badPid.json(), { error: '人格 ID 不合法' });
      // 字符串数字不能被当成 0（那会静默变成"解绑"）
      const strPid = await bind({ id: 'private:1', persona_id: '3' });
      assert.equal(strPid.status, 400);
      assert.deepEqual(await strPid.json(), { error: '人格 ID 不合法' });

      // 未登录不能改
      const anon = await fetch(`${h.base}/api/sessions/persona`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'private:1', persona_id: coder.id }),
      });
      assert.equal(anon.status, 401);
    } finally {
      await h.stop();
    }
  });

  it('预设人格：还没说过话的群也能绑，列表里带名字显示', async () => {
    const h = await harness();
    try {
      const c = await authed(h);
      const coder = h.store.personas.upsert('coder', 'you write code');
      const bind = (payload: unknown): Promise<Response> =>
        fetch(`${h.base}/api/sessions/persona`, {
          method: 'POST',
          headers: { Cookie: c.header, 'Content-Type': 'application/json', 'X-CSRF-Token': c.csrf },
          body: JSON.stringify(payload),
        });
      const list = async () =>
        (await (
          await fetch(`${h.base}/api/sessions`, { headers: { Cookie: c.header } })
        ).json()) as {
          items: {
            id: string;
            kind: string;
            target_id: number;
            messages: number;
            persona_id: number;
            persona_name: string;
            name?: string;
            preset?: boolean;
          }[];
        };

      // 一条消息都没有：sessions 是空的
      assert.equal((await list()).items.length, 0);

      assert.equal(
        (await bind({ id: 'group:987654321', persona_id: coder.id, name: '夜猫子群' })).status,
        200,
      );

      // 补出来的预设行：有名字、有 kind、有目标号，能直接喂给表格渲染
      const row = (await list()).items.find((s) => s.id === 'group:987654321');
      assert.equal(row?.preset, true);
      assert.equal(row?.name, '夜猫子群');
      assert.equal(row?.kind, 'group');
      assert.equal(row?.target_id, 987654321);
      assert.equal(row?.messages, 0);
      assert.equal(row?.persona_name, 'coder');

      // 真的来过消息之后，它变成普通会话行，绑定继续生效，且不会出现两行
      h.store.sessions.touch('group:987654321', 'group', 987654321);
      const items = (await list()).items.filter((s) => s.id === 'group:987654321');
      assert.equal(items.length, 1);
      assert.equal(items[0]!.preset, undefined);
      assert.equal(items[0]!.persona_id, coder.id);
      // 名字快照要跟着走：说过话之后那一行不能突然从「夜猫子群」变回号码
      assert.equal(items[0]!.name, '夜猫子群');

      // kind 只从 id 前缀推导，入参里塞一个矛盾的 kind 也不会被采信
      assert.equal(
        (await bind({ id: 'group:5', persona_id: coder.id, kind: 'private' })).status,
        200,
      );
      assert.equal((await list()).items.find((s) => s.id === 'group:5')?.kind, 'group');

      // name 不是字符串时按"没有名字"处理，而不是存成 "123"
      assert.equal((await bind({ id: 'private:5', persona_id: coder.id, name: 123 })).status, 200);
      assert.equal((await list()).items.find((s) => s.id === 'private:5')?.name, '');

      // ID 格式错了要当场拒绝：绑进去就是一条永远匹配不上的行
      for (const id of ['家庭群', 'group:abc', 'friend:12', 'group:', 'group:0']) {
        const r = await bind({ id, persona_id: coder.id });
        assert.equal(r.status, 400, `应拒绝 ${id}`);
        assert.deepEqual(await r.json(), { error: '会话 ID 格式应为 group:群号 或 private:QQ号' });
      }

      // 解绑后预设行从列表里消失
      assert.equal((await bind({ id: 'group:987654321', persona_id: 0 })).status, 200);
      const after = (await list()).items.find((s) => s.id === 'group:987654321');
      // 此时它已经有会话行了（上面 touch 过），所以只是人格回到跟随默认
      assert.equal(after?.persona_id, 0);
    } finally {
      await h.stop();
    }
  });

  it('用量接口默认 7 天且 today 恒为对象', async () => {
    const h = await harness();
    try {
      const c = await authed(h);
      const body = (await (
        await fetch(`${h.base}/api/usage`, { headers: { Cookie: c.header } })
      ).json()) as { today: { requests: number }; items: unknown[] };
      assert.equal(body.today.requests, 0);
      assert.ok(Array.isArray(body.items));
    } finally {
      await h.stop();
    }
  });

  it('人格列表初始即有一个激活的默认人格', async () => {
    const h = await harness();
    try {
      const c = await authed(h);
      const body = (await (
        await fetch(`${h.base}/api/personas`, { headers: { Cookie: c.header } })
      ).json()) as { items: { name: string }[]; active: { name: string; active: boolean } };
      assert.equal(body.items.length, 1);
      assert.equal(body.active.name, 'default');
      assert.equal(body.active.active, true);
    } finally {
      await h.stop();
    }
  });

  it('总览字段齐全（未接协议端时为离线）', async () => {
    const h = await harness();
    try {
      const c = await authed(h);
      const body = (await (
        await fetch(`${h.base}/api/overview`, { headers: { Cookie: c.header } })
      ).json()) as Record<string, unknown>;
      for (const k of [
        'uptime',
        'self_id',
        'nickname',
        'connected',
        'online',
        'connected_at',
        'last_event_at',
        'reconnects',
        'last_error',
        'stats',
        'usage_today',
        'model',
        'totp_enabled',
        'dedupe_size',
      ]) {
        assert.ok(Object.hasOwn(body, k), `缺少字段 ${k}`);
      }
      assert.equal(body.connected, false);
      assert.equal(body.online, false);
      assert.equal(body.connected_at, '0001-01-01T00:00:00Z');
      assert.deepEqual(body.stats, {
        received: 0,
        replied: 0,
        ignored: 0,
        dropped: 0,
        errors: 0,
        last_reply_at: '0001-01-01T00:00:00Z',
      });
    } finally {
      await h.stop();
    }
  });
});

describe('密码与 TOTP 管理接口', () => {
  it('新密码不足 12 位被拒', async () => {
    const h = await harness();
    try {
      const c = await authed(h);
      const res = await fetch(`${h.base}/api/auth/password`, {
        method: 'POST',
        headers: { Cookie: c.header, 'Content-Type': 'application/json', 'X-CSRF-Token': c.csrf },
        body: JSON.stringify({ old: PASSWORD, new: 'short' }),
      });
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error: '新密码至少 12 位' });
    } finally {
      await h.stop();
    }
  });

  it('原密码错误被拒', async () => {
    const h = await harness();
    try {
      const c = await authed(h);
      const res = await fetch(`${h.base}/api/auth/password`, {
        method: 'POST',
        headers: { Cookie: c.header, 'Content-Type': 'application/json', 'X-CSRF-Token': c.csrf },
        body: JSON.stringify({ old: 'not-the-password', new: 'a-very-long-password' }),
      });
      assert.equal(res.status, 401);
      assert.deepEqual(await res.json(), { error: '原密码错误' });
    } finally {
      await h.stop();
    }
  });

  it('改密后新密码可登录、旧密码失效', async () => {
    const h = await harness();
    try {
      const c = await authed(h);
      const res = await fetch(`${h.base}/api/auth/password`, {
        method: 'POST',
        headers: { Cookie: c.header, 'Content-Type': 'application/json', 'X-CSRF-Token': c.csrf },
        body: JSON.stringify({ old: PASSWORD, new: 'a-very-long-password' }),
      });
      assert.equal(res.status, 200);

      assert.equal((await login(h, PASSWORD)).status, 401);
      assert.equal((await login(h, 'a-very-long-password')).status, 200);
    } finally {
      await h.stop();
    }
  });

  it('改密会踢掉其他设备，只留当前会话', async () => {
    const h = await harness();
    try {
      // 两台"设备"各自登录
      const a = await authed(h);
      const b = await authed(h);

      const res = await fetch(`${h.base}/api/auth/password`, {
        method: 'POST',
        headers: { Cookie: a.header, 'Content-Type': 'application/json', 'X-CSRF-Token': a.csrf },
        body: JSON.stringify({ old: PASSWORD, new: 'a-very-long-password' }),
      });
      assert.equal(res.status, 200);
      const out = (await res.json()) as { revoked: number };
      assert.equal(out.revoked, 1, '应吊销另一条会话');

      // 当前设备还能用，另一台立刻 401——会话有效期 12 小时，
      // 不主动清掉的话攻击者改完密码还能继续用半天
      assert.equal((await fetch(`${h.base}/api/settings`, { headers: { Cookie: a.header } })).status, 200);
      assert.equal((await fetch(`${h.base}/api/settings`, { headers: { Cookie: b.header } })).status, 401);
    } finally {
      await h.stop();
    }
  });

  it('TOTP setup → enable → 登录需要验证码 → disable', async () => {
    const h = await harness();
    try {
      const c = await authed(h);
      const call = (path: string, body?: unknown): Promise<Response> =>
        fetch(`${h.base}${path}`, {
          method: 'POST',
          headers: { Cookie: c.header, 'Content-Type': 'application/json', 'X-CSRF-Token': c.csrf },
          body: JSON.stringify(body ?? {}),
        });

      const setup = (await (await call('/api/auth/totp/setup')).json()) as {
        secret: string;
        url: string;
      };
      assert.match(setup.secret, /^[A-Z2-7]{32}$/);
      assert.match(setup.url, /^otpauth:\/\/totp\/qqbot:admin\?secret=[A-Z2-7]+&issuer=qqbot/);

      const bad = await call('/api/auth/totp/enable', { code: '000000' });
      assert.equal(bad.status, 400);
      assert.deepEqual(await bad.json(), { error: '验证码不正确' });

      const good = await call('/api/auth/totp/enable', { code: totpCode(setup.secret) });
      assert.equal(good.status, 200);
      assert.equal(h.store.settings.get().panel.totp_enabled, true);

      // 启用后无验证码登录失败
      assert.equal((await login(h)).status, 401);
      assert.equal((await login(h, PASSWORD, totpCode(setup.secret))).status, 200);

      const off = await call('/api/auth/totp/disable', { code: totpCode(setup.secret) });
      assert.equal(off.status, 200);
      assert.equal(h.store.settings.get().panel.totp_enabled, false);
      assert.equal(h.store.settings.get().panel.totp_secret, '');
    } finally {
      await h.stop();
    }
  });

  it('已开启两步验证时，重新生成密钥必须先过验证码（否则等于绕过关闭二步的门）', async () => {
    const h = await harness({ totp: true });
    try {
      const c = cookiesOf(await login(h, PASSWORD, totpCode(TOTP_SECRET)));
      const call = (body?: unknown): Promise<Response> =>
        fetch(`${h.base}/api/auth/totp/setup`, {
          method: 'POST',
          headers: { Cookie: c.header, 'Content-Type': 'application/json', 'X-CSRF-Token': c.csrf },
          body: JSON.stringify(body ?? {}),
        });

      // 不带验证码、验证码错误，都不能把 totp_enabled 关掉
      for (const body of [undefined, { code: '' }, { code: '000000' }]) {
        const res = await call(body);
        assert.equal(res.status, 400, JSON.stringify(body));
        assert.deepEqual(await res.json(), { error: '验证码不正确' });
        assert.equal(h.store.settings.get().panel.totp_enabled, true, '不能悄悄关掉二步验证');
      }

      const ok = await call({ code: totpCode(TOTP_SECRET) });
      assert.equal(ok.status, 200);
      assert.equal(h.store.settings.get().panel.totp_enabled, false);
    } finally {
      await h.stop();
    }
  });
});

describe('用户名修改', () => {
  /** 用指定名字登录（login() 里写死了 admin）。 */
  const loginAs = (h: Harness, username: string, password = PASSWORD): Promise<Response> =>
    fetch(`${h.base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });

  const rename = (h: Harness, c: Cookies, payload: unknown): Promise<Response> =>
    fetch(`${h.base}/api/auth/username`, {
      method: 'POST',
      headers: { Cookie: c.header, 'Content-Type': 'application/json', 'X-CSRF-Token': c.csrf },
      body: JSON.stringify(payload),
    });

  it('规范化：去空白、按码点算长度、挡掉危险的字符', () => {
    assert.equal(normalizeUsername('  alice  '), 'alice');
    assert.equal(normalizeUsername('阿绫'), '阿绫');
    // emoji 是代理对，按 UTF-16 长度会被误判成 2 个字符
    assert.equal(normalizeUsername('ab😀'), 'ab😀');

    assert.throws(() => normalizeUsername('   '), /用户名不能为空/);
    assert.throws(() => normalizeUsername('a'), /2-32/);
    assert.throws(() => normalizeUsername('x'.repeat(33)), /2-32/);
    assert.throws(() => normalizeUsername('a b'), /不能包含空格/);
    assert.throws(() => normalizeUsername('a\u0000b'), /不可见字符/);
    assert.throws(() => normalizeUsername('a/b'), /不能包含/);
    assert.throws(() => normalizeUsername('a:b'), /不能包含/);
  });

  it('需要 CSRF 令牌', async () => {
    const h = await harness();
    try {
      const c = await authed(h);
      const res = await fetch(`${h.base}/api/auth/username`, {
        method: 'POST',
        headers: { Cookie: c.header, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: 'alice', password: PASSWORD }),
      });
      assert.equal(res.status, 403);
    } finally {
      await h.stop();
    }
  });

  it('密码错被拒，用户名不变', async () => {
    const h = await harness();
    try {
      const c = await authed(h);
      const res = await rename(h, c, { name: 'alice', password: 'not-the-password' });
      assert.equal(res.status, 401);
      assert.deepEqual(await res.json(), { error: '当前密码错误' });
      assert.equal(h.store.settings.get().panel.admin_user, 'admin');
    } finally {
      await h.stop();
    }
  });

  it('改成同名被拒', async () => {
    const h = await harness();
    try {
      const c = await authed(h);
      const res = await rename(h, c, { name: 'admin', password: PASSWORD });
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), { error: '新用户名与当前相同' });
    } finally {
      await h.stop();
    }
  });

  it('改名成功：旧名登录失效、新名可登录、当前会话不用重登', async () => {
    const h = await harness();
    try {
      const c = await authed(h);
      const res = await rename(h, c, { name: 'alice', password: PASSWORD });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true, user: 'alice' });
      assert.equal(h.store.settings.get().panel.admin_user, 'alice');

      // 会话里的 user 是快照，改名时必须一起换，否则侧栏一直显示旧名
      const st = await fetch(`${h.base}/api/auth/status`, { headers: { Cookie: c.header } });
      assert.equal(st.status, 200);
      assert.equal(((await st.json()) as { user: string }).user, 'alice');

      assert.equal((await loginAs(h, 'admin')).status, 401);
      assert.equal((await loginAs(h, 'alice')).status, 200);
    } finally {
      await h.stop();
    }
  });

  it('中文用户名可用，otpauth 标签被正确转义', async () => {
    const h = await harness();
    try {
      const c = await authed(h);
      const res = await rename(h, c, { name: '名字', password: PASSWORD });
      assert.equal(res.status, 200);

      const setup = await fetch(`${h.base}/api/auth/totp/setup`, {
        method: 'POST',
        headers: { Cookie: c.header, 'X-CSRF-Token': c.csrf },
      });
      const data = (await setup.json()) as { url: string };
      // 非 ASCII 不转义的话，验证器里会显示成乱码标签
      assert.match(data.url, /^otpauth:\/\/totp\/qqbot:%E5%90%8D%E5%AD%97\?/);
    } finally {
      await h.stop();
    }
  });
});

describe('协议端原生界面已移除', () => {
  // 反代一旦被"顺手"加回来，等于把 NapCat 的整套管理权限挂到面板后面，
  // 所以把这两条钉成契约：/webui 与未注册的 /api/* 都不能再转给协议端。
  it('/webui 不再反代，只会落到面板自己的单页应用', async () => {
    const h = await harness();
    try {
      const c = await authed(h);
      const res = await fetch(`${h.base}/webui/`, { headers: { Cookie: c.header } });
      const body = await res.text();
      // 未命中的路径回 index.html（SPA 兜底），但绝不能是 NapCat 的界面
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') ?? '', /text\/html/);
      assert.match(body, /qqbot 控制台/);
      assert.ok(!/napcat/i.test(body), '不应再出现 NapCat 的页面');
    } finally {
      await h.stop();
    }
  });

  it('协议端自己的 /api/QQLogin/* 不再被转发', async () => {
    const h = await harness();
    try {
      const c = await authed(h);
      // 面板没注册这个路径 → 走 SPA 兜底，而不是转给 NapCat 拿 code:0
      const res = await fetch(`${h.base}/api/QQLogin/CheckLoginStatus`, {
        headers: { Cookie: c.header },
      });
      assert.match(res.headers.get('content-type') ?? '', /text\/html/);
      const body = await res.text();
      assert.ok(!body.includes('"code"'), '不应透出协议端的 JSON 响应');
    } finally {
      await h.stop();
    }
  });
});

describe('自动补反向 WS 的触发时机', () => {
  /**
   * 造一个"已登录"的协议端桩，记录它被写了几次网络配置。
   *
   * 这条契约值得钉死的原因是 GET 语义：状态接口被前端轮询、被浏览器预取、
   * 被爬虫扫到都会执行，一旦它顺手改协议端配置，等于任何一次页面加载
   * 都在重启 OneBot 服务。
   */
  function qqStub(): { port: QQLoginPort; writes: string[] } {
    const writes: string[] = [];
    const port: QQLoginPort = {
      configured: true,
      status: () =>
        Promise.resolve({
          login: true,
          offline: false,
          uin: '10001',
          nick: 'bot',
          phase: '',
          error: '',
        }),
      qrcode: () =>
        Promise.resolve({ image: '', content: '', logined: true, stale: false }),
      loginInfo: () => Promise.resolve({ uin: '10001', nick: 'bot' }),
      quickLoginList: () => Promise.resolve([]),
      quickLogin: () => Promise.resolve(),
      logout: () => Promise.resolve(),
      networkConfig: () => Promise.resolve({ config: { network: {} }, asString: false }),
      setNetworkConfig: (cfg) => {
        writes.push(JSON.stringify(cfg));
        return Promise.resolve();
      },
    };
    return { port, writes };
  }

  it('GET /api/qq/status 只读状态，不写协议端配置', async () => {
    const stub = qqStub();
    const h = await harness({ qq: stub.port, onebotPort: 3001 });
    try {
      const c = await authed(h);
      for (let i = 0; i < 3; i++) {
        const res = await fetch(`${h.base}/api/qq/status`, { headers: { Cookie: c.header } });
        assert.equal(res.status, 200);
      }
      // 补 WS 是异步的，等一拍再断言"确实一次都没写"
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(stub.writes.length, 0);
    } finally {
      await h.stop();
    }
  });

  it('后台 tick 仍会把反向 WS 补上，并带上 access token', async () => {
    const stub = qqStub();
    const h = await harness({
      qq: stub.port,
      onebotPort: 3001,
      onebotAccessToken: 'panel-token',
    });
    try {
      await h.panel.tick();
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(stub.writes.length, 1);
      assert.match(stub.writes[0]!, /panel-token/);
      assert.match(stub.writes[0]!, /"port":3001/);
    } finally {
      await h.stop();
    }
  });
});

describe('协议端未连接时的行为', () => {
  it('群列表拉取失败返回 502 并带原始错误', async () => {
    const h = await harness();
    try {
      const c = await authed(h);
      const res = await fetch(`${h.base}/api/groups`, { headers: { Cookie: c.header } });
      assert.equal(res.status, 502);
      const body = (await res.json()) as { error: string };
      assert.match(body.error, /^拉取群列表失败：/);
    } finally {
      await h.stop();
    }
  });

  it('测试发送要求目标类型合法', async () => {
    const h = await harness();
    try {
      const c = await authed(h);
      const post = (body: unknown): Promise<Response> =>
        fetch(`${h.base}/api/test/send`, {
          method: 'POST',
          headers: { Cookie: c.header, 'Content-Type': 'application/json', 'X-CSRF-Token': c.csrf },
          body: JSON.stringify(body),
        });

      assert.deepEqual(await (await post({ target_type: 'group', target_id: 1, text: ' ' })).json(), {
        error: '消息内容不能为空',
      });
      assert.deepEqual(await (await post({ target_type: 'group', target_id: 0, text: 'hi' })).json(), {
        error: '目标不能为空',
      });
      assert.deepEqual(await (await post({ target_type: 'x', target_id: 1, text: 'hi' })).json(), {
        error: '目标类型只能是 group 或 private',
      });
    } finally {
      await h.stop();
    }
  });
});

describe('联网搜索的设置', () => {
  /** 带 CSRF 的 PUT。 */
  async function put(h: Awaited<ReturnType<typeof harness>>, c: { header: string; csrf: string }, body: unknown) {
    return fetch(`${h.base}/api/settings`, {
      method: 'PUT',
      headers: { Cookie: c.header, 'Content-Type': 'application/json', 'X-CSRF-Token': c.csrf },
      body: JSON.stringify(body),
    });
  }

  it('开着却连模型 Key 都没有，直接 400，不要存成"看起来配好了"', async () => {
    const h = await harness();
    try {
      const c = await authed(h);
      const res = await put(h, c, { search: { enabled: true } });
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), {
        error: '开启联网搜索需要先填写模型 API Key（搜索与模型共用同一把）',
      });
    } finally {
      await h.stop();
    }
  });

  it('搜索次数与条数上限要卡住', async () => {
    const h = await harness();
    try {
      const c = await authed(h);
      const cases: [unknown, string][] = [
        [{ search: { max_calls: 0 } }, '每条消息最多搜几次应在 1-3 之间'],
        [{ search: { max_calls: 9 } }, '每条消息最多搜几次应在 1-3 之间'],
        [{ search: { max_results: 99 } }, '每次搜索取几条应在 1-10 之间'],
        [{ search: { timeout_sec: 1 } }, '搜索超时应在 3-30 秒之间'],
      ];
      for (const [payload, msg] of cases) {
        const res = await put(h, c, payload);
        assert.equal(res.status, 400, JSON.stringify(payload));
        assert.deepEqual(await res.json(), { error: msg });
      }
    } finally {
      await h.stop();
    }
  });

  it('搜索不再有独立凭证：GET 里没有 provider / api_key / base_url', async () => {
    const h = await harness();
    try {
      const c = await authed(h);
      const got = (await (await fetch(`${h.base}/api/settings`, { headers: { Cookie: c.header } })).json()) as {
        search: Record<string, unknown>;
      };
      assert.deepEqual(Object.keys(got.search).sort(), [
        'enabled',
        'max_calls',
        'max_results',
        'timeout_sec',
      ]);
    } finally {
      await h.stop();
    }
  });
});

describe('会话级设置（按对话对象覆盖）', () => {
  /** 带 CSRF 的 PUT /api/sessions/settings。 */
  async function putCfg(
    h: Awaited<ReturnType<typeof harness>>,
    c: { header: string; csrf: string },
    body: unknown,
  ): Promise<Response> {
    return fetch(`${h.base}/api/sessions/settings`, {
      method: 'PUT',
      headers: { Cookie: c.header, 'Content-Type': 'application/json', 'X-CSRF-Token': c.csrf },
      body: JSON.stringify(body),
    });
  }

  interface CfgResp {
    id: string;
    kind: string;
    target_id: number;
    name: string;
    persona_id: number;
    default_persona: { id: number; name: string };
    overrides: Record<string, Record<string, unknown>>;
    global: Record<string, Record<string, unknown>>;
  }

  async function getCfg(
    h: Awaited<ReturnType<typeof harness>>,
    c: { header: string },
    id: string,
  ): Promise<CfgResp> {
    const res = await fetch(`${h.base}/api/sessions/settings?id=${encodeURIComponent(id)}`, {
      headers: { Cookie: c.header },
    });
    assert.equal(res.status, 200);
    return (await res.json()) as CfgResp;
  }

  /** 改全局设置（走真实接口，顺带证明两边不打架）。 */
  async function putGlobal(
    h: Awaited<ReturnType<typeof harness>>,
    c: { header: string; csrf: string },
    patch: unknown,
  ): Promise<void> {
    const res = await fetch(`${h.base}/api/settings`, {
      method: 'PUT',
      headers: { Cookie: c.header, 'Content-Type': 'application/json', 'X-CSRF-Token': c.csrf },
      body: JSON.stringify(patch),
    });
    assert.equal(res.status, 200, await res.text());
  }

  it('鉴权：未登录 401，缺 CSRF 403', async () => {
    const h = await harness();
    try {
      const anonGet = await fetch(`${h.base}/api/sessions/settings?id=group:1`);
      assert.equal(anonGet.status, 401);

      const c = await authed(h);
      const noCsrf = await fetch(`${h.base}/api/sessions/settings`, {
        method: 'PUT',
        headers: { Cookie: c.header, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'group:1', overrides: {} }),
      });
      assert.equal(noCsrf.status, 403);
    } finally {
      await h.stop();
    }
  });

  it('会话 ID 格式必须严格', async () => {
    const h = await harness();
    try {
      const c = await authed(h);
      const msg = '会话 ID 格式应为 group:群号 或 private:QQ号';
      // 空 ID 走的是另一条文案：GET 当成格式错，PUT 明确说"不能为空"
      const cases: [string, string, string][] = [
        ['', msg, '会话 ID 不能为空'],
        ['group:abc', msg, msg],
        ['foo:1', msg, msg],
        ['private:0', msg, msg],
        ['group', msg, msg],
      ];
      for (const [id, getMsg, putMsg] of cases) {
        const got = await fetch(`${h.base}/api/sessions/settings?id=${encodeURIComponent(id)}`, {
          headers: { Cookie: c.header },
        });
        assert.equal(got.status, 400, id);
        assert.deepEqual(await got.json(), { error: getMsg });

        const put = await putCfg(h, c, { id, overrides: {} });
        assert.equal(put.status, 400, id);
        assert.deepEqual(await put.json(), { error: putMsg });
      }
    } finally {
      await h.stop();
    }
  });

  it('白名单外的组与字段一律 400，不静默丢弃', async () => {
    const h = await harness();
    try {
      const c = await authed(h);
      const cases: [unknown, string][] = [
        [{ id: 'group:1', overrides: { llm: { model: 'x' } } }, '不支持的设置组：llm'],
        [{ id: 'group:1', overrides: { panel: {} } }, '不支持的设置组：panel'],
        // 队列级参数与部署级总闸不能按会话设
        [{ id: 'group:1', overrides: { bot: { max_concurrent: 5 } } }, '「触发规则」不支持按会话设置的字段：max_concurrent'],
        [{ id: 'group:1', overrides: { bot: { whitelist_groups: [1] } } }, '「触发规则」不支持按会话设置的字段：whitelist_groups'],
        // 类型错要报出来：默默丢组会让用户以为保存成功了
        [{ id: 'group:1', overrides: { bot: { passive_rate: '0.5' } } }, '「触发规则」的 passive_rate 取值类型不正确'],
        [{ id: 'group:1', overrides: { bot: [1, 2] } }, '「触发规则」格式错误'],
        // 主人与白名单是部署级边界：会话能改它们，等于被拉进来的人自己决定还能拉谁
        [{ id: 'group:1', overrides: { computer: { owner_qq: 1 } } }, '「电脑操作」不支持按会话设置的字段：owner_qq'],
        [{ id: 'group:1', overrides: { computer: { allow_groups: [1] } } }, '「电脑操作」不支持按会话设置的字段：allow_groups'],
        [{ id: 'group:1', overrides: [1] }, '会话设置格式错误'],
      ];
      for (const [payload, msg] of cases) {
        const res = await putCfg(h, c, payload);
        assert.equal(res.status, 400, JSON.stringify(payload));
        assert.deepEqual(await res.json(), { error: msg });
      }
    } finally {
      await h.stop();
    }
  });

  it('范围校验复用全局那一套文案', async () => {
    const h = await harness();
    try {
      const c = await authed(h);
      const cases: [unknown, string][] = [
        [{ bot: { passive_rate: 2 } }, '被动接话概率应在 0-1 之间'],
        [{ context: { max_turns: 51 } }, '上下文轮数应在 0-50 之间'],
        [{ vision: { max_images: 9 } }, '单条消息识图上限应在 1-4 张之间'],
        [{ proactive: { echo_rate: 2 } }, '跟进概率应在 0-1 之间'],
        [{ search: { max_calls: 9 } }, '每条消息最多搜几次应在 1-3 之间'],
      ];
      for (const [overrides, msg] of cases) {
        const res = await putCfg(h, c, { id: 'group:1', overrides });
        assert.equal(res.status, 400, JSON.stringify(overrides));
        assert.deepEqual(await res.json(), { error: msg });
      }
    } finally {
      await h.stop();
    }
  });

  it('没有覆盖时回全局值；写入后组内字段是全量', async () => {
    const h = await harness();
    try {
      const c = await authed(h);
      const empty = await getCfg(h, c, 'group:123');
      assert.deepEqual(empty.overrides, {});
      assert.deepEqual(Object.keys(empty.global).sort(), [
        'bot',
        'computer',
        'context',
        'images',
        'memory',
        'proactive',
        'search',
        'vision',
      ]);
      assert.equal(typeof empty.global.bot!.passive_rate, 'number');

      // 只传一个字段：服务端补成全量，引擎才不会读到 undefined
      const res = await putCfg(h, c, { id: 'group:123', overrides: { context: { max_turns: 3 } } });
      assert.equal(res.status, 200);

      const got = await getCfg(h, c, 'group:123');
      const ctx = got.overrides.context!;
      assert.equal(ctx.max_turns, 3);
      assert.equal(ctx.token_budget, empty.global.context!.token_budget, '缺的字段用全局补齐');
      assert.deepEqual(Object.keys(ctx).sort(), ['max_turns', 'token_budget']);
    } finally {
      await h.stop();
    }
  });

  it('全局改完，会话覆盖仍然生效', async () => {
    const h = await harness();
    try {
      const c = await authed(h);
      assert.equal((await putCfg(h, c, { id: 'group:123', overrides: { bot: { passive_rate: 0.05 } } })).status, 200);
      await putGlobal(h, c, { bot: { passive_rate: 0.9 } });

      assert.equal((await getCfg(h, c, 'group:123')).overrides.bot!.passive_rate, 0.05);
      // 没覆盖的会话跟着全局走
      assert.equal((await getCfg(h, c, 'group:456')).global.bot!.passive_rate, 0.9);
    } finally {
      await h.stop();
    }
  });

  it('记忆参数可以按会话覆盖，越界与未知字段都 400', async () => {
    const h = await harness();
    try {
      const c = await authed(h);
      // 只传一个字段：服务端补成全量，引擎才不会读到 undefined
      assert.equal(
        (await putCfg(h, c, { id: 'group:123', overrides: { memory: { recall_days: 5 } } })).status,
        200,
      );
      const got = await getCfg(h, c, 'group:123');
      assert.equal(got.overrides.memory!.recall_days, 5);
      assert.equal(Object.keys(got.overrides.memory!).length, 11, '组内字段必须是全量');

      // 越界走的是合并后的 validateSettings，与全局页同一份文案
      const bad = await putCfg(h, c, { id: 'group:123', overrides: { memory: { recall_days: 99 } } });
      assert.equal(bad.status, 400);

      // 白名单外的字段必须报错，不能静默丢弃——静默丢弃在界面上就是"存了但没生效"
      const unknown = await putCfg(h, c, { id: 'group:123', overrides: { memory: { api_key: 'x' } } });
      assert.equal(unknown.status, 400);
    } finally {
      await h.stop();
    }
  });

  it('回显黑名单是存储原值，不是并集（否则全局名单删不掉）', async () => {
    const h = await harness();
    try {
      const c = await authed(h);
      await putGlobal(h, c, { bot: { blacklist_users: [7] } });
      await putCfg(h, c, { id: 'group:123', overrides: { bot: { blacklist_users: [8] } } });

      const got = await getCfg(h, c, 'group:123');
      assert.deepEqual(got.overrides.bot!.blacklist_users, [8], '回并集会让用户以为删掉了 7');
    } finally {
      await h.stop();
    }
  });

  it('传空覆盖等于恢复跟随全局，且可重复调用', async () => {
    const h = await harness();
    try {
      const c = await authed(h);
      await putCfg(h, c, { id: 'group:123', overrides: { context: { max_turns: 1 } } });
      assert.equal(h.store.sessionSettings.count(), 1);

      assert.equal((await putCfg(h, c, { id: 'group:123', overrides: {} })).status, 200);
      assert.equal(h.store.sessionSettings.count(), 0);
      assert.deepEqual((await getCfg(h, c, 'group:123')).overrides, {});

      // 幂等：再调一次还是 200
      assert.equal((await putCfg(h, c, { id: 'group:123', overrides: {} })).status, 200);
    } finally {
      await h.stop();
    }
  });

  it('保存设置不会凭空造出会话行（否则列表里会有两条同名记录）', async () => {
    const h = await harness();
    try {
      const c = await authed(h);
      await putCfg(h, c, { id: 'group:987654321', name: '夜猫子群', overrides: { context: { max_turns: 2 } } });

      const sessions = h.store.db.get<{ n: number }>(`SELECT COUNT(1) AS n FROM sessions`);
      assert.equal(Number(sessions!.n), 0, 'sessions 行只在收到消息时才建');

      const list = (await (
        await fetch(`${h.base}/api/sessions`, { headers: { Cookie: c.header } })
      ).json()) as { items: { id: string; preset?: boolean; overrides?: boolean; messages: number; name?: string }[] };
      const rows = list.items.filter((s) => s.id === 'group:987654321');
      assert.equal(rows.length, 1);
      assert.equal(rows[0]!.preset, true);
      assert.equal(rows[0]!.overrides, true);
      assert.equal(rows[0]!.messages, 0);
      assert.equal(rows[0]!.name, '夜猫子群');
    } finally {
      await h.stop();
    }
  });

  it('人格绑定与设置覆盖指向同一会话时只出一行', async () => {
    const h = await harness();
    try {
      const c = await authed(h);
      const p = h.store.personas.upsert('coder', 'you write code');
      await fetch(`${h.base}/api/sessions/persona`, {
        method: 'POST',
        headers: { Cookie: c.header, 'Content-Type': 'application/json', 'X-CSRF-Token': c.csrf },
        body: JSON.stringify({ id: 'private:2083882365', persona_id: p.id, name: '老王' }),
      });
      await putCfg(h, c, { id: 'private:2083882365', overrides: { vision: { enabled: false } } });

      const list = (await (
        await fetch(`${h.base}/api/sessions`, { headers: { Cookie: c.header } })
      ).json()) as {
        items: { id: string; preset?: boolean; overrides?: boolean; persona_id: number; persona_name: string; name?: string }[];
      };
      const rows = list.items.filter((s) => s.id === 'private:2083882365');
      assert.equal(rows.length, 1, '两个来源必须合并，否则列表里是两条一样的记录');
      assert.equal(rows[0]!.preset, true);
      assert.equal(rows[0]!.overrides, true);
      assert.equal(rows[0]!.persona_id, p.id);
      assert.equal(rows[0]!.persona_name, 'coder');
      assert.equal(rows[0]!.name, '老王');
    } finally {
      await h.stop();
    }
  });

  it('有消息的会话也会标记「独立」', async () => {
    const h = await harness();
    try {
      const c = await authed(h);
      h.store.sessions.touch('group:123', 'group', 123, '老群');
      await putCfg(h, c, { id: 'group:123', overrides: { context: { max_turns: 2 } } });

      const list = (await (
        await fetch(`${h.base}/api/sessions`, { headers: { Cookie: c.header } })
      ).json()) as { items: { id: string; preset?: boolean; overrides?: boolean }[] };
      const row = list.items.find((s) => s.id === 'group:123');
      assert.equal(row?.overrides, true);
      assert.equal(row?.preset, undefined);
    } finally {
      await h.stop();
    }
  });

  it('一并回人格绑定与默认人格（面板在同一页改人格要用）', async () => {
    const h = await harness();
    try {
      const c = await authed(h);
      const def = h.store.personas.active();

      const before = await getCfg(h, c, 'group:321');
      assert.equal(before.persona_id, 0, '没绑过就是 0，前端据此显示「跟随默认」');
      assert.equal(before.default_persona.id, def.id);
      assert.equal(before.default_persona.name, def.name);

      const p = h.store.personas.upsert('傲娇', '哼。');
      h.store.personas.bind('group:321', p.id, { kind: 'group', name: '测试群' });

      const after = await getCfg(h, c, 'group:321');
      assert.equal(after.persona_id, p.id);
      // 绑定不该偷偷改全局 active —— 那会让所有没绑过的会话一起换人格
      assert.equal(after.default_persona.id, def.id);
      // 人格与六组覆盖是两套存储，互不干扰
      assert.deepEqual(after.overrides, {});
    } finally {
      await h.stop();
    }
  });

  it('写入与重置都留审计，detail 带会话与组名', async () => {
    const h = await harness();
    try {
      const c = await authed(h);
      await putCfg(h, c, { id: 'group:123', overrides: { context: { max_turns: 2 }, vision: { enabled: false } } });
      const saved = h.store.audit.list(10).find((a) => a.action === 'session.settings');
      assert.ok(saved);
      assert.ok(saved.detail.includes('group:123'));
      assert.ok(saved.detail.includes('上下文'));
      assert.ok(saved.detail.includes('图片识别'));

      await putCfg(h, c, { id: 'group:123', overrides: {} });
      const reset = h.store.audit.list(10).find((a) => a.action === 'session.settings');
      assert.ok(reset!.detail.includes('default(global)'));
    } finally {
      await h.stop();
    }
  });
});

describe('电脑操作审批', () => {
  const req = {
    session: 'private:10001',
    kind: 'private',
    target: 10001,
    user: 10001,
    tool: 'run_command',
    summary: 'df -h',
    detail: '{"command":"df -h"}',
  };

  /** 起一条挂着的申请，返回它的 id 与那个还没 settle 的 promise。 */
  async function pend(q: ApprovalQueue, timeoutMs = 5000): Promise<string> {
    void q.ask(req, { timeoutMs });
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const first = q.list()[0];
      if (first) return first.id;
      await new Promise((r) => setTimeout(r, 5));
    }
    throw new Error('等不到待批准');
  }

  function decide(h: Awaited<ReturnType<typeof harness>>, c: { header: string; csrf: string }, body: unknown) {
    return fetch(`${h.base}/api/computer/decide`, {
      method: 'POST',
      headers: { Cookie: c.header, 'Content-Type': 'application/json', 'X-CSRF-Token': c.csrf },
      body: JSON.stringify(body),
    });
  }

  it('未登录 401、缺 CSRF 403', async () => {
    const q = new ApprovalQueue();
    const h = await harness({ approvals: q });
    try {
      const anon = await fetch(`${h.base}/api/computer/pending`);
      assert.equal(anon.status, 401);

      const c = await authed(h);
      const noToken = await fetch(`${h.base}/api/computer/decide`, {
        method: 'POST',
        headers: { Cookie: c.header, 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: 'x', approve: true }),
      });
      assert.equal(noToken.status, 403);
      assert.deepEqual(await noToken.json(), { error: 'CSRF 校验失败，请刷新页面重试' });
    } finally {
      await h.stop();
    }
  });

  it('pending 回列表但不外泄内部句柄', async () => {
    const q = new ApprovalQueue();
    const h = await harness({ approvals: q });
    try {
      const c = await authed(h);
      const id = await pend(q);
      const res = await fetch(`${h.base}/api/computer/pending`, { headers: { Cookie: c.header } });
      assert.equal(res.status, 200);
      const body = (await res.json()) as { items: Record<string, unknown>[] };
      assert.equal(body.items.length, 1);
      const item = body.items[0]!;
      assert.equal(item['id'], id);
      assert.equal(item['summary'], 'df -h');
      assert.ok((item['remain_ms'] as number) > 0);
      assert.equal('finish' in item, false);
      assert.equal('resolve' in item, false);
    } finally {
      await h.stop();
    }
  });

  it('批准与拒绝都走通，重复处理转 410，未知 id 转 404', async () => {
    const q = new ApprovalQueue();
    const h = await harness({ approvals: q });
    try {
      const c = await authed(h);

      const id1 = await pend(q);
      const ok1 = await decide(h, c, { id: id1, approve: true });
      assert.equal(ok1.status, 200);
      assert.deepEqual(await ok1.json(), { ok: true, decision: 'approved' });

      const again = await decide(h, c, { id: id1, approve: true });
      assert.equal(again.status, 410);
      assert.deepEqual(await again.json(), { error: '这条待批准已过期或被处理过' });

      const id2 = await pend(q);
      const ok2 = await decide(h, c, { id: id2, approve: false });
      assert.equal(ok2.status, 200);
      assert.deepEqual(await ok2.json(), { ok: true, decision: 'denied' });

      const missing = await decide(h, c, { id: 'deadbeef', approve: true });
      assert.equal(missing.status, 404);
      assert.deepEqual(await missing.json(), { error: '没有这条待批准记录' });
    } finally {
      await h.stop();
    }
  });

  it('入参不合法时 400 并给出中文原因', async () => {
    const h = await harness({ approvals: new ApprovalQueue() });
    try {
      const c = await authed(h);
      const cases: [unknown, string][] = [
        [{ approve: true }, '缺少待批准编号'],
        [{ id: '', approve: true }, '缺少待批准编号'],
        [{ id: 'x', approve: 'yes' }, 'approve 必须是布尔值'],
      ];
      for (const [body, msg] of cases) {
        const res = await decide(h, c, body);
        assert.equal(res.status, 400, JSON.stringify(body));
        assert.deepEqual(await res.json(), { error: msg });
      }
    } finally {
      await h.stop();
    }
  });

  it('没注入队列时 pending 是空列表（旧调用方不该报错）', async () => {
    const h = await harness();
    try {
      const c = await authed(h);
      const res = await fetch(`${h.base}/api/computer/pending`, { headers: { Cookie: c.header } });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { items: [] });
    } finally {
      await h.stop();
    }
  });
});

describe('主动发言的设置', () => {
  async function put(
    h: Awaited<ReturnType<typeof harness>>,
    c: { header: string; csrf: string },
    body: unknown,
  ): Promise<Response> {
    return fetch(`${h.base}/api/settings`, {
      method: 'PUT',
      headers: { Cookie: c.header, 'Content-Type': 'application/json', 'X-CSRF-Token': c.csrf },
      body: JSON.stringify(body),
    });
  }

  it('闲置与免打扰的取值范围也要卡住', async () => {
    const h = await harness();
    try {
      const c = await authed(h);
      const cases: [unknown, string][] = [
        [{ proactive: { idle_after_min: -1 } }, '闲置时长应在 0-2880 分钟之间（0 表示关闭）'],
        [{ proactive: { idle_after_min: 9999 } }, '闲置时长应在 0-2880 分钟之间（0 表示关闭）'],
        [{ proactive: { idle_rate: 2 } }, '闲置开口概率应在 0-1 之间'],
        [{ proactive: { proactive_daily_limit: 99 } }, '每日主动上限应在 0-20 条之间'],
        [{ proactive: { quiet_start_hour: 25 } }, '免打扰时段应在 0-24 点之间'],
      ];
      for (const [payload, msg] of cases) {
        const res = await put(h, c, payload);
        assert.equal(res.status, 400, JSON.stringify(payload));
        assert.deepEqual(await res.json(), { error: msg });
      }
    } finally {
      await h.stop();
    }
  });
});

describe('记忆接口', () => {
  const json = (c: { header: string; csrf: string }): Record<string, string> => ({
    Cookie: c.header,
    'Content-Type': 'application/json',
    'X-CSRF-Token': c.csrf,
  });

  it('未登录读不到，登录后一次带回列表、归属与开关状态', async () => {
    const h = await harness();
    try {
      h.store.memory.add({ scope: 'user', owner_id: '20001', owner_name: '阿伟', content: '在杭州做后端', score: 5 });

      const anon = await fetch(`${h.base}/api/memories`);
      assert.equal(anon.status, 401);

      const c = await authed(h);
      const d = (await (
        await fetch(`${h.base}/api/memories`, { headers: { Cookie: c.header } })
      ).json()) as {
        tab: string;
        total: number;
        items: { content: string; scope: string }[];
        owners: { owner_id: string }[];
        status: { enabled: boolean; facts: number; days: number };
      };
      assert.equal(d.tab, 'fact');
      assert.equal(d.total, 1);
      assert.equal(d.items[0]!.content, '在杭州做后端');
      assert.equal(d.owners[0]!.owner_id, '20001');
      // status 要给前端判断"关着但存着东西"，否则用户看到列表会以为在生效
      assert.equal(d.status.enabled, false);
      assert.equal(d.status.facts, 1);
      assert.equal(d.status.days, 0);
    } finally {
      await h.stop();
    }
  });

  it('新增、改、删走完一圈', async () => {
    const h = await harness();
    try {
      const c = await authed(h);

      const add = await fetch(`${h.base}/api/memories`, {
        method: 'POST',
        headers: json(c),
        body: JSON.stringify({ scope: 'session', owner_id: 'group:1', content: '群里管机器人叫小度', score: 4 }),
      });
      assert.equal(add.status, 200);

      const listed = (await (
        await fetch(`${h.base}/api/memories?scope=session`, { headers: { Cookie: c.header } })
      ).json()) as { items: { id: number; content: string }[] };
      const id = listed.items[0]!.id;

      const upd = await fetch(`${h.base}/api/memories`, {
        method: 'PUT',
        headers: json(c),
        body: JSON.stringify({ id, content: '群里都叫它小度' }),
      });
      assert.equal(upd.status, 200);
      assert.equal(h.store.memory.get(id)?.content, '群里都叫它小度');

      const del = await fetch(`${h.base}/api/memories?id=${id}`, { method: 'DELETE', headers: json(c) });
      assert.equal(del.status, 200);
      assert.equal(h.store.memory.get(id), null);

      const again = await fetch(`${h.base}/api/memories?id=${id}`, { method: 'DELETE', headers: json(c) });
      assert.equal(again.status, 404, '删不存在的一条要如实说，不能假装成功');
    } finally {
      await h.stop();
    }
  });

  it('用户维度的归属必须是 QQ 号，会话维度必须是 group:/private:', async () => {
    const h = await harness();
    try {
      const c = await authed(h);
      const cases: [unknown, string][] = [
        [{ scope: 'user', owner_id: '阿伟', content: '随便一条' }, '用户记忆的归属要填 QQ 号'],
        [{ scope: 'session', owner_id: '123456', content: '随便一条' }, '会话记忆的归属要形如 group:123 或 private:456'],
        [{ scope: 'user', owner_id: '20001', content: '短' }, '记忆内容应在 2-200 字之间'],
      ];
      for (const [payload, msg] of cases) {
        const res = await fetch(`${h.base}/api/memories`, {
          method: 'POST',
          headers: json(c),
          body: JSON.stringify(payload),
        });
        assert.equal(res.status, 400, JSON.stringify(payload));
        assert.deepEqual(await res.json(), { error: msg });
      }
    } finally {
      await h.stop();
    }
  });

  it('清空把事实与概述一起删干净', async () => {
    const h = await harness();
    try {
      h.store.memory.add({ scope: 'user', owner_id: '20001', content: '一条事实', score: 4 });
      h.store.memory.saveDay({
        session_id: 'group:1', day: '2026-10-30',
        period_start: 1, period_end: 2, msg_count: 2, content: '一段概述', tokens: 3,
      });

      const c = await authed(h);
      const res = await fetch(`${h.base}/api/memories/clear`, {
        method: 'POST',
        headers: json(c),
        body: JSON.stringify({}),
      });
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { ok: true, deleted: 1, days: 1 });
      assert.equal(h.store.memory.list({ limit: 10 }).total, 0);
      assert.equal(h.store.memory.listDays({ limit: 10 }).total, 0);
    } finally {
      await h.stop();
    }
  });

  it('开着记忆却没配模型 Key，保存设置就该 400', async () => {
    const h = await harness();
    try {
      const c = await authed(h);
      const res = await fetch(`${h.base}/api/settings`, {
        method: 'PUT',
        headers: json(c),
        body: JSON.stringify({ memory: { enabled: true } }),
      });
      assert.equal(res.status, 400);
      assert.deepEqual(await res.json(), {
        error: '开启长期记忆需要先填写模型 API Key（整理与对话共用同一把）',
      });
    } finally {
      await h.stop();
    }
  });

  it('没有引擎能力时「立即整理」返回 501，而不是假装成功', async () => {
    const h = await harness();
    try {
      const c = await authed(h);
      const res = await fetch(`${h.base}/api/memories/digest`, {
        method: 'POST',
        headers: json(c),
        body: JSON.stringify({ session_id: 'group:1' }),
      });
      assert.equal(res.status, 501);
    } finally {
      await h.stop();
    }
  });
});
