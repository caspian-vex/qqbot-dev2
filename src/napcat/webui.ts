// NapCat WebUI 客户端：把「扫码登录 QQ」搬进我们自己的面板。
//
// 为什么不让用户去 6099 那个 WebUI 扫码：
//   1. 那等于让用户记两个凭据（面板密码 + WebUI token），实际用起来很烦
//   2. WebUI token 得暴露在浏览器里，一旦泄露等于把协议端交出去
//   3. 换号、看登录状态这些动作分散在两个界面，排障时来回跳
// 所以由服务端持有 token，面板只暴露"要二维码 / 报登录状态"这类语义接口。
//
// 实测出来的几个坑（真机探测，不要凭直觉改）：
//   - 路由前缀是 /api，鉴权是 POST /api/auth/login {hash}
//   - hash = sha256(token + ".napcat") 的十六进制，不是 sha256(token)
//   - Credential 有 3600 秒有效期，必须静默续期，否则一小时后扫码接口全 401
//   - 业务错误一律 HTTP 200，只能看 body 的 code 字段
//   - qrcode 字段是二维码**内容字符串**，不是图片地址
//     （那个地址会 302 跳 im.qq.com 落地页，塞进 <img> 是坏的）
import { createHash } from 'node:crypto';
import QRCode from 'qrcode';
import type { Logger } from '../log/logger';

/** 二维码内容是一串 URL，官方建议留边距，300px 在手机上够扫。 */
const QR_OPTIONS = { margin: 1, width: 300, errorCorrectionLevel: 'M' as const };

/** Credential 有效期 3600 秒，提前 60 秒续期，避免卡在边界上。 */
const CRED_TTL_MS = 3600_000;
const CRED_REFRESH_MARGIN_MS = 60_000;

const CALL_TIMEOUT_MS = 10_000;

/** 协议端登录状态（归一化后的形状，字段名由我们自己定）。 */
export interface QQLoginStatus {
  /** 已登录 */
  login: boolean;
  /** 已登录但离线（QQ 侧掉线，需要重新登录） */
  offline: boolean;
  /** 当前登录的 QQ 号，未登录为空串 */
  uin: string;
  /** 昵称，未登录为空串 */
  nick: string;
  /** 登录阶段，如 waiting_qrcode / waiting_scan / waiting_confirm */
  phase: string;
  /** 协议端报的错误，正常为空串 */
  error: string;
}

export interface QQInfo {
  uin: string;
  nick: string;
}

export interface QuickLoginItem {
  uin: string;
  nick: string;
}

/**
 * OneBot11 网络配置（协议端「高级网络配置」那一页的等价物）。
 *
 * 为什么形态不定：NapCat 不同版本这个接口给的 data 可能是配置对象本体，
 * 也可能是一段 JSON 文本（配置文件本来就是 JSON5 文本）。两种都见过，
 * 所以这里把「原本是哪种形态」一起带出去——保存时必须按原样回传，
 * 否则某些版本会认为类型不匹配而拒绝。
 */
export interface NapCatNetworkConfig {
  config: Record<string, unknown>;
  /** true 表示协议端给的是 JSON 字符串，保存时要用字符串回传 */
  asString: boolean;
}

/** NapCat 返回的业务错误（HTTP 200 但 code != 0）。 */
export class NapCatError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = 'NapCatError';
  }
}

/**
 * 判断是不是"已经登录了，所以不给你二维码"。
 *
 * NapCat 在已登录时对 GetQQLoginQrcode 返回 code≠0 + message "QQ Is Logined"。
 * 这是正常状态而不是故障：面板刚打开、状态轮询还没回来，或者用户在别处登录了。
 * 不当成错误处理的话，一个"手滑点了刷新二维码"就会在日志里留一条 ERROR，
 * 界面上还显示一句英文原文——用户只会以为机器人坏了。
 */
export function isLoginedError(e: unknown): boolean {
  if (!(e instanceof NapCatError)) return false;
  return /is\s*logined|already\s*log|已登录/i.test(e.message);
}

