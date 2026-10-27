// AES-256-GCM 加解密与随机凭据生成。
//
// 与 Go 版 internal/secret 逐字节兼容：
//   密文 = base64(nonce(12) || ciphertext || tag(16))
//   主密钥 = 64 位十六进制（32 字节），来自 etc/env 的 QQBOT_SECRET_KEY
//
// 密钥与数据库分开存放，只拿到 .db 文件无法解密 API Key。
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/** 主密钥长度（AES-256）。 */
export const KEY_SIZE = 32;

const NONCE_SIZE = 12;
const TAG_SIZE = 16;

export class Box {
  private readonly key: Buffer;

  private constructor(key: Buffer) {
    this.key = key;
  }

  /** 用十六进制主密钥构造。 */
  static fromHex(keyHex: string): Box {
    const trimmed = keyHex.trim();
    if (trimmed === '') throw new Error('主密钥为空');
    if (!/^[0-9a-fA-F]+$/.test(trimmed)) throw new Error('主密钥不是合法十六进制');
    const key = Buffer.from(trimmed, 'hex');
    if (key.length !== KEY_SIZE) {
      throw new Error(`主密钥长度应为 ${KEY_SIZE} 字节，实际 ${key.length} 字节`);
    }
    return new Box(key);
  }

  /** 加密，返回 base64(nonce||ciphertext||tag)。空串直接返回空串。 */
  encrypt(plain: string): string {
    if (plain === '') return '';
    const nonce = randomBytes(NONCE_SIZE);
    const cipher = createCipheriv('aes-256-gcm', this.key, nonce);
    const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return Buffer.concat([nonce, ct, tag]).toString('base64');
  }

  /** 解密 encrypt 的输出。 */
  decrypt(encoded: string): string {
    if (encoded === '') return '';
    const raw = Buffer.from(encoded, 'base64');
    if (raw.length < NONCE_SIZE + TAG_SIZE) throw new Error('密文长度不足');
    const nonce = raw.subarray(0, NONCE_SIZE);
    const tag = raw.subarray(raw.length - TAG_SIZE);
    const ct = raw.subarray(NONCE_SIZE, raw.length - TAG_SIZE);
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, nonce);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
    } catch {
      throw new Error('解密失败（主密钥可能已更换）');
    }
  }
}

/** 生成十六进制主密钥（32 字节 → 64 字符）。 */
export function generateKey(): string {
  return randomBytes(KEY_SIZE).toString('hex');
}

/** 生成 n 字节的十六进制随机串，用于面板密码、WebUI 令牌等。 */
export function generateToken(n: number): string {
  return randomBytes(n).toString('hex');
}

/** 常数时间比较，避免时序侧信道。 */
export function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}
