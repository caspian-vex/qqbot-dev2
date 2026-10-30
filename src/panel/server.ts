// 面板 HTTP 服务：路由表、鉴权中间件、安全响应头、启动与优雅退出。
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { LogHub } from '../log/hub';
import { Logger } from '../log/logger';
import type { Store } from '../store';
import { formatGoDuration } from '../util/time';
import { BUILD_DATE, COMMIT, VERSION } from '../version';
import { Api, COOKIE_CSRF, COOKIE_SESSION } from './api';
import { subtleEqual } from './auth';
import {
  HttpError,
  makeStaticHandler,
  parseCookies,
  Router,
  writeErr,
  writeJSON,
  writeNotFound,
  type Handler,
  type ReqCtx,
} from './http';
import type { ApprovalQueue } from '../bot/computer-approval';
import { nullEngine, nullOneBot, nullQQLogin, type EnginePort, type OneBotPort, type QQLoginPort } from './ports';
import { SessionStore, type SessionInfo } from './session-store';

export interface PanelOptions {
  store: Store;
  log: Logger;
  /** 前端静态资源目录（web/dist）。 */
  webDir: string;
  engine?: EnginePort;
  client?: OneBotPort;
  /** 协议端 WebUI 控制能力；不传时扫码登录入口显示为未配置。 */
  qq?: QQLoginPort;
  /** 机器人要连的反向 WS 端口；登录成功后自动补齐这条监听。 */
  onebotPort?: number;
  /** 自动补齐反向 WS 时写进监听条目的 token（空串 = 不设 token）。 */
  onebotAccessToken?: string;
  /** 图池目录（数据目录下的 images/）；不传时图池页显示为空。 */
  imagesDir?: string;
  /**
   * 待批准队列。**必须和引擎共用同一个实例**，否则引擎挂起的申请面板看不见，
   * 每次执行都会以"等待批准超时"收场。不传就是空队列（测试与旧调用方够用）。
   */
  approvals?: ApprovalQueue;
  hub?: LogHub;
}

export class PanelServer {
  readonly hub: LogHub;
  readonly sessions = new SessionStore();

  private readonly api: Api;
  private readonly router: Router;
  private readonly log: Logger;
  private readonly startedAt = Date.now();
  private server: Server | null = null;
  private sweepTimer: NodeJS.Timeout | null = null;
  private wsTimer: NodeJS.Timeout | null = null;

  constructor(private readonly opt: PanelOptions) {
    this.hub = opt.hub ?? new LogHub(500);
    this.log = opt.log.with({ component: 'panel' });

    this.api = new Api({
      store: opt.store,
      engine: opt.engine ?? nullEngine(),
      client: opt.client ?? nullOneBot(),
      hub: this.hub,
      log: this.log,
      sessions: this.sessions,
      startedAt: this.startedAt,
      qq: opt.qq ?? nullQQLogin(),
      onebotPort: opt.onebotPort,
      onebotAccessToken: opt.onebotAccessToken,
      imagesDir: opt.imagesDir,
      computer: opt.approvals,
    });

    this.router = this.buildRouter();
  }

  // ---- 路由 ----

