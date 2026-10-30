// 面板的 HTTP 基础设施：路由、JSON 序列化、Cookie、静态资源。
//
// 这里刻意复刻 Go 1.22 http.ServeMux 的语义，因为前端是原样复用的：
//   - 路径命中但方法不对 → 405（不是 404），并带 Allow 头
//   - GET 模式同时接受 HEAD
//   - "GET /" 是子树模式，未命中的 GET 会落到它上面 → 静态兜底 → SPA
// 用现成框架（express 之类）反而要花更多代码把这些行为改回去。
import { createReadStream, statSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isIP } from 'node:net';
import { join, normalize, resolve, sep } from 'node:path';
import { rfc3339 } from '../util/time';

export interface ReqCtx {
  req: IncomingMessage;
  res: ServerResponse;
  /** 已解码的路径，等价 Go 的 r.URL.Path */
  path: string;
  /** 查询串，等价 Go 的 r.URL.Query() */
  query: URLSearchParams;
}

export type Handler = (ctx: ReqCtx) => void | Promise<void>;

/**
 * 把一个文件流式写给客户端。
 *
 * 为什么不能直接 `createReadStream(p).pipe(res)`：pipe 只接管数据流向，不给
 * **源流**装 error 监听。stat 通过之后、open 之前文件被删（图池并发删除）、
 * 权限被改（EACCES）、inode 不可读，ReadStream 都会 emit 'error'；EventEmitter
 * 在无监听者时直接抛出，整个进程退出。这条路径上任何一个错误都只该断掉这条
 * 连接，不该带走机器人。
 */
export function pipeFile(res: ServerResponse, path: string): void {
  const stream = createReadStream(path);
  stream.on('error', () => {
    res.destroy();
  });
  // 客户端中途断开（刷新、关标签）时把读句柄回收，否则 fd 要等 GC 才释放
  res.on('close', () => {
    stream.destroy();
  });
  stream.pipe(res);
}

// ---- 响应 ----

/**
 * 序列化成 Go json.Encoder + SetEscapeHTML(false) 的输出。
 *
 * 三个必须对齐的点：
 *   1. 不转义 < > &（SetEscapeHTML(false) 的语义）
 *   2. 转义 U+2028/U+2029（Go 会转，JSON.stringify 不会）
 *   3. 末尾带一个换行（Encoder.Encode 的行为）
 *
 * 时间字段必须在这里换掉：JSON.stringify 会先调 Date.prototype.toJSON
 * 再交给 replacer，等 replacer 看到值时它已经是 "….000Z" 的 UTC 串了。
 * 所以只能先深拷贝一遍把 Date 换掉，不能靠 replacer 补救。
 * 前端有些地方直接截字符串显示时间，UTC 串会差 8 小时。
 */
export function encodeJSON(v: unknown): string {
  const body = JSON.stringify(jsonable(v));
  return `${body.replace(/[\u2028\u2029]/g, (c) => (c === '\u2028' ? '\\u2028' : '\\u2029'))}\n`;
}

/** 深拷贝并把 Date 转成 RFC3339 本地偏移字符串。 */
function jsonable(v: unknown): unknown {
  if (v instanceof Date) return rfc3339(v);
  if (Array.isArray(v)) return v.map(jsonable);
  if (v !== null && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      out[k] = jsonable(val);
    }
    return out;
  }
  return v;
}

