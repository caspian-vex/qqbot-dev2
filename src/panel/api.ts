// 面板的全部业务接口。
//
// 与 Go 版 internal/panel/api.go 一一对应：路由、状态码、中文错误文案
// 全部逐字保留——前端会把 error 字段直接 toast 出来，改一个字就是改产品文案。
import type { LogHub } from '../log/hub';
import type { Logger } from '../log/logger';
import type { Store } from '../store';
import { cloneSettings, type Settings } from '../store/types';
import { formatGoDuration, localDay } from '../util/time';
import {
  hashPassword,
  newTOTPSecret,
  randomToken,
  subtleEqual,
  totpProvisioningURL,
  verifyPassword,
  verifyTOTP,
} from './auth';
import {
  appendCookie,
  assignOnto,
  clientIP,
  encodeJSON,
  HttpError,
  isSecureRequest,
  parseCookies,
  readJSON,
  serializeCookie,
  writeJSON,
  type ReqCtx,
} from './http';
import type { EnginePort, OneBotPort, QQLoginPort } from './ports';
import { SESSION_TTL_MS, type SessionInfo, type SessionStore } from './session-store';

export const COOKIE_SESSION = 'qqbot_session';
export const COOKIE_CSRF = 'qqbot_csrf';

/** 已通过鉴权的处理函数。 */
export type AuthedHandler = (ctx: ReqCtx, sess: SessionInfo) => void | Promise<void>;

export interface ApiDeps {
  store: Store;
  engine: EnginePort;
  client: OneBotPort;
  hub: LogHub;
  log: Logger;
  sessions: SessionStore;
  startedAt: number;
  qq: QQLoginPort;
  /** 机器人要连的反向 WS 端口（默认 3001），登录后自动补齐用 */
  onebotPort?: number;
}

/**
 * 确保配置里有一条启用的、监听指定端口的反向 WS。
 *
 * 兼容两种历史形状：新的 `websocketServers` 数组与老的 `websocketServer` 单对象。
 * 返回是否改动了配置——没改动就不要回写，否则每次登录都会让协议端重启一次 OneBot 服务。
 * 用户手写的 token / host 一律原样保留，这里只碰「这条监听开没开」。
 */
export function ensureWsServer(cfg: Record<string, unknown>, port: number): boolean {
  const isObj = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === 'object' && !Array.isArray(v);

  // 真机配置是 { network: {...}, musicSignUrl } ；裁剪过的版本把这几项平铺在顶层
  const net = isObj(cfg.network) ? cfg.network : cfg;

  const legacy = net.websocketServer;
  if (isObj(legacy)) {
    if (legacy.enable !== true || legacy.enabled !== true) {
      legacy.enable = true;
      legacy.enabled = true;
      return true;
    }
    return false;
  }

  const list = Array.isArray(net.websocketServers)
    ? (net.websocketServers as unknown[])
    : (net.websocketServers = [] as unknown[]);
  const arr = list.filter(isObj);

  const hit = arr.find((s) => Number(s.port) === port);
  if (!hit) {
    arr.push({
      name: 'ws',
      enable: true,
      enabled: true,
      host: '0.0.0.0',
      port,
      messagePostFormat: 'array',
      token: '',
      debug: false,
      heartInterval: 30000,
      reportSelfMessage: false,
    });
    net.websocketServers = arr;
    return true;
  }
  if (hit.enable !== true || hit.enabled !== true) {
    hit.enable = true;
    hit.enabled = true;
    return true;
  }
  return false;
}

/** 读 JSON body，失败一律翻译成 400 请求格式错误。 */
async function body(ctx: ReqCtx, limit: number): Promise<unknown> {
  try {
    return await readJSON(ctx.req, limit);
  } catch {
    throw new HttpError(400, '请求格式错误');
  }
}

/** 与 Go 的 strconv.Atoi 对齐：非法输入当 0 处理。 */
function atoi(v: string | null): number {
  if (v === null || v.trim() === '') return 0;
  const n = Number.parseInt(v, 10);
  return Number.isNaN(n) ? 0 : n;
}

