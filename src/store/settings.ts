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

export class SettingsRepo {
  private cache: Settings | null = null;
  private box: Box | null = null;

  constructor(private readonly db: Db) {}

  setBox(box: Box): void {
    this.box = box;
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

  private load(): Settings {
    const row = this.db.get<{ json: string }>('SELECT json FROM settings WHERE id = 1');
    if (!row) return defaultSettings();

    const parsed = JSON.parse(row.json) as Settings;
    this.decryptSensitive(parsed);
    return normalizeSettings(parsed);
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
    if (!this.box) return v;
    if (v.llm.api_key !== '' && !v.llm.api_key.startsWith(ENC_PREFIX)) {
      v.llm.api_key = ENC_PREFIX + this.box.encrypt(v.llm.api_key);
    }
    if (v.panel.totp_secret !== '' && !v.panel.totp_secret.startsWith(ENC_PREFIX)) {
      v.panel.totp_secret = ENC_PREFIX + this.box.encrypt(v.panel.totp_secret);
    }
    return v;
  }

  private decryptSensitive(v: Settings): void {
    if (!this.box) return;
    if (v.llm.api_key.startsWith(ENC_PREFIX)) {
      try {
        v.llm.api_key = this.box.decrypt(v.llm.api_key.slice(ENC_PREFIX.length));
      } catch (e) {
        throw new Error(`解密 LLM API Key 失败: ${(e as Error).message}`);
      }
    }
    if (v.panel.totp_secret.startsWith(ENC_PREFIX)) {
      try {
        v.panel.totp_secret = this.box.decrypt(v.panel.totp_secret.slice(ENC_PREFIX.length));
      } catch (e) {
        throw new Error(`解密 TOTP 密钥失败: ${(e as Error).message}`);
      }
    }
  }
}