export function writeJSON(res: ServerResponse, status: number, v: unknown): void {
  const body = encodeJSON(v);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

export function writeErr(res: ServerResponse, status: number, msg: string): void {
  writeJSON(res, status, { error: msg });
}

/** Go 的 http.NotFound 输出。 */
export function writeNotFound(res: ServerResponse): void {
  const body = '404 page not found\n';
  res.writeHead(404, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

// ---- 请求体 ----

/** 请求体超限或 JSON 非法时抛这个，调用方统一翻成 400。 */
export class BodyError extends Error {}

/**
 * 带 HTTP 状态码的业务错误。
 *
 * 处理函数只负责 throw，由统一入口翻成 {error: msg} 响应。
 * 好处是错误文案集中在一处，不会出现某个分支忘了写 Content-Type 的情况。
 */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

/**
 * 读取并解析 JSON 请求体。
 *
 * limit 对应 Go 的 http.MaxBytesReader：超限视为格式错误。
 * 空 body 也报错——Go 的 json.Decode 在空 body 上返回 io.EOF。
 *
 * timeoutMs 是为了防慢速攻击：只限大小不限时间的话，攻击者可以
 * 用一个字节一秒的速度把连接挂到天荒地老。服务端整体关了
 * requestTimeout（不然会误杀 SSE），所以这道闸必须在这里补上。
 */
export async function readJSON(
  req: IncomingMessage,
  limit: number,
  timeoutMs = 30_000,
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;

  const timer = setTimeout(() => req.destroy(), timeoutMs);
  try {
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      total += buf.length;
      if (total > limit) throw new BodyError('请求体过大');
      chunks.push(buf);
    }
  } finally {
    clearTimeout(timer);
  }

  const text = Buffer.concat(chunks).toString('utf8');
  if (text.trim() === '') throw new BodyError('空请求体');

  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new BodyError('JSON 解析失败');
  }
}

/**
 * 读取原始请求体（图片上传用）。
 *
 * 不用 multipart：面板只有这一个上传入口，与其手写一个 boundary 解析器
 * （还要防畸形头部、防超长 header 段），不如让前端直接把 File 当 body 发，
 * 文件名走查询串。少一个解析器就少一类越权与 DoS 的入口。
 */
export async function readBinary(
  req: IncomingMessage,
  limit: number,
  timeoutMs = 120_000,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;

  const timer = setTimeout(() => req.destroy(), timeoutMs);
  try {
    for await (const chunk of req) {
      const buf = chunk as Buffer;
      total += buf.length;
      if (total > limit) throw new BodyError('请求体过大');
      chunks.push(buf);
    }
  } finally {
    clearTimeout(timer);
  }

  if (total === 0) throw new BodyError('空请求体');
  return Buffer.concat(chunks);
}

/**
 * 把 patch 上的字段覆盖到 target 上，只认 target 里已存在的键。
 *
 * 等价于 Go 把 JSON 解码到一个已初始化的结构体：
 *   - 未知字段忽略
 *   - null 不生效（Go 对非指针字段解 null 是空操作）
 *   - 类型不匹配报错（Go 会返回 UnmarshalTypeError）
 * 不这么做的话，前端只传部分字段时会把其余字段清空，
 * 校验就会莫名其妙地报"模型地址不能为空"。
 */
export function assignOnto(target: unknown, patch: unknown): void {
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) {
    throw new BodyError('字段类型不匹配');
  }
  const dst = target as Record<string, unknown>;

  for (const [k, v] of Object.entries(patch as Record<string, unknown>)) {
    if (!Object.hasOwn(dst, k)) continue; // 未知字段：忽略
    const cur = dst[k];
    if (v === null) continue; // null：不生效

    if (Array.isArray(cur)) {
      if (!Array.isArray(v)) throw new BodyError(`字段 ${k} 类型不匹配`);
      dst[k] = v;
      continue;
    }
    if (cur !== null && typeof cur === 'object') {
      assignOnto(cur, v);
      continue;
    }
    if (typeof cur !== typeof v) throw new BodyError(`字段 ${k} 类型不匹配`);
    dst[k] = v;
  }
}

// ---- Cookie ----

export function parseCookies(req: IncomingMessage): Record<string, string> {
  const out: Record<string, string> = {};
  const raw = req.headers.cookie;
  if (!raw) return out;
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    if (k === '' || Object.hasOwn(out, k)) continue;
    let v = part.slice(idx + 1).trim();
    if (v.startsWith('"') && v.endsWith('"') && v.length >= 2) v = v.slice(1, -1);
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v;
    }
  }
  return out;
}

export interface CookieOpts {
  path?: string;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
  /** 秒；<0 表示立即过期（Go 的 MaxAge=-1） */
  maxAge?: number;
}

/** 拼 Set-Cookie 值，字段顺序与 Go 的 http.Cookie.String() 一致。 */
export function serializeCookie(name: string, value: string, o: CookieOpts = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  parts.push(`Path=${o.path ?? '/'}`);
  if (o.maxAge !== undefined) parts.push(`Max-Age=${o.maxAge < 0 ? 0 : o.maxAge}`);
  if (o.httpOnly) parts.push('HttpOnly');
  if (o.secure) parts.push('Secure');
  if (o.sameSite) parts.push(`SameSite=${o.sameSite}`);
  return parts.join('; ');
}