/** 从多种可能的字段名里取第一个非空值。协议端改过字段名，两种都认。 */
function pick(obj: Record<string, unknown> | undefined, keys: string[]): unknown {
  if (!obj) return undefined;
  for (const k of keys) {
    const v = obj[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

function asString(v: unknown): string {
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  return '';
}

function asBool(v: unknown): boolean {
  return v === true || v === 'true' || v === 1;
}

/**
 * 从 data 里挖出真正的配置。
 *
 * 见过的三种形态：
 *   { config: {...} }        —— 包了一层
 *   { config: "{...}" }      —— 包了一层且是文本
 *   { websocketServers: [] } —— 直接是本体
 * 只有"看起来确实像包装"时才拆：真实配置里一定有 websocketServers 之类的键。
 */
function unwrapConfig(data: unknown): unknown {
  if (data === null || typeof data !== 'object' || Array.isArray(data)) return data;

  const o = data as Record<string, unknown>;
  const inner = o.config;
  const looksWrapped =
    (typeof inner === 'string' || (inner !== null && typeof inner === 'object')) &&
    !('websocketServers' in o) &&
    !('websocketServer' in o) &&
    !('httpServers' in o) &&
    !('network' in o);

  return looksWrapped ? inner : data;
}

export class NapCatWebUI {
  private credential = '';
  private credentialAt = 0;
  /** 正在进行的登录请求。并发调用共用它，别各自去换一次凭据。 */
  private loginInflight: Promise<string> | null = null;
  private readonly log: Logger;

  constructor(
    private readonly baseUrl: string,
    private readonly token: string,
    log: Logger,
  ) {
    this.log = log.with({ component: 'napcat' });
  }

  /** 是否配置了 WebUI 地址与 token。没配置时面板把扫码入口标成不可用。 */
  get configured(): boolean {
    return this.baseUrl !== '' && this.token !== '';
  }

  private get base(): string {
    return this.baseUrl.replace(/\/+$/, '');
  }

  /**
   * 拿到有效 Credential，必要时重新登录。
   *
   * 过期判断用本地时钟：协议端不会主动告知过期，
   * 而 401 之后才发现过期会让用户看到一次莫名其妙的失败。
   */
  private async ensureCredential(): Promise<string> {
    if (this.credential !== '' && Date.now() - this.credentialAt < CRED_TTL_MS - CRED_REFRESH_MARGIN_MS) {
      return this.credential;
    }
    // 并发去重：面板每 3 秒轮询一次状态，页面里的其它请求又各自走一遍这个入口，
    // 同时进来时若各跑一次 login，会拿到不同的 Credential——后写的覆盖前面的，
    // 先前那批请求就带着已作废的凭据返回 401，表现为"偶发鉴权失败"。
    if (this.loginInflight === null) {
      this.loginInflight = this.login().finally(() => {
        this.loginInflight = null;
      });
    }
    return this.loginInflight;
  }

  /** 用 token 换 Credential。 */
  private async login(): Promise<string> {
    const hash = createHash('sha256').update(`${this.token}.napcat`).digest('hex');
    const body = await this.post('/auth/login', { hash }, '');

    const data = (body.data ?? body) as Record<string, unknown>;
    const cred = asString(pick(data, ['Credential', 'credential', 'token']));
    if (cred === '') throw new NapCatError(-1, 'NapCat 登录失败：未返回 Credential');

    this.credential = cred;
    this.credentialAt = Date.now();
    this.log.debug('已获取 WebUI 凭据', { len: cred.length });
    return cred;
  }

  /**
   * 发一个 POST 到 /api 下。
   *
   * 刻意不解成泛型返回值：NapCat 的响应形状在不同版本里漂过，
   * 调用方自己按需 pick 字段比强类型更抗变化。
   */
  private async post(
    path: string,
    payload: unknown,
    credential: string,
  ): Promise<{ code: number; message: string; data?: Record<string, unknown> }> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    if (credential !== '') headers['Authorization'] = `Bearer ${credential}`;

    let res: Response;
    try {
      res = await fetch(`${this.base}/api${path}`, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload ?? {}),
        signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
      });
    } catch (e) {
      throw new NapCatError(-1, `连接 NapCat 失败：${(e as Error).message}`);
    }

    const text = await res.text().catch(() => '');
    if (res.status === 401 || res.status === 403) {
      // 凭据被服务端作废（重启过），清掉缓存让下一次调用重新登录
      this.credential = '';
      throw new NapCatError(-1, 'NapCat 鉴权失败，请检查 WEBUI_TOKEN');
    }
    if (!res.ok) {
      throw new NapCatError(-1, `NapCat 返回 HTTP ${res.status}`);
    }

    let body: Record<string, unknown>;
    try {
      body = JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new NapCatError(-1, 'NapCat 返回了非 JSON 响应');
    }

    const code = typeof body.code === 'number' ? body.code : 0;
    const message = asString(pick(body, ['message', 'msg']));
    if (code !== 0) {
      throw new NapCatError(code, message === '' ? `NapCat 返回 code=${code}` : message);
    }
    return {
      code,
      message,
      data: body.data as Record<string, unknown> | undefined,
    };
  }

  private async call(path: string, payload?: unknown): Promise<Record<string, unknown> | undefined> {
    const cred = await this.ensureCredential();
    const body = await this.post(path, payload, cred);
    return body.data;
  }

  // ---- 业务接口 ----

  /** 查登录状态。 */
  async status(): Promise<QQLoginStatus> {
    const d = await this.call('/QQLogin/CheckLoginStatus');
    return {
      login: asBool(pick(d, ['isLogin', 'is_login'])),
      offline: asBool(pick(d, ['isOffline', 'is_offline'])),
      uin: asString(pick(d, ['uin'])),
      nick: asString(pick(d, ['nick', 'nickname'])),
      phase: asString(pick(d, ['loginPhase', 'login_phase'])),
      error: asString(pick(d, ['loginError', 'login_error'])),
    };
  }

  /**
   * 取登录二维码。
   *
   * 返回 PNG data URL：NapCat 给的是二维码内容字符串，
   * 那个配套的 URL 会 302 到 im.qq.com 落地页，直接当图片用是坏的。
   * 服务端生成图片还有个好处——CSP 里 img-src 允许 data: 就够了，
   * 不用为协议端开一个外部域名。
   *
   * 已登录时协议端会拒绝发码，这里归一成 `logined: true`（没有图，但也不是错）。
   */
  async qrcode(): Promise<{ image: string; content: string; logined: boolean }> {
    let d: Record<string, unknown> | undefined;
    try {
      d = await this.call('/QQLogin/GetQQLoginQrcode');
    } catch (e) {
      if (isLoginedError(e)) return { image: '', content: '', logined: true };
      throw e;
    }

    const content = asString(pick(d, ['qrcode', 'qrcodeUrl', 'qrcodeurl']));
    if (content === '') throw new NapCatError(-1, 'NapCat 未返回二维码内容');

    const image = await QRCode.toDataURL(content, QR_OPTIONS);
    return { image, content, logined: false };
  }

  /** 当前登录账号信息。 */
  async loginInfo(): Promise<QQInfo> {
    const d = await this.call('/QQLogin/GetQQLoginInfo');
    return {
      uin: asString(pick(d, ['uin', 'user_id'])),
      nick: asString(pick(d, ['nick', 'nickname'])),
    };
  }

  /**
   * 快捷登录列表（本地已保存的账号）。
   *
   * 这是"换号/重登"最省事的路径：不用再扫码。
   * 拿不到就返回空数组——这个列表缺失不影响扫码登录。
   */
  async quickLoginList(): Promise<QuickLoginItem[]> {
    const cred = await this.ensureCredential();
    // 实测这个接口用 GET 也能通，但 POST 更稳（部分版本 GET 会 405）
    const body = await this.post('/QQLogin/GetQuickLoginList', {}, cred);
    const raw = body.data;
    const arr = Array.isArray(raw) ? raw : Array.isArray(raw?.data) ? (raw.data as unknown[]) : [];

    const out: QuickLoginItem[] = [];
    for (const item of arr) {
      const o = item as Record<string, unknown>;
      const uin = asString(pick(o, ['uin', 'uid']));
      if (uin === '') continue;
      out.push({ uin, nick: asString(pick(o, ['nick', 'nickname'])) });
    }
    return out;
  }

  /** 用已保存的账号快捷登录。 */
  async quickLogin(uin: string): Promise<void> {
    await this.call('/QQLogin/SetQuickLogin', { uin });
  }

  /** 退出当前 QQ 登录（换号前先退，否则 NapCat 会拒绝新登录）。 */
  async logout(): Promise<void> {
    await this.call('/QQLogin/Logout');
    // 退出后凭据可能被重置，下一次调用重新登录
    this.credential = '';
  }

  // ---- OneBot11 网络配置 ----
  //
  // 这一组接口是「不再暴露 6099」的最后一块拼图：面板自己调协议端的
  // OB11Config 接口，用户就不用为了改个 WS 端口再打开另一个 WebUI。
  //
  // 实测约束：OB11Config/* 要求 QQ **已登录**，未登录时协议端返回
  // "Not Login"。所以面板在未登录时不给编辑入口，先引导去扫码。

  /** 读网络配置。 */
  async networkConfig(): Promise<NapCatNetworkConfig> {
    const d = await this.call('/OB11Config/GetConfig');
    const raw = unwrapConfig(d);

    if (typeof raw === 'string') {
      try {
        return { config: JSON.parse(raw) as Record<string, unknown>, asString: true };
      } catch {
        throw new NapCatError(-1, 'NapCat 返回的网络配置不是合法 JSON');
      }
    }
    if (raw !== null && typeof raw === 'object' && !Array.isArray(raw)) {
      return { config: raw as Record<string, unknown>, asString: false };
    }
    throw new NapCatError(-1, 'NapCat 未返回网络配置');
  }

  /**
   * 保存网络配置。
   *
   * 关键坑：SetConfig 收的是**JSON5 文本**，不是对象。
   * NapCat 的 WebUI 网络页本身就是个文本编辑器，提交的是编辑器里的字符串，
   * 服务端拿到就 `JSON5.parse(config)`。传对象进去时它会先 `String(config)`
   * 成 `"[object Object]"` 再解析，于是报：
   *   JSON5: invalid character 'o' at 1:2
   * （第 1 个字符 `[` 被当成数组开头，第 2 个字符 `o` 才炸——看到这个错就是传了对象。）
   *
   * 所以一律先发文本。只有"读出来本来就是对象"的版本才在失败后拿对象再试一次：
   * 那种形态意味着这个版本可能吃对象，但绝大多数版本只吃文本。
   */
  async setNetworkConfig(config: Record<string, unknown>, asString: boolean): Promise<void> {
    const text = JSON.stringify(config);
    try {
      await this.call('/OB11Config/SetConfig', { config: text });
    } catch (e) {
      // 读出来就是文本 → 这个版本确定要文本，失败另有原因，别拿对象瞎撞
      if (asString) throw e;
      await this.call('/OB11Config/SetConfig', { config });
    }
  }
}
