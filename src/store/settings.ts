// 运行期设置：整份 JSON 存一行，进程内缓存，写时统一加密敏感字段。
import type { Box } from '../secret/box';
import type { Db } from './db';
import {
  cloneSettings,
  defaultSettings,
  normalizeSettings,
  type Settings,
} from './types';
import { nowSec } from '../util/time';

/** 加密字段的存储前缀，用于区分明文与密文，便于平滑升级。 */
const ENC_PREFIX = 'enc:';
/**
 * 明文转义前缀。
 *
 * 只在「没有主密钥」时用得上：那种情况下字段只能存明文，而明文本身完全可能
 * 以 `enc:` 开头（用户粘的 Key 什么样都有可能）。不转义的话，下次读到它会被
 * 当成密文去解，解不开——一个合法的 Key 就这么废了。
 */
const RAW_PREFIX = 'raw:';

/** 只用到 warn/error 的最小日志接口，避免为一行日志把 Logger 拖成构造参数。 */
export interface SettingsLogger {
  warn(msg: string, attrs?: Record<string, unknown>): void;
  error(msg: string, attrs?: Record<string, unknown>): void;
}

export class SettingsRepo {
  private cache: Settings | null = null;
  private box: Box | null = null;
  private log: SettingsLogger | null = null;

  constructor(private readonly db: Db) {}

  setBox(box: Box): void {
    this.box = box;
  }

  /** 接上日志：读配置的降级路径必须留下痕迹，否则「设置莫名其妙被重置」永远查不到。 */
  setLog(log: SettingsLogger): void {
    this.log = log;
  }

  /** 返回设置快照（敏感字段已解密）。 */
  get(): Settings {
    if (this.cache) return cloneSettings(this.cache);
    const loaded = this.load();
    this.cache = loaded;
    return cloneSettings(loaded);
  }

  /** 覆盖保存。 */
  save(v: Settings): Settings {
    return this.saveLocked(v);
  }

  /**
   * 在事务语义下修改：传入的函数改完即持久化，任一环节失败都不留半写状态。
   */
  update(fn: (v: Settings) => void): Settings {
    const cur = this.cache ?? this.load();
    const next = cloneSettings(cur);
    fn(next);
    return this.saveLocked(next);
  }

  /**
   * 读一行 JSON 并归一化。
   *
   * 这个方法**永不抛异常**。它跑在登录之前（认证要读 admin_user / password_hash），
   * 一抛就是面板 500；而修面板又必须先登录，于是整个实例锁死，只能删库重来。
   * 任何读不懂的数据都降级成默认值，并把原始行原样留在库里等人工处理。
   */
  private load(): Settings {
    let text: string;
    try {
      const row = this.db.get<{ json: string }>('SELECT json FROM settings WHERE id = 1');
      if (!row) return defaultSettings();
      text = row.json;
    } catch (e) {
      this.log?.error('读取设置失败（数据库不可用），本次按默认值运行', { err: e });
      return defaultSettings();
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (e) {
      // 磁盘写一半、手工编辑、旧版本写废都会走到这里。原数据不动，
      // 用户下次在面板上保存才会覆盖它——在那之前至少还能登录进去修。
      this.log?.error('设置 JSON 已损坏，本次按默认值运行（原数据仍保留在库里）', {
        err: e,
        bytes: text.length,
      });
      return defaultSettings();
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      this.log?.error('设置不是对象，本次按默认值运行', { kind: Array.isArray(parsed) ? 'array' : typeof parsed });
      return defaultSettings();
    }

    // 先归一化再解密：归一化保证 llm / panel 这些块一定存在且字段类型正确，
    // 解密才敢直接点 v.llm.api_key。顺序反过来的话，缺一个块就又是一次崩溃。
    let v: Settings;
    try {
      v = normalizeSettings(parsed as Settings);
    } catch (e) {
      this.log?.error('设置结构无法修复，本次按默认值运行', { err: e });
      return defaultSettings();
    }
    this.decryptSensitive(v);
    return v;
  }

  private saveLocked(v: Settings): Settings {
    // 所有写路径都经过这里，归一化放一处就不会漏
    normalizeSettings(v);
    const enc = this.encryptSensitive(cloneSettings(v));
    this.db.run(
      `INSERT INTO settings (id, json, updated_at) VALUES (1, ?, ?)
         ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`,
      JSON.stringify(enc),
      nowSec(),
    );
    this.cache = v;
    return cloneSettings(v);
  }

  private encryptSensitive(v: Settings): Settings {
    v.llm.api_key = this.encodeSecret(v.llm.api_key);
    v.panel.totp_secret = this.encodeSecret(v.panel.totp_secret);
    return v;
  }

  private encodeSecret(plain: string): string {
    if (plain === '') return '';
    if (!this.box) {
      return plain.startsWith(ENC_PREFIX) || plain.startsWith(RAW_PREFIX)
        ? RAW_PREFIX + plain
        : plain;
    }
    // 这里刻意**不**判「是不是已经以 enc: 开头」。
    //
    // 那个判断的本意是防重复加密，实际效果是：以 enc: 开头的明文 Key 永远不加密，
    // 而读的时候按前缀一律去解密——存进去的那一刻就注定了下次启动解不开，
    // 而且整个面板会跟着 500。写入路径拿到的一律是明文（缓存与 get() 都解密过），
    // 无条件加密才是唯一自洽的做法。
    return ENC_PREFIX + this.box.encrypt(plain);
  }

  private decryptSensitive(v: Settings): void {
    v.llm.api_key = this.decodeSecret('LLM API Key', v.llm.api_key);
    v.panel.totp_secret = this.decodeSecret('TOTP 密钥', v.panel.totp_secret);
  }

  private decodeSecret(label: string, raw: string): string {
    if (raw.startsWith(RAW_PREFIX)) return raw.slice(RAW_PREFIX.length);
    if (!raw.startsWith(ENC_PREFIX)) return raw;

    const body = raw.slice(ENC_PREFIX.length);
    if (!this.box) {
      // 有密文却没有主密钥：说明数据目录换了、密钥文件丢了。
      // 原样返回会让上层拿密文当明文用（拿去请求模型、拿去验 TOTP），
      // 表现成「Key 明明填过却一直 401」。当空值处理，至少错误是诚实的。
      this.log?.error(`${label} 是密文，但当前没有主密钥，已按空值处理`, {});
      return '';
    }
    try {
      return this.box.decrypt(body);
    } catch (e) {
      // 主密钥换了或密文被截断。抛出去会锁死面板（见 load 的说明），
      // 这里降级成空值：用户还能登进去重新填一次。
      this.log?.error(`${label} 解密失败，已按空值处理（请在面板重新填写）`, { err: e });
      return '';
    }
  }
}