export function appendCookie(res: ServerResponse, cookie: string): void {
  const prev = res.getHeader('Set-Cookie');
  if (prev === undefined) {
    res.setHeader('Set-Cookie', cookie);
  } else if (Array.isArray(prev)) {
    res.setHeader('Set-Cookie', [...prev, cookie]);
  } else {
    res.setHeader('Set-Cookie', [String(prev), cookie]);
  }
}

// ---- 客户端 IP ----

/**
 * 直连对端是否属于「自己人」：回环、私网、容器网桥。
 *
 * 只有这种对端才可能是反向代理。公网直连时它的 IP 就是真实客户端，
 * 转发头一律不采信——否则谁都能拿 X-Forwarded-For 换一个身份，
 * 登录限流按 IP 分桶就形同虚设（每次换一个头就是一次新尝试），
 * 审计日志里的来源也会变成攻击者随手写的东西。
 */
function isPrivatePeer(addr: string): boolean {
  if (addr === '') return false;
  if (addr === '::1' || addr === '127.0.0.1') return true;

  const v4 = /^(\d{1,3})\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/.exec(addr);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if (a === 127 || a === 10) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 169 && b === 254) return true; // link-local（含 docker 网关）
    return false;
  }

  // IPv6：唯一本地地址 fc00::/7 与链路本地 fe80::/10
  const lower = addr.toLowerCase();
  return lower.startsWith('fc') || lower.startsWith('fd') || lower.startsWith('fe80');
}

/**
 * 取真实客户端 IP。
 *
 * 容器部署下 req.socket.remoteAddress 是 docker 网桥地址，拿它做登录限流
 * 等于全局限流，所以反代场景要从转发头里取。
 *
 * 但转发头是客户端可写的，默认一律不采信：`deploy/compose.yaml` 是
 * `0.0.0.0:5666` 端口直连，docker-proxy 只做 TCP 转发、不会重写头部，
 * 客户端的 X-Forwarded-For 会原样送到这里。也就是说"对端是私网"这件事
 * 完全不能证明"前面有个可信代理"——它是网桥地址，永远成立。
 * 后果是每个请求换一个头就能拿到新的限流桶，登录爆破不限次。
 *
 * 因此改为显式开启 `QQBOT_TRUST_FORWARDED=1` 才采信（部署在 nginx /
 * Cloudflare 后面时由部署方声明）。开启后取 **最后一跳**：nginx 的
 * `$proxy_add_x_forwarded_for` 是 append 语义，最右边那一项才是紧邻我们的
 * 代理写入的；左边的全由客户端自己填。取第一项正是原来那个漏洞。
 * 每一项都用 net.isIP 校验，非法值直接丢弃——顺手挡住把换行塞进审计日志。
 *
 * 默认关闭的代价是"所有登录共用一个限流桶"（对端恒为网关地址）。
 * 单管理员面板只有一个用户，这个粒度够用，而且是不可绕过的。
 */
export function clientIP(req: IncomingMessage): string {
  const addr = req.socket.remoteAddress ?? '';
  // IPv4 走 ::ffff:1.2.3.4 这种形式时剥掉前缀
  const direct = addr.startsWith('::ffff:') ? addr.slice(7) : addr;
  if (!isPrivatePeer(direct)) return direct;
  if (process.env['QQBOT_TRUST_FORWARDED'] !== '1') return direct;

  const cf = req.headers['cf-connecting-ip'];
  if (typeof cf === 'string' && isIP(cf) !== 0) return cf;

  const xff = req.headers['x-forwarded-for'];
  if (typeof xff === 'string' && xff !== '') {
    const hops = xff
      .split(',')
      .map((h) => h.trim())
      .filter((h) => h !== '');
    // 只看最后一跳。往回找"第一个合法 IP"等于把选择权还给客户端：
    // 攻击者写 "1.1.1.1, 垃圾" 就能拿到 1.1.1.1 这个桶。
    const last = hops[hops.length - 1];
    if (last !== undefined && isIP(last) !== 0) return last;
  }

  return direct;
}