  private buildRouter(): Router {
    const r = new Router();
    const a = this.api;

    // 探活：不需要鉴权，供 docker healthcheck 与反代使用
    r.add('GET', '/healthz', (ctx) => this.healthz(ctx));

    // 鉴权
    r.add('POST', '/api/auth/login', (ctx) => a.login(ctx));
    // 登出是状态变更（销毁会话），同样要双提交校验。前端对非 GET 请求统一带
    // X-CSRF-Token，改成 true 不影响交互；少了它，任何能发跨站 POST 的页面
    // 都能把管理员踹下线（现在靠 SameSite=Strict 兜着，但那不该是唯一防线）。
    r.add('POST', '/api/auth/logout', this.wrap((c, s) => a.logout(c, s), true));
    r.add('GET', '/api/auth/status', this.wrap((c, s) => a.authStatus(c, s), false));
    r.add('POST', '/api/auth/password', this.wrap((c, s) => a.changePassword(c, s), true));
    r.add('POST', '/api/auth/username', this.wrap((c, s) => a.changeUsername(c, s), true));
    r.add('POST', '/api/auth/totp/setup', this.wrap((c, s) => a.totpSetup(c, s), true));
    r.add('POST', '/api/auth/totp/enable', this.wrap((c, s) => a.totpEnable(c, s), true));
    r.add('POST', '/api/auth/totp/disable', this.wrap((c, s) => a.totpDisable(c, s), true));

    // 业务接口
    r.add('GET', '/api/overview', this.wrap((c) => a.overview(c), false));
    // 机器人总开关。与 QQ 登录态无关：关掉只是不说话了，连接和在线都不动。
    r.add('GET', '/api/bot', this.wrap((c) => a.getBot(c), false));
    r.add('POST', '/api/bot', this.wrap((c, s) => a.setBot(c, s), true));
    r.add('GET', '/api/settings', this.wrap((c) => a.getSettings(c), false));
    r.add('PUT', '/api/settings', this.wrap((c, s) => a.putSettings(c, s), true));
    r.add('GET', '/api/personas', this.wrap((c) => a.listPersonas(c), false));
    r.add('PUT', '/api/personas', this.wrap((c) => a.upsertPersona(c), true));
    r.add('POST', '/api/personas/activate', this.wrap((c) => a.activatePersona(c), true));
    r.add('DELETE', '/api/personas', this.wrap((c, s) => a.deletePersona(c, s), true));
    r.add('GET', '/api/sessions', this.wrap((c) => a.listSessions(c), false));
    r.add('GET', '/api/sessions/messages', this.wrap((c) => a.sessionMessages(c), false));
    r.add('POST', '/api/sessions/clear', this.wrap((c, s) => a.clearSession(c, s), true));
    r.add('POST', '/api/sessions/persona', this.wrap((c) => a.bindSessionPersona(c), true));
    // 会话级设置：按对话对象覆盖触发规则/主动发言/图池/识图/搜索/上下文
    r.add('GET', '/api/sessions/settings', this.wrap((c) => a.sessionSettings(c), false));
    r.add('PUT', '/api/sessions/settings', this.wrap((c, s) => a.putSessionSettings(c), true));
    // 电脑操作的待批准：GET 免 CSRF（只读），POST 点批准必须带 token
    r.add('GET', '/api/computer/pending', this.wrap((c) => a.computerPending(c), false));
    r.add('POST', '/api/computer/decide', this.wrap((c, s) => a.computerDecide(c, s), true));
    r.add('GET', '/api/usage', this.wrap((c) => a.usage(c), false));
    r.add('GET', '/api/audit', this.wrap((c) => a.audit(c), false));
    r.add('POST', '/api/test/send', this.wrap((c, s) => a.testSend(c, s), true));
    r.add('GET', '/api/logs', this.wrap((c) => a.logs(c), false));
    r.add('GET', '/api/groups', this.wrap((c) => a.groups(c), false));
    r.add('GET', '/api/friends', this.wrap((c) => a.friends(c), false));
    r.add('GET', '/api/images', this.wrap((c) => a.images(c), false));
    // 图池管理：标签增删改、上传、删除、原图预览
    r.add('GET', '/api/image-tags', this.wrap((c) => a.images(c), false));
    r.add('PUT', '/api/image-tags', this.wrap((c, s) => a.saveImageTag(c, s), true));
    r.add('POST', '/api/image-tags/rename', this.wrap((c, s) => a.renameImageTag(c, s), true));
    r.add('DELETE', '/api/image-tags', this.wrap((c, s) => a.deleteImageTag(c, s), true));
    r.add('POST', '/api/images/upload', this.wrap((c, s) => a.uploadImage(c, s), true));
    r.add('DELETE', '/api/images', this.wrap((c, s) => a.deleteImage(c, s), true));
    r.add('GET', '/api/images/raw', this.wrap((c) => a.imageRaw(c), false));

    // 长期记忆：事实与日摘要的查看/编辑/删除，以及手动触发一次整理
    r.add('GET', '/api/memories', this.wrap((c) => a.listMemories(c), false));
    r.add('POST', '/api/memories', this.wrap((c, s) => a.saveMemory(c, s), true));
    r.add('PUT', '/api/memories', this.wrap((c, s) => a.updateMemory(c, s), true));
    r.add('DELETE', '/api/memories', this.wrap((c, s) => a.deleteMemory(c, s), true));
    r.add('POST', '/api/memories/clear', this.wrap((c, s) => a.clearMemories(c, s), true));
    r.add('POST', '/api/memories/digest', this.wrap((c, s) => a.digestMemory(c, s), true));
    r.add('DELETE', '/api/memories/day', this.wrap((c, s) => a.deleteDaySummary(c, s), true));

    // 扫码登录 QQ（Go 版没有的新增能力）
    r.add('GET', '/api/qq/status', this.wrap((c) => a.qqStatus(c), false));
    r.add('POST', '/api/qq/qrcode', this.wrap((c) => a.qqQrcode(c), true));
    r.add('GET', '/api/qq/quick-login', this.wrap((c) => a.qqQuickLoginList(c), false));
    r.add('POST', '/api/qq/quick-login', this.wrap((c, s) => a.qqQuickLogin(c, s), true));
    r.add('POST', '/api/qq/logout', this.wrap((c, s) => a.qqLogout(c, s), true));
    r.add('GET', '/api/qq/network', this.wrap((c) => a.qqNetwork(c), false));
    r.add('PUT', '/api/qq/network', this.wrap((c, s) => a.qqNetworkSave(c, s), true));

    // 前端静态资源 + SPA 兜底
    r.setFallback(makeStaticHandler(this.opt.webDir));
    return r;
  }

