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
  /** 当前二维码内容。真机行为：读取不会换码，只有 RefreshQRcode 才会。 */
  qrContent: string;
  /** RefreshQRcode 是否真的换了码。false 用来复刻"账号被踢下线、内核不重建"的卡死态。 */
  qrRotateOnRefresh: boolean;
  /** RefreshQRcode 被调用的次数 */
  qrRefreshes: number;
  /** OneBot11 网络配置（OB11Config/* 读写的就是它） */
  network: Record<string, unknown>;
  /** true 时 GetConfig 把配置当 JSON 字符串返回（真机有这种形态） */
  networkAsString: boolean;
  /** true 时 GetConfig 直接返回本体，不套 { config } */
  networkBare: boolean;
  /** SetConfig 收到的 config 原文（按顺序），用来断言我们发的是文本还是对象 */
  setPayloads: unknown[];
  /**
   * 自动登录账号（napcat.json 的 autoLoginAccount）。
   *
   * 真机上它决定"进程重启后要不要自己登回去"。空串 = 重启后停在扫码页，
   * 这正是「退出登录」想达到的状态；非空则重启会静默登回去，
   * 客户端必须把这种"退了个寂寞"如实报出来。
   */
  autoLoginUin: string;
  /** RestartNapCat 被调用的次数 */
  restarts: number;
  /** true 时 SetQuickLoginQQ 按"老版本没有这条路由"回 404 */
  noAutoLoginRoute: boolean;
  /** true 时 RestartNapCat 回 404（更老的版本连重启接口都没有） */
  noRestartRoute: boolean;
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
    qrContent: 'https://txz.qq.com/p?k=fake-qrcode-content&f=web',
    qrRotateOnRefresh: true,
    qrRefreshes: 0,
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
    autoLoginUin: '',
    restarts: 0,
    noAutoLoginRoute: false,
    noRestartRoute: false,
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
          // 未登录时给的是二维码内容字符串（一个 https 链接），不是图片地址。
          // 关键：读多少次都是同一串——真机的缓存行为就是这样，
          // 只有 RefreshQRcode 会让它变。旧代码"刷新"只重复读，所以永远同一张。
          ok({ qrcode: state.qrContent, qrcodeurl: '' });
          return;

        case '/api/QQLogin/RefreshQRcode':
          // 真机实测（2026-10-29，NapCat + QQ 内核未登录态）：
          //   1) 这条路由**同步**返回新码，字段名是 `qrcodeurl`；
          //   2) 紧接着 GetQQLoginQrcode 拿到的就是这张新码。
          // 所以客户端可以直接用返回值，不必再 Get 一次、也不用等。
          // GetQQLoginQrcode 自己则永远回同一串缓存，这才是"刷新没反应"的根因。
          if (state.uin !== '') {
            bad(-1, 'QQ Is Logined');
            return;
          }
          state.qrRefreshes++;
          if (state.qrRotateOnRefresh) {
            state.qrContent = `https://txz.qq.com/p?k=fake-qrcode-${state.qrRefreshes}&f=web`;
          }
          // 没换码时也把当前码带回来：客户端靠"返回值与上一张相同"判定 stale
          ok({ qrcodeurl: state.qrContent });
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

        // 真机行为：这两个接口只是写 napcat.json 的 autoLoginAccount，
        // 不影响当前登录态，只影响"进程重启后要不要自己登回去"。
        case '/api/QQLogin/SetQuickLoginQQ': {
          // 老版本协议端没有这条路由：回 404，客户端只能带着自动登录继续重启
          if (state.noAutoLoginRoute) {
            send(404, { code: -1, message: 'Not Found' });
            return;
          }
          const uin = String((JSON.parse(raw || '{}') as { uin?: string }).uin ?? '');
          state.autoLoginUin = uin;
          ok(null);
          return;
        }

        case '/api/QQLogin/GetQuickLoginQQ':
          ok(state.autoLoginUin);
          return;

        // 真机没有 /QQLogin/Logout 这条路由（这是本次 bug 的根因），所以这里
        // 刻意不实现它：一旦谁再把它写回客户端，这里就回 404，测试立刻红。
        //
        // 「退出登录」在 NapCat 的语义里就是重启进程：进程一没，登录会话也没了，
        // 重启后停在扫码页（除非配了 autoLoginAccount）。
        case '/api/QQLogin/RestartNapCat': {
          // 太老的协议端没有这条路由
          if (state.noRestartRoute) {
            send(404, { code: -1, message: 'Not Found' });
            return;
          }
          state.restarts++;
          // 新进程的 Credential 与旧的不通用
          state.invalidateCredential = true;
          state.uin = state.autoLoginUin;
          state.nick = state.saved.find((s) => s.uin === state.autoLoginUin)?.nick ?? '';
          state.loginPhase = state.uin === '' ? 'waiting_qrcode' : 'login_success';
          ok({ message: 'Restart initiated' });
          return;
        }

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
