// 人格（系统提示词）的读写。
import type { Db } from './db';
import {
  DEFAULT_PERSONA_NAME,
  DEFAULT_SYSTEM_PROMPT,
  type Persona,
} from './types';
import { nowSec } from '../util/time';

interface PersonaRow {
  id: number;
  name: string;
  system_prompt: string;
  active: number;
  created_at: number;
  updated_at: number;
}

/** 绑定对话对象时一并存下的快照，仅用于面板显示。 */
export interface BindingMeta {
  kind?: string;
  name?: string;
}

/**
 * 删除人格的结果。
 *
 * 用判别式联合而不是抛 Error：调用方要把"不存在"映射成 404、把三种业务拒绝
 * 映射成 400，靠错误字符串匹配太脆——改一个字文案就变成 500。
 * 这与 parseDigest 的 { ok, reason } 是同一套写法。
 */
export type PersonaRemoveResult =
  | { ok: true; name: string }
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'last' }
  | { ok: false; reason: 'active' }
  | { ok: false; reason: 'in_use'; bindings: number };

/** 一条「会话 → 人格」绑定，附带人格名与对象快照。 */
export interface SessionBinding {
  session_id: string;
  kind: string;
  target_name: string;
  persona_id: number;
  persona_name: string;
  updated_at: Date;
}

function toPersona(r: PersonaRow): Persona {
  return {
    id: Number(r.id),
    name: r.name,
    system_prompt: r.system_prompt,
    active: Number(r.active) === 1,
    created_at: new Date(Number(r.created_at) * 1000),
    updated_at: new Date(Number(r.updated_at) * 1000),
  };
}

const SELECT_COLS = `id, name, system_prompt, active, created_at, updated_at`;

export class PersonaRepo {
  constructor(private readonly db: Db) {}

  /** 返回当前启用的人格；没有任何人格时自动创建默认人格。 */
  active(): Persona {
    const row = this.db.get<PersonaRow>(
      `SELECT ${SELECT_COLS} FROM personas WHERE active = 1 ORDER BY id LIMIT 1`,
    );
    if (row) return toPersona(row);

    // 首次运行：落一个默认人格
    const ts = nowSec();
    this.db.run(
      `INSERT INTO personas (name, system_prompt, active, created_at, updated_at)
       VALUES (?, ?, 1, ?, ?)`,
      DEFAULT_PERSONA_NAME,
      DEFAULT_SYSTEM_PROMPT,
      ts,
      ts,
    );
    const created = this.byName(DEFAULT_PERSONA_NAME);
    if (!created) throw new Error('创建默认人格失败');
    return created;
  }

  list(): Persona[] {
    return this.db
      .all<PersonaRow>(`SELECT ${SELECT_COLS} FROM personas ORDER BY id`)
      .map(toPersona);
  }

  /** 按名字创建或更新人格（不会改变启用状态）。 */
  upsert(name: string, systemPrompt: string): Persona {
    if (name === '') throw new Error('人格名不能为空');
    const ts = nowSec();
    this.db.run(
      `INSERT INTO personas (name, system_prompt, active, created_at, updated_at)
       VALUES (?, ?, 0, ?, ?)
       ON CONFLICT(name) DO UPDATE SET system_prompt = excluded.system_prompt,
                                       updated_at   = excluded.updated_at`,
      name,
      systemPrompt,
      ts,
      ts,
    );
    const p = this.byName(name);
    if (!p) throw new Error('保存人格失败');
    return p;
  }

  /** 切换启用的人格（同一事务内取消其它人格）。 */
  activate(id: number): void {
    this.db.tx(() => {
      this.db.run(`UPDATE personas SET active = 0 WHERE active = 1`);
      const n = this.db.run(`UPDATE personas SET active = 1, updated_at = ? WHERE id = ?`, nowSec(), id);
      if (n === 0) throw new Error('记录不存在');
    });
  }

  /**
   * 删除一个人格。
   *
   * 只允许删「没在启用、也没有会话单独指定」的那一个。三道闸的顺序有讲究：
   *
   *   1. 只剩一个时它必然是启用中的，所以"仅剩一个"必须排在"启用中"之前——
   *      否则用户会拿到一句「先启用另一个」，而这里根本没有另一个人格可启用。
   *   2. "有绑定就拒绝"优先于删除，而不是删完靠 CASCADE 清绑定。删除是不可逆的，
   *      顺手把几个群的独立人格一起抹掉，用户多半没预料到；报错让他先解绑，
   *      影响面就始终握在他手里。
   *
   * session_personas 上的 ON DELETE CASCADE 仍然留着当兜底（比如有人直接用
   * SQL 删行），但正常路径永远走不到它。
   */
  remove(id: number): PersonaRemoveResult {
    return this.db.tx((): PersonaRemoveResult => {
      const row = this.db.get<{ id: number; name: string; active: number }>(
        `SELECT id, name, active FROM personas WHERE id = ?`,
        id,
      );
      if (!row) return { ok: false, reason: 'not_found' };

      const total = this.db.get<{ n: number }>(`SELECT COUNT(1) AS n FROM personas`);
      if (Number(total?.n ?? 0) <= 1) return { ok: false, reason: 'last' };

      if (Number(row.active) === 1) return { ok: false, reason: 'active' };

      const used = this.db.get<{ n: number }>(
        `SELECT COUNT(1) AS n FROM session_personas WHERE persona_id = ?`,
        id,
      );
      const bindings = Number(used?.n ?? 0);
      if (bindings > 0) return { ok: false, reason: 'in_use', bindings };

      this.db.run(`DELETE FROM personas WHERE id = ?`, id);
      return { ok: true, name: row.name };
    });
  }

