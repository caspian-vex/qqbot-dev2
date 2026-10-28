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
import { after, describe, it } from 'node:test';
import { LogHub } from '../src/log/hub';
import { Logger } from '../src/log/logger';
import { hashPassword, newTOTPSecret, totpCode, verifyPassword } from '../src/panel/auth';
import { normalizeUsername } from '../src/panel/api';
import { assignOnto, encodeJSON } from '../src/panel/http';
import { PanelServer, splitHostPort as splitHostPortForTest } from '../src/panel/server';
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
  stop: () => Promise<void>;
}

/** 起一个用完即弃的面板实例。每个用例独立实例，避免登录限流互相干扰。 */
async function harness(opts: { password?: string; totp?: boolean } = {}): Promise<Harness> {
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
  });
  const port = await panel.listen('127.0.0.1:0');

  return {
    base: `http://127.0.0.1:${port}`,
    store,
    panel,
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
});

// ---- HTTP ----

describe('探活', () => {
  it('GET /healthz 免鉴权返回 ok 与 uptime', async () => {
    const h = await harness();
    try {
      const res = await fetch(`${h.base}/healthz`);
      assert.equal(res.status, 200);
      const body = (await res.json()) as { status: string; uptime: string };
      assert.equal(body.status, 'ok');
      assert.match(body.uptime, /^\d+[hms]/);
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
        headers: { Cookie: c.header },
      });
      assert.equal(out.status, 200);

      const after = await fetch(`${h.base}/api/settings`, { headers: { Cookie: c.header } });
      assert.equal(after.status, 401);
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
        [{ llm: { model: '' } }, '模型名称不能为空'],
        [{ llm: { max_tokens: 99999 } }, '最大输出 token 应在 1-8192 之间'],
        [{ llm: { timeout_sec: 0 } }, '超时时间应在 1-300 秒之间'],
        [{ bot: { passive_rate: 2 } }, '被动接话概率应在 0-1 之间'],
        [{ bot: { max_concurrent: 0 } }, '并发数应在 1-10 之间'],
        [{ bot: { max_segments: 9 } }, '最大分段数应在 1-8 之间'],
        [{ context: { max_turns: 51 } }, '上下文轮数应在 0-50 之间'],
        [{ context: { token_budget: 100 } }, '上下文 token 预算应在 200-100000 之间'],
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
      h.store.sessions.touch('group:1', 'group', 1);
      h.store.sessions.append('group:1', 'user', '你好', 0);
      h.store.sessions.append('group:1', 'assistant', '你好呀', 0);

      const c = await authed(h);
      const list = (await (
        await fetch(`${h.base}/api/sessions`, { headers: { Cookie: c.header } })
      ).json()) as { items: { id: string; messages: number }[] };
      assert.equal(list.items.length, 1);
      assert.equal(list.items[0]!.id, 'group:1');
      assert.equal(list.items[0]!.messages, 2);

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