/**
 * 掩码 API Key。
 *
 * 规则照抄 Go：长度 <= 8 全掩，否则留头 4 尾 4。
 * 前端提交时如果字符串里含 "****" 就视为"不修改"，
 * 所以掩码格式本身是协议的一部分，不能改成 6 位星号之类。
 */
function maskKey(k: string): string {
  if (k === '') return '';
  if (k.length <= 8) return '****';
  return `${k.slice(0, 4)}****${k.slice(k.length - 4)}`;
}

function validateSettings(v: Settings): void {
  if (v.llm.base_url === '') throw new HttpError(400, '模型地址不能为空');
  if (!v.llm.base_url.startsWith('http')) {
    throw new HttpError(400, '模型地址必须以 http(s):// 开头');
  }
  if (v.llm.model === '') throw new HttpError(400, '模型名称不能为空');
  if (v.llm.max_tokens <= 0 || v.llm.max_tokens > 8192) {
    throw new HttpError(400, '最大输出 token 应在 1-8192 之间');
  }
  if (v.llm.timeout_sec <= 0 || v.llm.timeout_sec > 300) {
    throw new HttpError(400, '超时时间应在 1-300 秒之间');
  }
  if (v.bot.passive_rate < 0 || v.bot.passive_rate > 1) {
    throw new HttpError(400, '被动接话概率应在 0-1 之间');
  }
  if (v.bot.max_concurrent < 1 || v.bot.max_concurrent > 10) {
    throw new HttpError(400, '并发数应在 1-10 之间');
  }
  if (v.bot.max_segments < 1 || v.bot.max_segments > 8) {
    throw new HttpError(400, '最大分段数应在 1-8 之间');
  }
  if (v.context.max_turns < 0 || v.context.max_turns > 50) {
    throw new HttpError(400, '上下文轮数应在 0-50 之间');
  }
  if (v.context.token_budget < 200 || v.context.token_budget > 100000) {
    throw new HttpError(400, '上下文 token 预算应在 200-100000 之间');
  }
}

export class Api {
  /**
   * 自动补齐反向 WS 的状态。
   *
   * done：已经成功补过，之后不再打扰协议端；
   * failures：连续失败次数，用来做退避——登录瞬间协议端可能正在重启 OB11 服务。
   */
  private wsFix = { done: false, busy: false, lastTry: 0, failures: 0 };

  constructor(private readonly d: ApiDeps) {}

  private get store(): Store {
    return this.d.store;
  }

  // ---- 会话 ----

  /** 下发会话与 CSRF 双 Cookie。 */
  private issueSession(ctx: ReqCtx, user: string): void {
    const token = randomToken(32);
    const csrf = randomToken(24);
    this.d.sessions.issue(token, user);

    const secure = isSecureRequest(ctx.req);
    const maxAge = Math.floor(SESSION_TTL_MS / 1000);
    appendCookie(
      ctx.res,
      serializeCookie(COOKIE_SESSION, token, {
        path: '/',
        httpOnly: true,
        secure,
        sameSite: 'Strict',
        maxAge,
      }),
    );
    appendCookie(
      ctx.res,
      serializeCookie(COOKIE_CSRF, csrf, {
        path: '/',
        // 前端要读出来塞进 X-CSRF-Token 头，所以不能 HttpOnly
        httpOnly: false,
        secure,
        sameSite: 'Strict',
        maxAge,
      }),
    );
  }

  /** 清掉两个 Cookie 并注销服务端会话。 */
  private dropCookies(ctx: ReqCtx): void {
    const token = parseCookies(ctx.req)[COOKIE_SESSION];
    if (token) this.d.sessions.drop(token);
    for (const name of [COOKIE_SESSION, COOKIE_CSRF]) {
      appendCookie(ctx.res, serializeCookie(name, '', { path: '/', maxAge: -1 }));
    }
  }

  // ---- 鉴权 ----

