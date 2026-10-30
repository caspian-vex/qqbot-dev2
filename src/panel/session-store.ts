// 面板会话与登录限流（纯内存）。
//
// 为什么不落库：面板会话是"这台机器上的登录态"，重启即失效反而是好事；
// 落库会多一份可被离线爆破的凭据面。
import { tokenDigest } from './auth';

/** 会话有效期 12 小时。 */
export const SESSION_TTL_MS = 12 * 60 * 60 * 1000;

/** 滑动窗口：每 IP 每分钟最多 5 次登录尝试。 */
const LOGIN_WINDOW_MS = 60_000;
const LOGIN_MAX_PER_WINDOW = 5;

/** 连续失败 10 次锁 15 分钟。 */
const LOGIN_MAX_FAILURES = 10;
const LOGIN_LOCK_MS = 15 * 60 * 1000;

export interface SessionInfo {
  user: string;
  expires: Date;
}

interface Attempt {
  windowStart: number;
  count: number;
  failures: number;
  lockedUntil: number;
}

export interface LoginVerdict {
  ok: boolean;
  /** ok 为 false 时，还需等待多久（毫秒） */
  waitMs: number;
}

export class SessionStore {
  private readonly sessions = new Map<string, SessionInfo>();
  private readonly attempts = new Map<string, Attempt>();

  /** 建立会话，返回下发给浏览器的原始令牌。 */
  issue(token: string, user: string): void {
    this.sessions.set(tokenDigest(token), {
      user,
      expires: new Date(Date.now() + SESSION_TTL_MS),
    });
  }

  /** 按原始令牌查会话；过期的顺手清掉。 */
  get(token: string): SessionInfo | null {
    const key = tokenDigest(token);
    const s = this.sessions.get(key);
    if (!s) return null;
    if (Date.now() > s.expires.getTime()) {
      this.sessions.delete(key);
      return null;
    }
    return s;
  }

  /** 主动注销。 */
  drop(token: string): void {
    this.sessions.delete(tokenDigest(token));
  }

  /**
   * 吊销除指定令牌以外的全部会话，返回吊销条数。
   *
   * 改密码、关两步验证之后必须调它：这两种动作的语义就是「把别人赶出去」，
   * 而会话是 12 小时的，不主动清掉的话，一个已经拿到 Cookie 的攻击者
   * 在主人改完密码后还能继续用满 12 小时——改密码就成了纯自我安慰。
   * 保留当前会话，否则用户刚改完就被自己的操作踢下线。
   */
  revokeAllExcept(token: string | undefined): number {
    const keep = token === undefined || token === '' ? '' : tokenDigest(token);
    let n = 0;
    for (const k of [...this.sessions.keys()]) {
      if (k === keep) continue;
      this.sessions.delete(k);
      n++;
    }
    return n;
  }

  /**
   * 改名时同步已有会话。
   *
   * 会话里的 user 是登录那一刻的快照：不同步的话，改完用户名后
   * `/api/auth/status` 还会回旧名字，侧栏也一直显示旧的，
   * 看着像没改成功。只换名字、不动令牌与过期时间——
   * 改名不该把其他设备踢下线（同一账号只有一个用户）。
   */
  renameUser(from: string, to: string): void {
    for (const s of this.sessions.values()) {
      if (s.user === from) s.user = to;
    }
  }

  /** 当前会话数（诊断用）。 */
  get size(): number {
    return this.sessions.size;
  }

  /**
   * 登录前置检查。通过则计数 +1。
   *
   * 注意计数发生在校验之前：这样即使请求体是坏的也算一次尝试，
   * 否则攻击者可以用畸形请求绕过限流。
   */
  allowLogin(ip: string): LoginVerdict {
    const now = Date.now();
    let a = this.attempts.get(ip);
    if (!a) {
      a = { windowStart: now, count: 0, failures: 0, lockedUntil: 0 };
      this.attempts.set(ip, a);
    }
    if (now < a.lockedUntil) return { ok: false, waitMs: a.lockedUntil - now };
    if (now - a.windowStart > LOGIN_WINDOW_MS) {
      a.windowStart = now;
      a.count = 0;
    }
    if (a.count >= LOGIN_MAX_PER_WINDOW) {
      return { ok: false, waitMs: LOGIN_WINDOW_MS - (now - a.windowStart) };
    }
    a.count++;
    return { ok: true, waitMs: 0 };
  }

  recordFailure(ip: string): void {
    const now = Date.now();
    let a = this.attempts.get(ip);
    if (!a) {
      a = { windowStart: now, count: 0, failures: 0, lockedUntil: 0 };
      this.attempts.set(ip, a);
    }
    a.failures++;
    if (a.failures >= LOGIN_MAX_FAILURES) {
      a.lockedUntil = now + LOGIN_LOCK_MS;
      a.failures = 0;
    }
  }

  resetFailures(ip: string): void {
    this.attempts.delete(ip);
  }

  /**
   * 清理过期会话与陈旧限流记录。
   *
   * Go 版只在访问时惰性删除，会话表会随着登录次数无上限增长。
   * 这里补一个周期性清扫——外部行为完全一致，只是不再泄漏。
   */
  sweep(): void {
    const now = Date.now();
    for (const [k, s] of this.sessions) {
      if (now > s.expires.getTime()) this.sessions.delete(k);
    }
    for (const [ip, a] of this.attempts) {
      const idle = now - a.windowStart;
      if (now >= a.lockedUntil && idle > 60 * 60 * 1000) this.attempts.delete(ip);
    }
  }
}
