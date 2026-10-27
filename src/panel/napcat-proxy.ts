// NapCat WebUI 反向代理：把协议端自己的界面挂到面板的 /webui 下。
//
// 为什么需要它：
//   面板已经能扫码、能改 OneBot 的 WS 端口，但协议端还有一堆面（WebUIConfig、
//   日志流、进程重启、插件……）不值得在面板里重画一遍。直接把 WebUI 透传过来，
//   「功能不变」这条就补齐了，而且协议端升级后这边不用跟着改。
//
// 三个必须遵守的约束（都是实测出来的，别凭直觉改）：
//   1. WebUI 的前端资源是**绝对路径**（/webui/assets/...），接口也是绝对路径
//      （axios baseURL = /api）。所以必须同时代理 /webui 与未被面板占用的 /api，
//      而且不能改写路径——改写就会在协议端升级后碎掉。
//   2. WebUI 的凭据（Credential）只由服务端持有。浏览器里 localStorage.token
//      放的是一个占位串，真正的 Authorization 头在这里注入，token 永不下发。
//   3. 面板的 CSP 是 script-src 'self'。WebUI 是 Vite 产物，必须放开 inline/eval
//      才能跑，所以这一路单独换一份 CSP——它只影响 /webui 自己的页面。
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { OutgoingHttpHeaders } from 'node:http';
import { writeErr, type Handler } from './http';

/** 逐跳头：这些不能透传，否则上游会以为是自己的连接语义。 */
const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'host',
]);

/**
 * WebUI 专用的 CSP。
 *
 * 比面板宽松：Vite 产物里有内联样式，React 某些路径会 eval。
 * 仍然限制 connect-src 与 frame-ancestors，避免它被外站嵌走。
 * 头像走腾讯的 CDN，所以 img-src 要放 https:。
 */
const WEBUI_CSP =
  "default-src 'self'; " +
  "img-src 'self' data: blob: https:; " +
  "style-src 'self' 'unsafe-inline'; " +
  "script-src 'self' 'unsafe-inline' 'unsafe-eval'; " +
  "font-src 'self' data:; " +
  "connect-src 'self'; " +
  "frame-ancestors 'self'";

export interface ProxyTarget {
  /** 协议端 WebUI 根地址，如 http://napcat:6099 */
  base: string;
  /** 取一个可用的 Credential（服务端内部调用，不经过浏览器） */
  bearer: () => Promise<string>;
}

/**
 * 生成 /webui 与 /api 的透传处理器。
 *
 * 请求体与响应体都走流式管道：日志页是 SSE 长连接，
 * 缓冲式实现会让它一直转圈。
 */
export function makeWebUIProxy(target: ProxyTarget): Handler {
  const base = new URL(target.base);
  const isTLS = base.protocol === 'https:';
  const doRequest = isTLS ? httpsRequest : httpRequest;
  const port = base.port === '' ? (isTLS ? 443 : 80) : Number(base.port);
  const prefix = base.pathname.replace(/\/+$/, ''); // 一般就是空

  return async (ctx) => {
    const { req, res } = ctx;

    const headers: OutgoingHttpHeaders = {};
    for (const [k, v] of Object.entries(req.headers)) {
      if (v === undefined) continue;
      if (HOP_BY_HOP.has(k.toLowerCase())) continue;
      headers[k] = v;
    }
    headers.host = base.host;

    // 只有接口需要身份；静态资源不带也行，但统一带上更省事，
    // 也避免某些版本的 /webui 首页自己校验 Authorization。
    try {
      const bearer = await target.bearer();
      if (bearer !== '') headers.authorization = `Bearer ${bearer}`;
    } catch {
      // 拿不到凭据就让上游自己拒绝（401），由前端提示，不在代理层伪造响应
    }

    // 用原始 url 而不是 ctx.path：查询串要原样带给上游（?token=... 之类）
    const upstreamPath = `${prefix}${req.url ?? '/'}`;

    await new Promise<void>((resolve) => {
      const up = doRequest(
        { host: base.hostname, port, method: req.method, path: upstreamPath, headers },
        (upRes) => {
          const out: OutgoingHttpHeaders = {};
          for (const [k, v] of Object.entries(upRes.headers)) {
            if (v === undefined) continue;
            // 上游的 content-length 会因为我们不重编码而仍然正确，保留即可；
            // 但 CSP / frame 头要以我们的为准
            if (k === 'content-security-policy' || k === 'x-frame-options') continue;
            out[k] = v;
          }
          res.writeHead(upRes.statusCode ?? 502, out);
          upRes.pipe(res);
          upRes.on('end', resolve);
          upRes.on('error', () => {
            res.end();
            resolve();
          });
        },
      );

      up.on('error', (e: Error) => {
        if (res.headersSent) {
          res.end();
        } else {
          writeErr(res, 502, `协议端不可达：${e.message}`);
        }
        resolve();
      });

      // 浏览器提前断开（切页、关 iframe）时把上游连接也收掉，
      // 否则 SSE 长连接会挂着不放，1 核机器上很快就堆起来
      res.on('close', () => up.destroy());

      req.pipe(up);
    });
  };
}

/** 给 /webui 一路换上宽松一点的 CSP（面板本身仍是严格的）。 */
export function applyWebUICSP(h: Handler): Handler {
  return (ctx) => {
    ctx.res.setHeader('Content-Security-Policy', WEBUI_CSP);
    ctx.res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    return h(ctx);
  };
}