  /** 登录。不走 wrap：此时还没有会话，也没法要求 CSRF。 */
  async login(ctx: ReqCtx): Promise<void> {
    const ip = clientIP(ctx.req);
    const verdict = this.d.sessions.allowLogin(ip);
    if (!verdict.ok) {
      const mins = Math.floor(verdict.waitMs / 60_000) + 1;
      throw new HttpError(429, `尝试过于频繁，请 ${mins} 分钟后再试`);
    }

    const req = (await body(ctx, 4096)) as { username?: unknown; password?: unknown; totp?: unknown };
    const username = typeof req.username === 'string' ? req.username : '';
    const password = typeof req.password === 'string' ? req.password : '';
    const totp = typeof req.totp === 'string' ? req.totp : '';

    const settings = this.settings();
    const user = settings.panel.admin_user === '' ? 'admin' : settings.panel.admin_user;

    const okUser = subtleEqual(username, user);
    const okPass =
      settings.panel.password_hash !== '' &&
      (await verifyPassword(password, settings.panel.password_hash));

    if (!okUser || !okPass) {
      this.d.sessions.recordFailure(ip);
      this.store.audit.record('login.failed', '用户名或密码错误', ip);
      // 统一提示，不透露是用户名错还是密码错
      throw new HttpError(401, '用户名或密码错误');
    }

    if (settings.panel.totp_enabled && !verifyTOTP(settings.panel.totp_secret, totp)) {
      this.d.sessions.recordFailure(ip);
      this.store.audit.record('login.failed', 'TOTP 校验失败', ip);
      throw new HttpError(401, '动态验证码错误');
    }

    this.issueSession(ctx, user);
    this.d.sessions.resetFailures(ip);
    this.store.audit.record('login.ok', '登录成功', ip);

    writeJSON(ctx.res, 200, {
      ok: true,
      user,
      totp_enabled: settings.panel.totp_enabled,
    });
  }

  logout(ctx: ReqCtx, sess: SessionInfo): void {
    this.dropCookies(ctx);
    this.store.audit.record('logout', sess.user, clientIP(ctx.req));
    writeJSON(ctx.res, 200, { ok: true });
  }

  authStatus(ctx: ReqCtx, sess: SessionInfo): void {
    const settings = this.settings();
    writeJSON(ctx.res, 200, {
      user: sess.user,
      totp_enabled: settings.panel.totp_enabled,
      expires_at: sess.expires,
    });
  }

  async changePassword(ctx: ReqCtx, sess: SessionInfo): Promise<void> {
    const req = (await body(ctx, 4096)) as { old?: unknown; new?: unknown };
    const oldPw = typeof req.old === 'string' ? req.old : '';
    const newPw = typeof req.new === 'string' ? req.new : '';

    // 按字符数算而不是字节数：Go 的 len() 是字节，
    // 中文密码会因此宽松一些；这里取更严格的一侧，不影响任何 ASCII 密码。
    if ([...newPw].length < 12) throw new HttpError(400, '新密码至少 12 位');

    const settings = this.settings();
    if (
      settings.panel.password_hash !== '' &&
      !(await verifyPassword(oldPw, settings.panel.password_hash))
    ) {
      throw new HttpError(401, '原密码错误');
    }

    const hash = await hashPassword(newPw);
    try {
      this.store.settings.update((v) => {
        v.panel.password_hash = hash;
      });
    } catch (e) {
      this.d.log.error('保存密码失败', { err: e });
      throw new HttpError(500, '保存失败');
    }
    this.store.audit.record('password.changed', sess.user, clientIP(ctx.req));
    writeJSON(ctx.res, 200, { ok: true });
  }

  totpSetup(ctx: ReqCtx): void {
    const secret = newTOTPSecret();
    const settings = this.settings();
    const url = totpProvisioningURL('qqbot', settings.panel.admin_user, secret);

    // 先存下来但不启用：等用户提交一次正确验证码再打开，
    // 否则用户手一抖没扫上码就把自己锁在门外了
    try {
      this.store.settings.update((v) => {
        v.panel.totp_secret = secret;
        v.panel.totp_enabled = false;
      });
    } catch (e) {
      this.d.log.error('保存 TOTP 密钥失败', { err: e });
      throw new HttpError(500, '保存失败');
    }
    writeJSON(ctx.res, 200, { secret, url });
  }