  /**
   * 鉴权 + CSRF 中间件。
   *
   * needCSRF 为 true 时要求请求头 X-CSRF-Token 与 cookie 一致（双提交）。
   * 为什么登录接口不需要：登录时还没有 cookie，无从比对；
   * 登录接口自身靠 SameSite=Strict 和限流保护。
   */
  private wrap(h: (ctx: ReqCtx, sess: SessionInfo) => void | Promise<void>, needCSRF: boolean): Handler {
    return async (ctx) => {
      const sess = this.currentSession(ctx.req);
      if (!sess) throw new HttpError(401, '未登录或会话已过期');
      if (needCSRF && !this.checkCSRF(ctx.req)) {
        throw new HttpError(403, 'CSRF 校验失败，请刷新页面重试');
      }
      await h(ctx, sess);
    };
  }

  private currentSession(req: ReqCtx['req']): SessionInfo | null {
    const token = parseCookies(req)[COOKIE_SESSION];
    if (!token) return null;
    return this.sessions.get(token);
  }

  private checkCSRF(req: ReqCtx['req']): boolean {
    const cookie = parseCookies(req)[COOKIE_CSRF];
    if (!cookie) return false;
    const header = req.headers['x-csrf-token'];
    if (typeof header !== 'string' || header === '') return false;
    return subtleEqual(cookie, header);
  }

  /**
   * 探活。刻意免鉴权：docker healthcheck、反代与 qqbotctl 都只看 200。
   *
   * 顺带带上版本三元组——它是整个进程里唯一一个「不需要会话就能读到版本」的
   * 地方，登录页要在用户还没登进来时就把版本显示在页脚，只能读这里。
   * 加字段对老的探活调用方无害（它们只看状态码）。
   */
  private healthz(ctx: ReqCtx): void {
    writeJSON(ctx.res, 200, {
      status: 'ok',
      uptime: formatGoDuration(Date.now() - this.startedAt),
      version: VERSION,
      commit: COMMIT,
      build_date: BUILD_DATE,
    });
  }

  // ---- 请求入口 ----

  handler(): (req: ReqCtx['req'], res: ReqCtx['res']) => void {
    return (req, res) => {
      // 这道 catch 是最后一道网，不是 dispatch 内部 try 的替代：dispatch 里
      // 仍有可能在 try 之外抛（例如安全头 setHeader 阶段，或未来新加的准备工作）。
      // 少了它，async 函数的拒绝就没人接管，Node 22 默认把未处理拒绝升级为
      // 进程退出——一条畸形请求就能让机器人在重启循环里出不来。
      void this.dispatch(req, res).catch((e: unknown) => {
        this.log.error('面板请求未捕获异常', { err: e });
        if (res.headersSent) {
          res.destroy();
          return;
        }
        try {
          writeErr(res, 500, '服务器内部错误');
        } catch {
          res.destroy();
        }
      });
    };
  }

  private async dispatch(req: ReqCtx['req'], res: ReqCtx['res']): Promise<void> {
    // 安全头先挂上：即使后面 404/500 也要带，避免响应头缺失被扫描器记一笔
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader(
      'Content-Security-Policy',
      "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
        "script-src 'self'; connect-src 'self'; frame-ancestors 'self'",
    );

    // new URL 必须在 try 里：Node 的解析器对 "//[" 这类伪 request-target 会抛
    // ERR_INVALID_URL，而这一行原本在下面 try 之外。Node 的 llhttp 接受这种请求行，
    // 于是"未登录 + 一条畸形请求"就能把进程打掉。
    let url: URL;
    try {
      url = new URL(req.url ?? '/', 'http://panel.local');
    } catch {
      writeErr(res, 400, '请求地址不合法');
      return;
    }
    let path: string;
    try {
      path = decodeURIComponent(url.pathname);
    } catch {
      path = url.pathname;
    }

    const ctx: ReqCtx = { req, res, path, query: url.searchParams };
    const handler = this.resolveHandler(ctx);

    try {
      if (!handler) {
        writeNotFound(res);
        return;
      }
      await handler(ctx);
    } catch (e) {
      if (res.headersSent) {
        // SSE 之类的长响应已经开头了，只能掐断；再写响应头会抛 ERR_HTTP_HEADERS_SENT
        res.end();
        return;
      }
      if (e instanceof HttpError) {
        writeErr(res, e.status, e.message);
        return;
      }
      this.log.error('面板请求处理失败', {
        path,
        method: req.method ?? '',
        err: e instanceof Error ? e.message : String(e),
      });
      writeErr(res, 500, '服务器内部错误');
    }
  }

