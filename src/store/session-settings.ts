// 按对话对象的设置覆盖（session_settings）。
//
// 与 session_personas 是同一类东西：一张不依赖 sessions 存在的旁表，
// 所以"还没开口的群"也能先配好一套设置。
//
// 这一层只管存取，不理解字段语义：
//   写入前调用方负责补全（normalizeOverrides），
//   读出后调用方负责合成（resolveSettings）。
import type { Db } from './db';
import type { SessionOverrides } from './overrides';
import { isEmptyOverrides } from './overrides';
import { nowSec } from '../util/time';

interface OverrideRow {
  session_id: string;
  kind: string;
  target_name: string;
  overrides: string;
  updated_at: number;
}

/** 一条覆盖记录，附带对象快照（面板补预设行时用）。 */
export interface SessionOverrideRow {
  session_id: string;
  kind: string;
  target_name: string;
  updated_at: Date;
}

/** 写覆盖时一并存下的快照，仅用于面板显示。 */
export interface OverrideMeta {
  kind?: string;
  name?: string;
}

export class SessionSettingsRepo {
  constructor(private readonly db: Db) {}

  /**
   * 读一个会话的覆盖，没有返回 null。
   *
   * 坏 JSON 也返回 null 而不是抛：一条手改坏的记录不该让机器人从此
   * 在这个群里失语。引擎侧会回落到全局设置，面板那边删一次就恢复了。
   */
  get(sessionID: string): SessionOverrides | null {
    if (sessionID === '') return null;
    const row = this.db.get<OverrideRow>(`SELECT overrides FROM session_settings WHERE session_id = ?`, sessionID);
    if (!row) return null;
    try {
      const parsed: unknown = JSON.parse(row.overrides);
      if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
      return parsed as SessionOverrides;
    } catch {
      return null;
    }
  }

  /**
   * 整份替换一个会话的覆盖；空覆盖等价于"全部跟随全局"，直接删行。
   *
   * kind / target_name 的空串不覆盖旧值：与 persona.bind 同一条规矩——
   * 只改设置、不带名字时，不能把已经存下的群名退化成空。
   */
  set(sessionID: string, ov: SessionOverrides, meta: OverrideMeta = {}): void {
    if (sessionID === '') throw new Error('会话 ID 不能为空');
    if (isEmptyOverrides(ov)) {
      this.clear(sessionID);
      return;
    }
    this.db.run(
      `INSERT INTO session_settings (session_id, kind, target_name, overrides, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         kind        = CASE WHEN excluded.kind        <> '' THEN excluded.kind
                            ELSE session_settings.kind END,
         target_name = CASE WHEN excluded.target_name <> '' THEN excluded.target_name
                            ELSE session_settings.target_name END,
         overrides   = excluded.overrides,
         updated_at  = excluded.updated_at`,
      sessionID,
      meta.kind ?? '',
      meta.name ?? '',
      JSON.stringify(ov),
      nowSec(),
    );
  }

  clear(sessionID: string): void {
    this.db.run(`DELETE FROM session_settings WHERE session_id = ?`, sessionID);
  }

  /**
   * 全部覆盖记录（不含 JSON 正文）。
   *
   * 面板列会话时要用它补出"配了设置但还没说过话"的行；带 JSON 会在
   * 几百个会话时白读一堆用不上的字节。
   */
  list(): SessionOverrideRow[] {
    return this.db
      .all<OverrideRow>(
        `SELECT session_id, kind, target_name, overrides, updated_at
           FROM session_settings ORDER BY updated_at DESC, session_id`,
      )
      .map((r) => ({
        session_id: r.session_id,
        kind: r.kind,
        target_name: r.target_name,
        updated_at: new Date(Number(r.updated_at) * 1000),
      }));
  }

  /** 有覆盖的会话 ID 集合。列表接口用它给已有会话打「独立」标记。 */
  ids(): Set<string> {
    const rows = this.db.all<{ session_id: string }>(`SELECT session_id FROM session_settings`);
    return new Set(rows.map((r) => r.session_id));
  }

  count(): number {
    const row = this.db.get<{ n: number }>(`SELECT COUNT(1) AS n FROM session_settings`);
    return row ? Number(row.n) : 0;
  }
}