  async totpEnable(ctx: ReqCtx, sess: SessionInfo): Promise<void> {
    const req = (await body(ctx, 1024)) as { code?: unknown };
    const code = typeof req.code === 'string' ? req.code : '';
    const settings = this.settings();
    if (settings.panel.totp_secret === '') throw new HttpError(400, '请先生成 TOTP 密钥');
    if (!verifyTOTP(settings.panel.totp_secret, code)) {
      throw new HttpError(400, '验证码不正确');
    }
    try {
      this.store.settings.update((v) => {
        v.panel.totp_enabled = true;
      });
    } catch (e) {
      this.d.log.error('启用 TOTP 失败', { err: e });
      throw new HttpError(500, '保存失败');
    }
    this.store.audit.record('totp.enabled', sess.user, clientIP(ctx.req));
    writeJSON(ctx.res, 200, { ok: true });
  }

  async totpDisable(ctx: ReqCtx, sess: SessionInfo): Promise<void> {
    const req = (await body(ctx, 1024)) as { code?: unknown };
    const code = typeof req.code === 'string' ? req.code : '';
    const settings = this.settings();
    // 关闭二步验证也要当前验证码：否则会话被盗后可以直接把二步关掉
    if (settings.panel.totp_enabled && !verifyTOTP(settings.panel.totp_secret, code)) {
      throw new HttpError(400, '验证码不正确');
    }
    try {
      this.store.settings.update((v) => {
        v.panel.totp_enabled = false;
        v.panel.totp_secret = '';
      });
    } catch (e) {
      this.d.log.error('关闭 TOTP 失败', { err: e });
      throw new HttpError(500, '保存失败');
    }
    this.store.audit.record('totp.disabled', sess.user, clientIP(ctx.req));
    writeJSON(ctx.res, 200, { ok: true });
  }

  // ---- 总览 ----

  async overview(ctx: ReqCtx): Promise<void> {
    const st = this.d.client.status();
    const stats = this.d.engine.stats();
    const settings = this.settings();

    const usage = this.store.usage.forDay(localDay());

    // 连接在不代表 QQ 在线（NapCat 自己掉线时 WebSocket 仍然是通的），
    // 所以额外问一次 get_status。失败就当离线，不能让总览页因此 500。
    let online = false;
    if (st.connected) {
      try {
        online = await this.d.client.getOnline(AbortSignal.timeout(5000));
      } catch {
        online = false;
      }
    }

    writeJSON(ctx.res, 200, {
      uptime: formatGoDuration(Date.now() - this.d.startedAt),
      self_id: st.self_id,
      nickname: st.nickname,
      connected: st.connected,
      online,
      connected_at: st.connected_at,
      last_event_at: st.last_event_at,
      reconnects: st.reconnects,
      last_error: st.last_error,
      stats,
      usage_today: usage,
      model: settings.llm.model,
      totp_enabled: settings.panel.totp_enabled,
      dedupe_size: this.d.engine.dedupeSize(),
    });
  }

  // ---- 设置 ----

  getSettings(ctx: ReqCtx): void {
    const v = this.settings();
    const out = cloneSettings(v);
    // 永远不回传明文 Key，只告诉前端"配没配"
    out.llm.api_key = maskKey(v.llm.api_key);
    out.panel.password_hash = '';
    out.panel.totp_secret = '';
    writeJSON(ctx.res, 200, out);
  }

  async putSettings(ctx: ReqCtx, sess: SessionInfo): Promise<void> {
    const cur = this.settings();

    // 在当前配置的副本上解码，而不是从零值开始。
    // 这样只传一部分字段也能正确更新；从零值开始会让缺省字段变空，
    // 校验直接报"模型地址不能为空"——调用方传的明明是合法请求。
    const inp = cloneSettings(cur);
    inp.panel.password_hash = '';
    inp.panel.totp_secret = '';

    const patch = await body(ctx, 64 * 1024);
    try {
      assignOnto(inp, patch);
    } catch {
      throw new HttpError(400, '请求格式错误');
    }
    validateSettings(inp);

    let updated: Settings;
    try {
      updated = this.store.settings.update((v) => {
        v.llm = { ...inp.llm };
        // 前端传空串或掩码表示"不修改"
        if (inp.llm.api_key === '' || inp.llm.api_key.includes('****')) {
          v.llm.api_key = cur.llm.api_key;
        }
        v.bot = {
          ...inp.bot,
          wake_words: [...inp.bot.wake_words],
          whitelist_groups: [...inp.bot.whitelist_groups],
          blacklist_users: [...inp.bot.blacklist_users],
        };
        v.context = { ...inp.context };
        // 面板凭据只能走专门的接口改，这里不覆盖
        v.panel = { ...cur.panel };
      });
    } catch (e) {
      this.d.log.error('保存设置失败', { err: e });
      throw new HttpError(500, '保存失败');
    }
    this.store.audit.record('settings.updated', sess.user, clientIP(ctx.req));

    const out = cloneSettings(updated);
    out.llm.api_key = maskKey(updated.llm.api_key);
    out.panel.password_hash = '';
    out.panel.totp_secret = '';
    writeJSON(ctx.res, 200, out);
  }

