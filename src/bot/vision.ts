// 图片识别：把用户发来的图交给模型看。
//
// 链路：OneBot image 段 → 取 url/file → 下载（有上限）→ 嗅探真实类型 →
// data URL → OpenAI 兼容的 image_url 内容块。
//
// 三条硬约束，每条都对应一个真实会踩的坑：
//
// 1. 开关关着就一字节都不下载。一张图几 MB，白下一张就是几秒与几十 MB 流量，
//    而流量在 1 核 2G 的机器上是真金白银。
// 2. 只信文件头。协议端给的 Content-Type 经常是 application/octet-stream，
//    照抄会让模型收到一个解不开的 data URL（报错还看不出原因）。
// 3. 历史里只存一句「（附图 N 张）」。base64 进 SQLite 会让库几天涨到 GB，
//    而下一轮真正需要的只是"这一轮里有过一张图"。

import { IMAGE_MIME, MAX_IMAGE_BYTES, sniffImageExt } from './imagepool';
import type { ImagePart } from '../llm/client';
import type { Event } from '../onebot/types';
import { segments } from '../onebot/types';

/** 单条消息最多看几张图。超过的部分直接丢，不下载。 */
export const VISION_MAX_IMAGES = 4;

/** 单张图的最大字节数，与图池保持一致：再大 base64 之后就奔着 7MB 去了。 */
export const VISION_MAX_BYTES = MAX_IMAGE_BYTES;

/**
 * 一条消息里所有图片的字节上限。
 *
 * 单张 5MB 拦不住四张各 4MB 的情况：base64 之后请求体接近 22MB，
 * 大多数网关会直接 413，而错误信息通常只说"请求过大"，看不出是图。
 * 这里是发送侧的闸，不是下载侧的——多下的那几张只是白花流量，绝不进请求。
 */
export const VISION_MAX_TOTAL_BYTES = 8 * 1024 * 1024;

/** 单张图的下载超时。超过就当这张图不存在，按纯文字继续。 */
export const VISION_TIMEOUT_MS = 8_000;

/**
 * 只发了图、没打字时给模型的一句说明。
 *
 * 为什么要一句话而不是纯图片：多数模型会把"只有一张图"当成待续写的素材，
 * 输出一句没头没尾的描述。点明"用户只发了图片"，它才会当成对话来回应。
 * 这句只进请求，不进历史——历史里是「（附图 1 张）」。
 */
export const VISION_ONLY_PROMPT = '（用户只发了图片，没有附带文字）';

/** 带图时追加到系统提示的一句约束。 */
export const VISION_HINT =
  '- 用户可能直接发来图片（截图、照片、表情包），结合图片内容回应；' +
  '看不清或图里没有相关信息就直说，不要编造图中不存在的细节。';

/** 一条图片消息的来源。url 与 file 至少有一个非空。 */
export interface ImageRef {
  url: string;
  file: string;
}

/** 下载参数。fetchImpl 是为测试注入的，线上就是全局 fetch。 */
export interface LoadOptions {
  maxImages?: number;
  maxBytes?: number;
  maxTotalBytes?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}

/**
 * 从事件里取出图片段的来源。
 *
 * 只挑 image 段：表情包（face）、商城表情（mface）与闪照（flash）都不处理，
 * 它们要么没有稳定可下载的地址，要么一闪而过、拿不到原图。
 */
export function imageRefs(ev: Event): ImageRef[] {
  const out: ImageRef[] = [];
  for (const s of segments(ev)) {
    if (s.type !== 'image') continue;
    const url = str(s.data['url']);
    const file = str(s.data['file']);
    if (url === '' && file === '') continue; // 没有地址的段只可能是坏数据
    out.push({ url, file });
  }
  return out;
}

/**
 * 选一个真正能读的来源。
 *
 * 优先 http(s) 的 url：那是协议端自己下载好的缓存图，最可靠。
 * base64:// 是 OneBot v11 的另一种合法形态（少数协议端直接内联）。
 * 本地路径一律不读——qqbot 与协议端是两个容器，那个路径在这边不存在；
 * 而在同一台机器上跑的场景，协议端本来就给了 url。
 */
export function pickSource(ref: ImageRef): string | null {
  if (isHttp(ref.url)) return ref.url;
  if (isHttp(ref.file) || ref.file.startsWith('base64://')) return ref.file;
  return null;
}

/**
 * 下载并校验一张图，返回可直接放进消息的 image_url 块。
 *
 * 失败一律返回 null 而不抛错：一张图读不到，最坏的结果应该是"这次按纯文字回"，
 * 不该让整条消息进兜底话术。调用方据此决定要不要给模型补那句说明。
 */
