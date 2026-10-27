// 面板认证：argon2id 口令哈希 + TOTP + 随机令牌。
//
// 与 Go 版的差异只有一处实现方式：argon2id 放到 worker_threads 里算。
// 原因很实际——目标机器只有 1 核，argon2id 一次要烧 ~100ms CPU。
// 在 Go 里它是独立 goroutine，还能被调度器挤出去；
// 在 Node 里主线程算哈希就是纯阻塞，那 100ms 内 WebSocket 心跳、
// 机器人回复、SSE 推送全部停摆。丢给 worker 就回到与 Go 等价的处境。
//
// 产物里 worker 是单独一个文件（dist/argon-worker.js）。文件缺失时
// 自动退化为主线程计算：登录会短暂卡一下，但功能不会坏。
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

/** argon2id 参数。1 核机器上刻意取保守值：64MB 内存、3 轮，约 100ms。 */
export const ARGON = {
  /** 单位 KiB，65536 KiB = 64 MiB（与 Go 的 argonMemory 一致） */
  memory: 64 * 1024,
  time: 3,
  threads: 2,
  keyLen: 32,
  saltLen: 16,
} as const;

export interface ArgonParams {
  memory: number;
  time: number;
  threads: number;
  keyLen: number;
  saltLen: number;
}

// ---- base64 ----
//
// Go 用的是 base64.RawStdEncoding（标准字母表、无 padding），
// 不是 URL 安全变体。两者在第 62/63 个字符上不同，混用会导致
// 老密码全部校验失败，所以这里必须显式区分。

/** 标准 base64，无 padding（等价 Go 的 base64.RawStdEncoding）。 */
export function b64raw(buf: Uint8Array): string {
  return Buffer.from(buf).toString('base64').replace(/=+$/, '');
}

function b64rawDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s + pad, 'base64');
}

/** URL 安全 base64，无 padding（等价 Go 的 base64.RawURLEncoding）。 */
export function b64url(buf: Uint8Array): string {
  return Buffer.from(buf).toString('base64url');
}

// ---- argon2id ----

/** 编码成 PHC 串：argon2id$v=19$m=65536,t=3,p=2$<salt>$<hash> */
function encodePHC(salt: Uint8Array, key: Uint8Array, p: ArgonParams = ARGON): string {
  return `argon2id$v=19$m=${p.memory},t=${p.time},p=${p.threads}$${b64raw(salt)}$${b64raw(key)}`;
}

interface ParsedPHC {
  params: ArgonParams;
  salt: Buffer;
  want: Buffer;
}

function parsePHC(encoded: string): ParsedPHC | null {
  const parts = encoded.split('$');
  if (parts.length !== 5 || parts[0] !== 'argon2id') return null;

  const v = /^v=(\d+)$/.exec(parts[1] ?? '');
  if (!v) return null;
  if (Number(v[1]) !== 19) return null; // 只认当前版本的 argon2

  const m = /^m=(\d+),t=(\d+),p=(\d+)$/.exec(parts[2] ?? '');
  if (!m) return null;

  let salt: Buffer;
  let want: Buffer;
  try {
    salt = b64rawDecode(parts[3] ?? '');
    want = b64rawDecode(parts[4] ?? '');
  } catch {
    return null;
  }
  if (salt.length === 0 || want.length === 0) return null;

  return {
    params: {
      memory: Number(m[1]),
      time: Number(m[2]),
      threads: Number(m[3]),
      keyLen: want.length,
      saltLen: salt.length,
    },
    salt,
    want,
  };
}

// ---- worker 池 ----
//
// 只开一个 worker：登录是低频操作，队列深度实际永远是 0 或 1。
// 多开 worker 只会和机器人抢那唯一的一核。

interface WorkerReply {
  id: number;
  ok: boolean;
  key?: Uint8Array;
  error?: string;
}

let worker: Worker | null = null;
let workerBroken = false;
let seq = 0;
const pending = new Map<number, { resolve: (k: Buffer) => void; reject: (e: Error) => void }>();

function rejectAllPending(err: Error): void {
  for (const p of pending.values()) p.reject(err);
  pending.clear();
}

/** 队列空了就把 worker 放回 unref 状态，不拖住进程退出。 */
function settle(id: number): { resolve: (k: Buffer) => void; reject: (e: Error) => void } | undefined {
  const p = pending.get(id);
  pending.delete(id);
  if (pending.size === 0 && worker) worker.unref();
  return p;
}

function ensureWorker(): Worker | null {
  if (worker) return worker;
  if (workerBroken) return null;

  const file = join(__dirname, 'argon-worker.js');
  if (!existsSync(file)) {
    // 开发态（tsx 直跑源码）没有产物文件，直接退化，不算故障
    return null;
  }

  try {
    const w = new Worker(file);
    // 不 unref：worker 常驻可以省掉每次登录 ~15ms 的启动开销；
    // 进程退出由 http server 的 close 流程控制，不会因为 worker 卡住。
    w.on('message', (msg: WorkerReply) => {
      const p = settle(msg.id);
      if (!p) return;
      if (msg.ok && msg.key) p.resolve(Buffer.from(msg.key));
      else p.reject(new Error(msg.error ?? 'argon2 计算失败'));
    });
    w.on('error', (e) => {
      // 只标记坏掉、不立刻重建：避免一个持续崩溃的 worker 变成重启风暴
      workerBroken = true;
      worker = null;
      rejectAllPending(e);
    });
    w.on('exit', () => {
      if (worker === w) worker = null;
      rejectAllPending(new Error('argon worker 已退出'));
    });
    w.unref();
    worker = w;
    return w;
  } catch {
    workerBroken = true;
    return null;
  }
}