  // ---- 人格 ----

  listPersonas(ctx: ReqCtx): void {
    // 先取 active 再取 list：active() 会在首次运行时落一个默认人格。
    // 顺序反过来的话，全新数据库上的第一次请求会拿到 items: []，
    // 前端人格页就会是空的（Go 版靠启动时的引擎调用掩盖了这一点）。
    const active = this.store.personas.active();
    let items;
    try {
      items = this.store.personas.list();
    } catch (e) {
      this.d.log.error('读取人格失败', { err: e });
      throw new HttpError(500, '读取人格失败');
    }
    writeJSON(ctx.res, 200, { items, active });
  }

  async upsertPersona(ctx: ReqCtx): Promise<void> {
    const req = (await body(ctx, 64 * 1024)) as { name?: unknown; system_prompt?: unknown };
    const name = typeof req.name === 'string' ? req.name : '';
    const prompt = typeof req.system_prompt === 'string' ? req.system_prompt : '';

    if (name.trim() === '') throw new HttpError(400, '人格名不能为空');
    if (Buffer.byteLength(prompt, 'utf8') > 32 * 1024) {
      throw new HttpError(400, '提示词过长（上限 32KB）');
    }

    let p;
    try {
      p = this.store.personas.upsert(name, prompt);
    } catch (e) {
      this.d.log.error('保存人格失败', { err: e });
      throw new HttpError(500, '保存失败');
    }
    this.store.audit.record('persona.saved', name, clientIP(ctx.req));
    writeJSON(ctx.res, 200, p);
  }

  async activatePersona(ctx: ReqCtx): Promise<void> {
    const req = (await body(ctx, 1024)) as { id?: unknown };
    const id = typeof req.id === 'number' ? req.id : 0;
    try {
      this.store.personas.activate(id);
    } catch (e) {
      this.d.log.warn('切换人格失败', { id, err: e });
      throw new HttpError(400, '切换失败');
    }
    this.store.audit.record('persona.activated', String(id), clientIP(ctx.req));
    writeJSON(ctx.res, 200, { ok: true });
  }

  // ---- 会话 ----

  listSessions(ctx: ReqCtx): void {
    let items;
    try {
      items = this.store.sessions.list();
    } catch (e) {
      this.d.log.error('读取会话失败', { err: e });
      throw new HttpError(500, '读取会话失败');
    }
    writeJSON(ctx.res, 200, { items });
  }

  /** 某会话最近的对话记录，供面板查看上下文。 */
  sessionMessages(ctx: ReqCtx): void {
    const id = (ctx.query.get('id') ?? '').trim();
    if (id === '') throw new HttpError(400, '会话 ID 不能为空');

    let limit = atoi(ctx.query.get('limit'));
    if (limit <= 0 || limit > 200) limit = 50;

    let items;
    try {
      items = this.store.sessions.recent(id, limit);
    } catch (e) {
      this.d.log.error('读取消息失败', { err: e });
      throw new HttpError(500, '读取消息失败');
    }
    writeJSON(ctx.res, 200, { items });
  }

  async clearSession(ctx: ReqCtx, sess: SessionInfo): Promise<void> {
    const req = (await body(ctx, 1024)) as { id?: unknown };
    const id = typeof req.id === 'string' ? req.id : '';
    if (id === '') throw new HttpError(400, '会话 ID 不能为空');
    try {
      this.store.sessions.clear(id);
    } catch (e) {
      this.d.log.error('清空会话失败', { err: e, id });
      throw new HttpError(500, '清空失败');
    }
    this.store.audit.record('session.cleared', id, clientIP(ctx.req));
    writeJSON(ctx.res, 200, { ok: true });
  }