export async function loadImage(ref: ImageRef, opt: LoadOptions = {}): Promise<ImagePart | null> {
  const src = pickSource(ref);
  if (src === null) return null;

  const maxBytes = opt.maxBytes !== undefined && opt.maxBytes > 0 ? opt.maxBytes : VISION_MAX_BYTES;
  const timeoutMs = opt.timeoutMs !== undefined && opt.timeoutMs > 0 ? opt.timeoutMs : VISION_TIMEOUT_MS;

  let buf: Buffer;
  if (src.startsWith('base64://')) {
    buf = decodeBase64(src.slice('base64://'.length));
    if (buf.length === 0) return null;
  } else {
    const fetcher = opt.fetchImpl ?? fetch;
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = opt.signal ? AbortSignal.any([opt.signal, timeout]) : timeout;

    let resp: Response;
    try {
      resp = await fetcher(src, { signal: combined });
    } catch {
      return null; // 网络错误、超时、被取消：都当这张图不存在
    }
    if (!resp.ok) return null;

    // 先看 Content-Length：超过上限就不必把几十 MB 读进内存了。
    // 没有这个头也不要紧，下面读完还会再拦一次（有些 CDN 不给长度）。
    const declared = Number(resp.headers.get('content-length') ?? '');
    if (Number.isFinite(declared) && declared > maxBytes) {
      void resp.body?.cancel().catch(() => undefined);
      return null;
    }

    try {
      buf = Buffer.from(await resp.arrayBuffer());
    } catch {
      return null;
    }
  }

  if (buf.length === 0 || buf.length > maxBytes) return null;

  const ext = sniffImageExt(buf);
  if (ext === null) return null; // 不是图片（改名的 html、视频首帧之外的垃圾）
  const mime = IMAGE_MIME[ext] ?? 'image/jpeg';
  return { type: 'image_url', image_url: { url: `data:${mime};base64,${buf.toString('base64')}` } };
}

/**
 * 一次取完一条消息里的图，按上限截断并去重。
 *
 * 并发下载而不是串行：四张图串行最坏要等四倍的超时，
 * 那时用户早就以为机器人死了。单条消息内去重是因为有人会连发同一张图两次。
 *
 * 总量超限时是"按顺序能塞几张塞几张"，不是整条放弃：
 * 少看一张图也比"这张消息不带图"好。
 */
export async function loadImages(refs: ImageRef[], opt: LoadOptions = {}): Promise<ImagePart[]> {
  const max = clampInt(opt.maxImages, 1, VISION_MAX_IMAGES);
  const picked = dedupeRefs(refs).slice(0, max);
  if (picked.length === 0) return [];

  const totalMax =
    opt.maxTotalBytes !== undefined && opt.maxTotalBytes > 0
      ? opt.maxTotalBytes
      : VISION_MAX_TOTAL_BYTES;

  const got = await Promise.all(picked.map((r) => loadImage(r, opt).catch(() => null)));

  const out: ImagePart[] = [];
  let total = 0;
  for (const p of got) {
    if (p === null) continue;
    const bytes = dataUrlBytes(p.image_url.url);
    if (total + bytes > totalMax) continue;
    total += bytes;
    out.push(p);
  }
  return out;
}

/** 历史与日志里怎么记这条消息带了图。 */
export function imageMarker(n: number): string {
  return `（附图 ${n} 张）`;
}

function dedupeRefs(refs: ImageRef[]): ImageRef[] {
  const seen = new Set<string>();
  const out: ImageRef[] = [];
  for (const r of refs) {
    const k = `${r.url}\u0000${r.file}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(r);
  }
  return out;
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function isHttp(s: string): boolean {
  return /^https?:\/\//i.test(s);
}

/** base64:// 里可能带换行；解码失败返回空 Buffer 交给上层丢弃。 */
function decodeBase64(s: string): Buffer {
  const clean = s.replace(/\s+/g, '');
  if (clean === '') return Buffer.alloc(0);
  try {
    return Buffer.from(clean, 'base64');
  } catch {
    return Buffer.alloc(0);
  }
}

/**
 * data URL 实际占多少字节（不算前缀）。
 *
 * 按 base64 长度反推，而不是再解一遍码：这里只需要"够不够预算"的粗判，
 * 十几 MB 的字符串解一次就是几十毫秒的纯浪费。
 */
function dataUrlBytes(url: string): number {
  const comma = url.indexOf(',');
  if (comma < 0) return 0;
  return Math.floor(((url.length - comma - 1) * 3) / 4);
}

function clampInt(v: number | undefined, min: number, max: number): number {
  if (v === undefined || !Number.isFinite(v)) return max;
  return Math.min(max, Math.max(min, Math.floor(v)));
}