  /**
   * 某个会话实际生效的人格。
   *
   * 绑定过就用绑定的，没绑定就用全局启用的那个——这样"按会话分人格"
   * 是可选增强，不改变只有一个会话时的行为。
   * 绑定指向的人格若已不存在（理论上被 CASCADE 清掉了），同样回落到全局，
   * 绝不能让一条脏绑定把回复链路打断。
   */
  forSession(sessionID: string): Persona {
    if (sessionID !== '') {
      const row = this.db.get<PersonaRow>(
        `SELECT p.id, p.name, p.system_prompt, p.active, p.created_at, p.updated_at
           FROM session_personas b
           JOIN personas p ON p.id = b.persona_id
          WHERE b.session_id = ?`,
        sessionID,
      );
      if (row) return toPersona(row);
    }
    return this.active();
  }

  /** 会话绑定的人格 id；未绑定返回 0。 */
  bindingOf(sessionID: string): number {
    const row = this.db.get<{ persona_id: number }>(
      `SELECT persona_id FROM session_personas WHERE session_id = ?`,
      sessionID,
    );
    return row ? Number(row.persona_id) : 0;
  }

  /**
   * 绑定会话到某个人格；personaID <= 0 表示解除绑定（回到跟随全局）。
   * 人格不存在时抛错，避免前端把 id 传错后留下一条永远回落的死绑定。
   *
   * meta 是对话对象的快照（群名/昵称），只用于面板显示。留空时保留原有
   * 快照而不是清成空串——否则用户第二次只改人格、没带名字，列表里那行
   * 就从「XX 群」退化成一串号码，看起来像数据丢了。
   */
  bind(sessionID: string, personaID: number, meta: BindingMeta = {}): void {
    if (sessionID === '') throw new Error('会话 ID 不能为空');
    if (personaID <= 0) {
      this.db.run(`DELETE FROM session_personas WHERE session_id = ?`, sessionID);
      return;
    }
    const exists = this.db.get<{ id: number }>(`SELECT id FROM personas WHERE id = ?`, personaID);
    if (!exists) throw new Error('人格不存在');
    this.db.run(
      `INSERT INTO session_personas (session_id, persona_id, kind, target_name, updated_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         persona_id  = excluded.persona_id,
         kind        = CASE WHEN excluded.kind        <> '' THEN excluded.kind
                            ELSE session_personas.kind END,
         target_name = CASE WHEN excluded.target_name <> '' THEN excluded.target_name
                            ELSE session_personas.target_name END,
         updated_at  = excluded.updated_at`,
      sessionID,
      personaID,
      meta.kind ?? '',
      meta.name ?? '',
      nowSec(),
    );
  }

  /**
   * 全部绑定，附带人格名与快照，按绑定时间倒序。
   *
   * 面板用它补出"已绑人格但还没产生消息"的行。这些行在 sessions 表里
   * 根本不存在，光靠 sessions.list() 是列不出来的。
   */
  bindings(): SessionBinding[] {
    return this.db
      .all<{
        session_id: string;
        kind: string;
        target_name: string;
        persona_id: number;
        persona_name: string;
        updated_at: number;
      }>(
        `SELECT b.session_id, b.kind, b.target_name, b.persona_id,
                COALESCE(p.name, '') AS persona_name, b.updated_at
           FROM session_personas b
           LEFT JOIN personas p ON p.id = b.persona_id
          ORDER BY b.updated_at DESC, b.session_id`,
      )
      .map((r) => ({
        session_id: r.session_id,
        kind: r.kind,
        target_name: r.target_name,
        persona_id: Number(r.persona_id),
        persona_name: r.persona_name,
        updated_at: new Date(Number(r.updated_at) * 1000),
      }));
  }

  /** 绑定关系总数（面板/自检用）。 */
  bindingCount(): number {
    const row = this.db.get<{ n: number }>(`SELECT COUNT(1) AS n FROM session_personas`);
    return row ? Number(row.n) : 0;
  }

  /**
   * 每个人格被多少个会话单独指定。没有绑定的 id 不会出现在结果里。
   *
   * 面板拿它提前禁用"删除"按钮并写明原因。不带这条信息的话，用户只能点下去
   * 再吃一个 400，然后自己去会话页翻是哪个群在用。
   */
  bindingCounts(): Map<number, number> {
    const rows = this.db.all<{ persona_id: number; n: number }>(
      `SELECT persona_id, COUNT(1) AS n FROM session_personas GROUP BY persona_id`,
    );
    const out = new Map<number, number>();
    for (const r of rows) out.set(Number(r.persona_id), Number(r.n));
    return out;
  }

  private byName(name: string): Persona | undefined {
    const row = this.db.get<PersonaRow>(
      `SELECT ${SELECT_COLS} FROM personas WHERE name = ?`,
      name,
    );
    return row ? toPersona(row) : undefined;
  }
}