  // ---- 用量与审计 ----

  usage(ctx: ReqCtx): void {
    let days = atoi(ctx.query.get('days'));
    if (days <= 0 || days > 30) days = 7;

    let items;
    try {
      items = this.store.usage.recent(days);
    } catch (e) {
      this.d.log.error('读取用量失败', { err: e });
      throw new HttpError(500, '读取用量失败');
    }
    writeJSON(ctx.res, 200, {
      today: this.store.usage.forDay(localDay()),
      items,
    });
  }

  audit(ctx: ReqCtx): void {
    let items;
    try {
      items = this.store.audit.list(100);
    } catch (e) {
      this.d.log.error('读取审计失败', { err: e });
      throw new HttpError(500, '读取审计失败');
    }
    writeJSON(ctx.res, 200, { items });
  }

  // ---- 测试发送 ----

  async testSend(ctx: ReqCtx, sess: SessionInfo): Promise<void> {
    const req = (await body(ctx, 8192)) as {
      target_type?: unknown;
      target_id?: unknown;
      text?: unknown;
    };
    const targetType = typeof req.target_type === 'string' ? req.target_type : '';
    const targetID = typeof req.target_id === 'number' ? req.target_id : 0;
    const text = typeof req.text === 'string' ? req.text : '';

    if (text.trim() === '') throw new HttpError(400, '消息内容不能为空');
    if (targetID === 0) throw new HttpError(400, '目标不能为空');

    let id: number;
    try {
      if (targetType === 'group') {
        id = await this.d.client.sendGroupMsg(targetID, text, AbortSignal.timeout(20_000));
      } else if (targetType === 'private') {
        id = await this.d.client.sendPrivateMsg(targetID, text, AbortSignal.timeout(20_000));
      } else {
        throw new HttpError(400, '目标类型只能是 group 或 private');
      }
    } catch (e) {
      if (e instanceof HttpError) throw e;
      throw new HttpError(502, `发送失败：${(e as Error).message}`);
    }

    this.store.audit.record('test.send', `${targetType}:${targetID}`, clientIP(ctx.req));
    writeJSON(ctx.res, 200, { ok: true, message_id: id });
  }

  // ---- 群与好友 ----

  async groups(ctx: ReqCtx): Promise<void> {
    try {
      const items = await this.d.client.getGroupList(AbortSignal.timeout(10_000));
      writeJSON(ctx.res, 200, { items });
    } catch (e) {
      throw new HttpError(502, `拉取群列表失败：${(e as Error).message}`);
    }
  }

  async friends(ctx: ReqCtx): Promise<void> {
    try {
      const items = await this.d.client.getFriendList(AbortSignal.timeout(10_000));
      writeJSON(ctx.res, 200, { items });
    } catch (e) {
      throw new HttpError(502, `拉取好友列表失败：${(e as Error).message}`);
    }
  }

  // ---- 日志 SSE ----

  /**
   * 日志流。
   *
   * 三个细节不能省：
   *   - X-Accel-Buffering: no —— 否则 nginx 会攒满一个缓冲区才吐
   *   - 25 秒心跳 —— 否则反代会掐掉空闲连接
   *   - 先补发最近 100 条 —— 否则页面打开时是空的，要等下一条日志才动
   */
  logs(ctx: ReqCtx): void {
    const { req, res } = ctx;

    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();

    let closed = false;
    const send = (payload: string): boolean => {
      if (closed) return false;
      return res.write(payload);
    };

    // 一个事件 = "data: " + JSON + 空行。encodeJSON 已经带了结尾换行，
    // 这里再补一个才是 SSE 要求的 \n\n；少一个的话浏览器会一直等
    // 下一条消息来终止这个事件，表现为日志页空白。
    const frame = (line: Parameters<typeof encodeJSON>[0]): string => `data: ${encodeJSON(line)}\n`;

    for (const line of this.d.hub.recent(100)) {
      if (!send(frame(line))) break;
    }

    const unsubscribe = this.d.hub.subscribe((line) => {
      // 客户端读得慢时 res.write 返回 false：照写不误，
      // 让 Node 自己缓冲——日志丢了比卡住主线程更糟
      send(frame(line));
    });

    const ping = setInterval(() => {
      if (!send(': ping\n\n')) {
        /* 写失败下一轮 close 事件会处理 */
      }
    }, 25_000);
    ping.unref();

    const cleanup = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(ping);
      unsubscribe();
      res.end();
    };