  /**
   * 协议端原生 WebUI 的反代已移除。
   *
   * 原先 /webui/* 与未注册的 /api/* 会转给 NapCat，等于把它的整套管理界面
   * （网络配置、进程控制、插件）挂到面板后面。现在只保留"让机器人保持在线"
   * 所需的能力，全部收在面板自己的 /api/qq/* 里——浏览器拿不到 NapCat 凭据，
   * 也就不需要为那份前端产物放宽 CSP 了。
   */
  private resolveHandler(ctx: ReqCtx): Handler | null {
    // 未命中的路径仍按 Go ServeMux 的语义回落到静态兜底：
    // 前端只有一个页面，/anything 都该出 index.html。
    return this.router.dispatch(ctx);
  }

  // ---- 生命周期 ----

  /** 开始监听。返回实际绑定端口（listen 里写 0 时有用，测试用）。 */
  async listen(listen: string): Promise<number> {
    const { host, port } = splitHostPort(listen);
    const server = createServer(this.handler());

    // 读请求头限时，防慢速攻击；requestTimeout 关掉，
    // 因为它是"整个请求读完"的时限，会把 SSE 长连接误杀
    server.headersTimeout = 10_000;
    server.requestTimeout = 0;
    server.keepAliveTimeout = 120_000;
    server.timeout = 0;

    await new Promise<void>((resolve, reject) => {
      const onError = (e: Error): void => reject(e);
      server.once('error', onError);
      server.listen(port, host, () => {
        server.off('error', onError);
        resolve();
      });
    });

    this.server = server;

    // 会话/限流记录定时清扫（Go 版是惰性删除，会话表会无上限增长）
    this.sweepTimer = setInterval(() => this.sessions.sweep(), 10 * 60_000);
    this.sweepTimer.unref();

    // 后台补一次反向 WS：扫码后用户往往直接关掉面板，
    // 只靠前端轮询的话机器人会一直连不上（见 Api.tick 的说明）
    this.wsTimer = setInterval(() => {
      void this.tick();
    }, 20_000);
    this.wsTimer.unref();

    const addr = server.address() as AddressInfo | null;
    this.log.info('面板已启动', { listen });
    return addr?.port ?? port;
  }

  /**
   * 后台心跳的一轮（每 20 秒由定时器调用）。
   *
   * 单独暴露成方法而不是留在闭包里，是为了让"补反向 WS"这条副作用有
   * 唯一且可测的入口——它已经不能挂在 GET /api/qq/status 上了。
   */
  async tick(): Promise<void> {
    await this.api.tick();
  }

  /** 优雅退出：先停止接受新连接，再等已有请求（含 SSE）自然结束。 */
  async close(graceMs = 5000): Promise<void> {
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    if (this.wsTimer) {
      clearInterval(this.wsTimer);
      this.wsTimer = null;
    }
    const server = this.server;
    if (!server) return;
    this.server = null;

    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        server.closeAllConnections();
        resolve();
      }, graceMs);
      timer.unref();

      server.close(() => {
        clearTimeout(timer);
        resolve();
      });
      // SSE 连接不会自己断，通知它们收尾
      server.closeIdleConnections();
    });
  }
}

/**
 * 拆分监听地址。
 *
 * 支持 "0.0.0.0:5666"、":5666"、"5666"、"127.0.0.1:0" 几种写法。
 * 容器里必须监听 0.0.0.0，否则端口映射打不进来——这是最常见的
 * "容器 healthy 但浏览器连不上"的成因。
 */
export function splitHostPort(listen: string): { host: string; port: number } {
  const v = listen.trim();
  if (v === '') return { host: '0.0.0.0', port: 5666 };

  // IPv6 字面量：[::]:5666
  const v6 = /^\[([^\]]*)\]:(\d+)$/.exec(v);
  if (v6) return { host: v6[1] ?? '::', port: Number(v6[2]) };

  const idx = v.lastIndexOf(':');
  if (idx < 0) {
    const port = Number(v);
    return { host: '0.0.0.0', port: Number.isFinite(port) ? port : 5666 };
  }
  const host = v.slice(0, idx);
  const port = Number(v.slice(idx + 1));
  return {
    host: host === '' ? '0.0.0.0' : host,
    port: Number.isFinite(port) ? port : 5666,
  };
}
