// NapCat WebUI 的假实现，用于测试扫码登录链路。
//
// 为什么要一个假协议端而不是直接打真机：
//   1. CI 里没有 QQ 账号，扫码这一步不可能自动化
//   2. 真实 NapCat 的错误分支（code!=0、凭据失效）几乎无法按需触发
// 这个假实现严格按真机探测到的行为写：
//   - 业务错误一律 HTTP 200，靠 body 的 code 判定
//   - 鉴权失败才是真的 401
//   - qrcode 返回的是内容字符串，不是图片地址
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';

export interface FakeNapCatState {
  /** 已登录的 QQ 号；空串表示未登录 */
  uin: string;
  nick: string;
  offline: boolean;
  loginPhase: string;
  loginError: string;
  /** 已保存的账号列表 */
  saved: { uin: string; nick: string }[];
  /** 让当前 Credential 失效（模拟协议端重启） */
  invalidateCredential: boolean;
  /** 让下一个业务接口返回 code!=0 */
  failNextWith: { code: number; message: string } | null;
  /** OneBot11 网络配置（OB11Config/* 读写的就是它） */
  network: Record<string, unknown>;
  /** true 时 GetConfig 把配置当 JSON 字符串返回（真机有这种形态） */
  networkAsString: boolean;
  /** true 时 GetConfig 直接返回本体，不套 { config } */
  networkBare: boolean;
  /** SetConfig 收到的 config 原文（按顺序），用来断言我们发的是文本还是对象 */
  setPayloads: unknown[];
}

export interface FakeNapCat {
  base: string;
  state: FakeNapCatState;
  /** 收到的请求路径（按顺序），用于断言调用序列 */
  calls: string[];
  /** 登录接口被调用的次数，用于验证凭据复用与重新登录 */
  loginCount: () => number;
  close: () => Promise<void>;
}

export async function startFakeNapCat(token: string): Promise<FakeNapCat> {
  const state: FakeNapCatState = {
    uin: '',
    nick: '',
    offline: false,
    loginPhase: 'waiting_qrcode',
    loginError: '',
    saved: [],
    invalidateCredential: false,
    failNextWith: null,
    // 与 NapCat 出厂默认一致：反向 WS 服务端开在 3001
    network: {
      network: {
        httpServers: [],
        httpClients: [],
        websocketServers: [
          {
            name: 'ws',
            enable: true,
            host: '0.0.0.0',
            port: 3001,
            messagePostFormat: 'array',
            token: '',
          },
        ],
        websocketClients: [],
      },
      musicSignUrl: '',
      enableLocalFile2Url: false,
    },
    networkAsString: false,
    networkBare: false,
    setPayloads: [],
  };

  const calls: string[] = [];
  let logins = 0;
  let credential = '';

  const expectedHash = createHash('sha256').update(`${token}.napcat`).digest('hex');

  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => {
      raw += String(c);
    });
    req.on('end', () => {
      const path = (req.url ?? '').split('?')[0] ?? '';
      calls.push(path);

      const send = (status: number, body: unknown): void => {
        const text = JSON.stringify(body);
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(text);
      };
      const ok = (data: unknown): void => send(200, { code: 0, message: 'ok', data });
      const bad = (code: number, message: string): void => send(200, { code, message });

      if (path === '/api/auth/login') {
        logins++;
        let hash = '';
        try {
          hash = String((JSON.parse(raw) as { hash?: string }).hash ?? '');
        } catch {
          hash = '';
        }
        if (hash !== expectedHash) {
          bad(-1, 'token 校验失败');
          return;
        }
        credential = `cred-${logins}`;
        state.invalidateCredential = false;
        // 真机返回的字段名是 Credential（首字母大写）
        ok({ Credential: credential, createdAt: Date.now() });
        return;
      }

      // 其余接口都要 Bearer
      const auth = String(req.headers.authorization ?? '');
      if (state.invalidateCredential || auth !== `Bearer ${credential}`) {
        send(401, { code: -1, message: 'Unauthorized' });
        return;
      }

      if (state.failNextWith) {
        const f = state.failNextWith;
        state.failNextWith = null;
        bad(f.code, f.message);
        return;
      }

      switch (path) {
        case '/api/QQLogin/CheckLoginStatus':
          ok({
            isLogin: state.uin !== '',
            isOffline: state.offline,
            uin: state.uin,
            nick: state.nick,
            loginPhase: state.loginPhase,
            loginError: state.loginError,
          });
          return;

        case '/api/QQLogin/GetQQLoginQrcode':
          // 真机行为：已登录时直接拒绝发码，message 就是这句英文（原文如此，
          // logined 的拼写也是 NapCat 自己的）。面板必须把它当成"已登录"，
          // 而不是一条 500 + 日志里的 ERROR。
          if (state.uin !== '') {
            bad(-1, 'QQ Is Logined');
            return;
          }
          // 未登录时给的是二维码内容字符串（一个 https 链接），不是图片地址
          ok({ qrcode: 'https://txz.qq.com/p?k=fake-qrcode-content&f=web', qrcodeurl: '' });
          return;

        case '/api/QQLogin/GetQQLoginInfo':
          ok({ uin: state.uin, nick: state.nick });
          return;

        case '/api/QQLogin/GetQuickLoginList':
          ok(state.saved);
          return;

        case '/api/QQLogin/SetQuickLogin': {
          const uin = String((JSON.parse(raw || '{}') as { uin?: string }).uin ?? '');
          if (!state.saved.some((s) => s.uin === uin)) {
            bad(-1, `没有可快捷登录的账号 ${uin}`);
            return;
          }
          state.uin = uin;
          state.nick = state.saved.find((s) => s.uin === uin)?.nick ?? '';
          ok({});
          return;
        }

        case '/api/QQLogin/Logout':
          state.uin = '';
          state.nick = '';
          ok({});
          return;

        // 真机行为：未登录时这两个接口直接回 Not Login（HTTP 200 + code!=0）
        case '/api/OB11Config/GetConfig': {
          if (state.uin === '') {
            bad(-1, 'Not Login');
            return;
          }
          if (state.networkBare) {
            ok(state.network);
          } else if (state.networkAsString) {
            ok({ config: JSON.stringify(state.network) });
          } else {
            ok({ config: state.network });
          }
          return;
        }

        case '/api/OB11Config/SetConfig': {
          if (state.uin === '') {
            bad(-1, 'Not Login');
            return;
          }
          const p = JSON.parse(raw || '{}') as { config?: unknown };
          state.setPayloads.push(p.config);
          // 真机拿到 config 直接 JSON5.parse。传对象时它先被 String() 成
          // "[object Object]"，第 1 个字符 '[' 被当成数组开头，第 2 个字符 'o'
          // 才炸。这里如实复刻，任何"又把对象发过去"的回归都会立刻失败。
          if (typeof p.config !== 'string') {
            bad(-1, "SyntaxError: JSON5: invalid character 'o' at 1:2");
            return;
          }
          state.network = JSON.parse(p.config) as Record<string, unknown>;
          ok({});
          return;
        }

        default:
          send(404, { code: -1, message: 'Not Found' });
      }
    });
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const addr = server.address() as { port: number };

  return {
    base: `http://127.0.0.1:${addr.port}`,
    state,
    calls,
    loginCount: () => logins,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections();
        server.close(() => r());
      }),
  };
}
