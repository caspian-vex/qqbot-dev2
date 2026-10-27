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

  private byName(name: string): Persona | undefined {
    const row = this.db.get<PersonaRow>(
      `SELECT ${SELECT_COLS} FROM personas WHERE name = ?`,
      name,
    );
    return row ? toPersona(row) : undefined;
  }
}