/** 在主线程直接算（worker 不可用时的兜底）。 */
async function deriveInThread(
  password: string,
  salt: Uint8Array,
  p: ArgonParams,
): Promise<Buffer> {
  // 动态 import：只在真正需要时才把 hash-wasm 的 WASM 拉进内存
  const { argon2id } = await import('hash-wasm');
  const out = await argon2id({
    password,
    salt,
    parallelism: p.threads,
    iterations: p.time,
    memorySize: p.memory,
    hashLength: p.keyLen,
    outputType: 'binary',
  });
  return Buffer.from(out);
}

function derive(password: string, salt: Uint8Array, p: ArgonParams): Promise<Buffer> {
  const w = ensureWorker();
  if (!w) return deriveInThread(password, salt, p);

  const id = ++seq;
  return new Promise<Buffer>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    // 有在途请求时 ref，算完再 unref：否则一个 unref 的 worker 加上
    // 一个 pending Promise 都不持有事件循环，进程可能在回包前就退出了
    w.ref();
    try {
      w.postMessage({
        id,
        password,
        salt,
        memory: p.memory,
        time: p.time,
        threads: p.threads,
        keyLen: p.keyLen,
      });
    } catch (e) {
      pending.delete(id);
      // postMessage 失败（worker 正在退出）→ 当场退化为主线程算，别让用户看到 500
      deriveInThread(password, salt, p).then(resolve, reject);
    }
  });
}

/** 生成 argon2id 哈希。 */
export async function hashPassword(password: string, p: ArgonParams = ARGON): Promise<string> {
  const salt = randomBytes(p.saltLen);
  const key = await derive(password, salt, p);
  return encodePHC(salt, key, { ...p, keyLen: p.keyLen, saltLen: p.saltLen });
}

/** 校验口令。任何格式问题一律返回 false，不抛异常。 */
export async function verifyPassword(password: string, encoded: string): Promise<boolean> {
  const parsed = parsePHC(encoded);
  if (!parsed) return false;
  try {
    const got = await derive(password, parsed.salt, parsed.params);
    if (got.length !== parsed.want.length) return false;
    return timingSafeEqual(got, parsed.want);
  } catch {
    return false;
  }
}

// ---- base32（RFC 4648，无 padding）----
//
// Node 没有内置 base32，而 TOTP 密钥必须是 base32。
// 自己实现比引依赖划算：编码 10 行、解码 12 行。

const B32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of buf) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += B32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[\s=]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = B32_ALPHABET.indexOf(ch);
    if (idx < 0) throw new Error(`TOTP 密钥不合法: 非 base32 字符 ${ch}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// ---- TOTP (RFC 6238) ----

/** 生成新的 base32 密钥（160 bit，RFC 4226 推荐长度，不带 padding）。 */
export function newTOTPSecret(): string {
  return base32Encode(randomBytes(20));
}

/** 计算指定时刻的 6 位验证码。 */
export function totpCode(secret: string, at: Date = new Date()): string {
  const key = base32Decode(secret);
  const counter = BigInt(Math.floor(at.getTime() / 1000 / 30));

  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(counter);

  const sum = createHmac('sha1', key).update(buf).digest();
  const offset = sum[sum.length - 1]! & 0x0f;
  const code =
    (((sum[offset]! & 0x7f) << 24) |
      (sum[offset + 1]! << 16) |
      (sum[offset + 2]! << 8) |
      sum[offset + 3]!) >>>
    0;

  return String(code % 1_000_000).padStart(6, '0');
}

/** 校验验证码，允许前后各一个时间窗（±30 秒）以容忍时钟漂移。 */
export function verifyTOTP(secret: string, code: string): boolean {
  const c = code.trim();
  if (c.length !== 6) return false;
  const now = Date.now();
  for (const delta of [0, -30_000, 30_000]) {
    let want: string;
    try {
      want = totpCode(secret, new Date(now + delta));
    } catch {
      return false; // 密钥本身坏了，没必要再试另外两个窗口
    }
    if (want.length === c.length && timingSafeEqual(Buffer.from(want), Buffer.from(c))) {
      return true;
    }
  }
  return false;
}

/** 生成 otpauth:// 链接，供二维码使用。 */
export function totpProvisioningURL(issuer: string, account: string, secret: string): string {
  return (
    `otpauth://totp/${urlEscape(issuer)}:${urlEscape(account)}` +
    `?secret=${secret}&issuer=${urlEscape(issuer)}&algorithm=SHA1&digits=6&period=30`
  );
}

/** 极简转义：issuer/account 只会有字母数字和少量符号。 */
function urlEscape(s: string): string {
  return s.replace(/ /g, '%20').replace(/:/g, '%3A').replace(/\//g, '%2F').replace(/@/g, '%40');
}

// ---- 令牌 ----

/** n 字节的 URL 安全随机串（无 padding）。 */
export function randomToken(n: number): string {
  return b64url(randomBytes(n));
}

/**
 * 会话令牌的存储摘要。
 *
 * 名字沿用 Go 版（叫 Hex 但其实不是十六进制）——改名会让日后
 * 对照两份实现时多一次困惑，不如留个说明。
 * 用摘要而不是原文存内存：万一内存被 dump，拿到的令牌也不能直接复用。
 */
export function tokenDigest(s: string): string {
  return b64url(createHash('sha256').update(s).digest());
}

/** 定长常量时间比较，避免通过响应耗时逐字节爆破。 */
export function subtleEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/** 仅供测试：重置 worker 状态。 */
export function _resetArgonWorkerForTest(): void {
  if (worker) {
    worker.removeAllListeners();
    void worker.terminate();
  }
  worker = null;
  workerBroken = false;
  pending.clear();
}