    req.on('close', cleanup);
    res.on('close', cleanup);
  }

  // ---- 扫码登录 QQ ----
  //
  // 这五个接口是 Go 版没有的新增能力：把「扫码登录」从协议端的 6099 WebUI
  // 搬进面板侧边栏，用户只需要记面板一套凭据。
  // 服务端持有 WEBUI_TOKEN，浏览器永远看不到它。

  /** 当前登录状态。未配置 WebUI 时 configured=false，前端据此隐藏入口。 */
  async qqStatus(ctx: ReqCtx): Promise<void> {
    const qq = this.d.qq;
    if (!qq.configured) {
      writeJSON(ctx.res, 200, {
        configured: false,
        login: false,
        offline: false,
        uin: '',
        nick: '',
        phase: '',
        error: '',
      });
      return;
    }

    const st = await qq.status();
    // 已登录时补一次账号信息：CheckLoginStatus 在部分版本里不返回 nick
    if (st.login && (st.uin === '' || st.nick === '')) {
      try {
        const info = await qq.loginInfo();
        if (st.uin === '') st.uin = info.uin;
        if (st.nick === '') st.nick = info.nick;
      } catch {
        // 拿不到昵称不影响"已登录"这个结论
      }
    }
    writeJSON(ctx.res, 200, { configured: true, ...st });

    // 登录成功后才允许改 OB11Config，所以「补 3001」这件事必须挂在这里。
    // 不 await：状态接口是前端 2 秒轮询的，不能让它等协议端重启。
    if (st.login) this.maybeFixOneBotWs();
  }

  /**
   * 后台心跳：没人开面板时也要能把 3001 补上。
   *
   * 前端轮询只在页面开着时有效，而「扫完码就把标签页关了」是很常见的操作。
   * 所以服务端自己也隔一会儿看一眼登录状态，补完一次（wsFix.done）就不再查。
   * 不抛异常：这是后台任务，失败只记日志。
   */
  async tick(): Promise<void> {
    if (!this.d.qq.configured || this.wsFix.done) return;
    try {
      const st = await this.d.qq.status();
      if (st.login) this.maybeFixOneBotWs();
    } catch {
      // 协议端还没起来 / 正在重启，下一轮再说
    }
  }

  /**
   * 登录成功后自动确保协议端开了反向 WS。
   *
   * 为什么非做不可：NapCat 的出厂配置里没有任何 3001 监听。扫码只代表 QQ 登上了，
   * 机器人照样一直重连——以前的说明书是让用户自己去「网络」页点一次
   * 「修正反向 WS（:3001）」，第一次部署十有八九卡在这一步。
   * 这里做成幂等 + 退避：成功一次就收手，失败按 1s/2s/4s…最多 60s 重试。
   */
  private maybeFixOneBotWs(): void {
    const port = this.d.onebotPort ?? 3001;
    const s = this.wsFix;
    if (s.done || s.busy || !this.d.qq.configured) return;

    const now = Date.now();
    if (now - s.lastTry < Math.min(1000 * 2 ** s.failures, 60_000)) return;

    s.busy = true;
    s.lastTry = now;
    void (async () => {
      try {
        const cfg = await this.d.qq.networkConfig();
        if (ensureWsServer(cfg.config, port)) {
          await this.d.qq.setNetworkConfig(cfg.config, cfg.asString);
          this.d.log.info('已自动开启协议端反向 WS', { port });
        }
        s.done = true;
        s.failures = 0;
      } catch (e) {
        s.failures += 1;
        this.d.log.warn('自动开启反向 WS 失败，可在「网络」页手动修正', {
          port,
          err: e instanceof Error ? e.message : String(e),
        });
      } finally {
        s.busy = false;
      }
    })();
  }

  /** 取二维码（PNG data URL）。每次调用都会让协议端刷新二维码。 */
  async qqQrcode(ctx: ReqCtx): Promise<void> {
    const qq = this.d.qq;
    if (!qq.configured) throw new HttpError(503, '未配置协议端 WebUI，无法扫码登录');
    const qr = await qq.qrcode();
    writeJSON(ctx.res, 200, { image: qr.image });
  }

  /** 本地已保存的账号，用于一键重登（不用再扫码）。 */
  async qqQuickLoginList(ctx: ReqCtx): Promise<void> {
    const qq = this.d.qq;
    if (!qq.configured) {
      writeJSON(ctx.res, 200, { items: [] });
      return;
    }
    let items: unknown[] = [];
    try {
      items = await qq.quickLoginList();
    } catch (e) {
      // 拿不到快捷登录列表不影响扫码，前端把它当"没有已保存账号"处理
      this.d.log.debug('拉取快捷登录列表失败', { err: e });
    }
    writeJSON(ctx.res, 200, { items });
  }

  async qqQuickLogin(ctx: ReqCtx, sess: SessionInfo): Promise<void> {
    const qq = this.d.qq;
    if (!qq.configured) throw new HttpError(503, '未配置协议端 WebUI，无法快捷登录');
    const req = (await body(ctx, 1024)) as { uin?: unknown };
    const uin = typeof req.uin === 'string' ? req.uin.trim() : '';
    if (uin === '') throw new HttpError(400, '账号不能为空');

    await qq.quickLogin(uin);
    this.store.audit.record('qq.quick_login', uin, clientIP(ctx.req));
    void sess;
    writeJSON(ctx.res, 200, { ok: true });
  }

  async qqLogout(ctx: ReqCtx, sess: SessionInfo): Promise<void> {
    const qq = this.d.qq;
    if (!qq.configured) throw new HttpError(503, '未配置协议端 WebUI');
    await qq.logout();
    this.store.audit.record('qq.logout', sess.user, clientIP(ctx.req));
    writeJSON(ctx.res, 200, { ok: true });
  }

  /**
   * 协议端网络配置（OneBot11）。
   *
   * 这替代了「再暴露一个 6099 端口让用户去改高级网络配置」的做法：
   * 面板直接把协议端的配置读出来给前端编辑。
   * 前提是 QQ 已登录——协议端未登录时这个接口一律拒绝，
   * 所以前端会先查一次登录状态再决定给不给编辑框。
   */
  async qqNetwork(ctx: ReqCtx): Promise<void> {
    const qq = this.d.qq;
    if (!qq.configured) throw new HttpError(503, '未配置协议端 WebUI，无法读取网络配置');
    try {
      const cfg = await qq.networkConfig();
      writeJSON(ctx.res, 200, { config: cfg.config, as_string: cfg.asString });
    } catch (e) {
      // 未登录时协议端返回 "Not Login"，原样透出比一句"内部错误"有用得多
      throw new HttpError(502, `读取网络配置失败：${(e as Error).message}`);
    }
  }

  /** 保存网络配置。只接受对象，避免前端传半截字符串把协议端配崩。 */
  async qqNetworkSave(ctx: ReqCtx, sess: SessionInfo): Promise<void> {
    const qq = this.d.qq;
    if (!qq.configured) throw new HttpError(503, '未配置协议端 WebUI，无法保存网络配置');

    const req = (await body(ctx, 512 * 1024)) as { config?: unknown; as_string?: unknown };
    const cfg = req.config;
    if (cfg === null || typeof cfg !== 'object' || Array.isArray(cfg)) {
      throw new HttpError(400, '配置必须是一个 JSON 对象');
    }

    try {
      await qq.setNetworkConfig(cfg as Record<string, unknown>, req.as_string === true);
    } catch (e) {
      throw new HttpError(502, `保存网络配置失败：${(e as Error).message}`);
    }
    this.store.audit.record('qq.network_updated', sess.user, clientIP(ctx.req));
    writeJSON(ctx.res, 200, { ok: true });
  }

  // ---- 内部 ----

  /** 读设置；失败时退回出厂默认值，避免面板整页打不开。 */
  private settings(): Settings {
    try {
      return this.store.settings.get();
    } catch (e) {
      this.d.log.error('读取配置失败', { err: e });
      throw new HttpError(500, '读取配置失败');
    }
  }
}