/** 请求是否来自 HTTPS（用于决定 cookie 要不要带 Secure）。 */
export function isSecureRequest(req: IncomingMessage): boolean {
  if ((req.socket as { encrypted?: boolean }).encrypted) return true;
  return req.headers['x-forwarded-proto'] === 'https';
}

// ---- 路由 ----

interface RouteEntry {
  method: string;
  handler: Handler;
}

/**
 * 极简路由器，只支持精确路径 + 一个 GET 子树兜底。
 *
 * 面板只有 23 条固定路由，不需要参数解析和通配符；
 * 需要的是 405 语义，而这一点正是多数轻量框架做不对的地方。
 */
export class Router {
  private readonly table = new Map<string, RouteEntry[]>();
  private fallback: Handler | null = null;

  /** 注册路由。GET 自动接受 HEAD（Go 的行为）。 */
  add(method: string, path: string, handler: Handler): this {
    const list = this.table.get(path) ?? [];
    list.push({ method, handler });
    this.table.set(path, list);
    return this;
  }

  /** 注册 "GET /" 子树兜底。 */
  setFallback(handler: Handler): this {
    this.fallback = handler;
    return this;
  }

  dispatch(ctx: ReqCtx): Handler | null {
    const method = ctx.req.method ?? 'GET';
    const entries = this.table.get(ctx.path);

    if (entries) {
      const exact = entries.find((e) => e.method === method);
      if (exact) return exact.handler;
      if (method === 'HEAD') {
        const viaGet = entries.find((e) => e.method === 'GET');
        if (viaGet) return viaGet.handler;
      }
      // 路径存在但方法不对 → 405 + Allow
      const allow = new Set(entries.map((e) => e.method));
      if (allow.has('GET')) allow.add('HEAD');
      const list = [...allow].sort().join(', ');
      return (c) => {
        c.res.setHeader('Allow', list);
        writeErr(c.res, 405, '方法不被允许');
      };
    }

    if (method === 'GET' || method === 'HEAD') return this.fallback;

    // 未注册的路径 + 非 GET：Go 会给 405（因为 "GET /" 的路径能匹配上）
    return (c) => {
      c.res.setHeader('Allow', 'GET, HEAD');
      writeErr(c.res, 405, '方法不被允许');
    };
  }
}

// ---- 静态资源 ----

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.json': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

function contentTypeByExt(p: string): string {
  const dot = p.lastIndexOf('.');
  if (dot < 0) return '';
  return MIME[p.slice(dot).toLowerCase()] ?? '';
}

function isFile(p: string): boolean {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * 前端静态资源 + SPA 兜底。
 *
 * 未命中的路径一律回 index.html（前端自己按 location.pathname 路由），
 * 这样刷新 /sessions 这类深链接不会 404。
 */
export function makeStaticHandler(webDir: string): Handler {
  const root = resolve(webDir);
  const indexPath = join(root, 'index.html');

  const sendIndex = (ctx: ReqCtx): void => {
    if (!isFile(indexPath)) {
      writeNotFound(ctx.res);
      return;
    }
    ctx.res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-cache',
    });
    if (ctx.req.method === 'HEAD') {
      ctx.res.end();
      return;
    }
    pipeFile(ctx.res, indexPath);
  };

  return (ctx) => {
    let rel: string;
    try {
      rel = decodeURIComponent(ctx.path).replace(/^\/+/, '');
    } catch {
      writeNotFound(ctx.res);
      return;
    }
    if (rel === '') rel = 'index.html';

    const full = resolve(root, normalize(rel));
    // 目录穿越：落在 root 之外一律按未命中处理（回 SPA，和 embed.FS 行为一致）
    if (full !== root && !full.startsWith(root + sep)) {
      sendIndex(ctx);
      return;
    }
    if (!isFile(full)) {
      sendIndex(ctx);
      return;
    }

    const headers: Record<string, string> = {
      // 带内容 hash 的构建产物可以长缓存；其余必须每次校验
      'Cache-Control': full.includes(`${sep}assets${sep}`)
        ? 'public, max-age=31536000, immutable'
        : 'no-cache',
    };
    const ct = contentTypeByExt(full);
    if (ct !== '') headers['Content-Type'] = ct;

    ctx.res.writeHead(200, headers);
    if (ctx.req.method === 'HEAD') {
      ctx.res.end();
      return;
    }
    pipeFile(ctx.res, full);
  };
}
