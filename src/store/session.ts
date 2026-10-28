// 会话与消息。
import type { Db } from './db';
import type { Message, SessionInfo } from './types';
import { nowSec } from '../util/time';

interface MessageRow {
  id: number;
  session_id: string;
  role: string;
  content: string;
  tokens: number;
  created_at: number;
}

interface SessionRow {
  id: string;
  kind: string;
  target_id: number;
  updated_at: number;
  cnt: number;
  persona_id: number;
  persona_name: string;
  target_name: string;
}

export class SessionRepo {
  constructor(private readonly db: Db) {}

  /** 更新会话最后活跃时间（不存在则创建）。 */
  touch(sessionID: string, kind: string, targetID: number): void {
    this.db.run(
      `INSERT INTO sessions (id, kind, target_id, updated_at) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at`,
      sessionID,
      kind,
      targetID,
      nowSec(),
    );
  }

  append(sessionID: string, role: string, content: string, tokens: number): void {
    this.db.run(
      `INSERT INTO messages (session_id, role, content, tokens, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      sessionID,
      role,
      content,
      tokens,
      nowSec(),
    );
  }

  /** 按时间正序返回最近 limit 条消息。 */
  recent(sessionID: string, limit: number): Message[] {
    if (limit <= 0) return [];
    const rows = this.db.all<MessageRow>(
      `SELECT id, session_id, role, content, tokens, created_at
         FROM messages WHERE session_id = ? ORDER BY id DESC LIMIT ?`,
      sessionID,
      limit,
    );
    // 查询是倒序，翻成时间正序
    return rows
      .map<Message>((r) => ({
        id: Number(r.id),
        session_id: r.session_id,
        role: r.role,
        content: r.content,
        tokens: Number(r.tokens),
        created_at: new Date(Number(r.created_at) * 1000),
      }))
      .reverse();
  }

  count(sessionID: string): number {
    const row = this.db.get<{ n: number }>(
      `SELECT COUNT(1) AS n FROM messages WHERE session_id = ?`,
      sessionID,
    );
    return row ? Number(row.n) : 0;
  }

  /** 清空消息但保留会话记录（面板里仍可见）。 */
  clear(sessionID: string): void {
    this.db.tx(() => {
      this.db.run(`DELETE FROM messages WHERE session_id = ?`, sessionID);
      this.db.run(`UPDATE sessions SET updated_at = ? WHERE id = ?`, nowSec(), sessionID);
    });
  }

  delete(sessionID: string): void {
    this.db.tx(() => {
      this.db.run(`DELETE FROM messages WHERE session_id = ?`, sessionID);
      this.db.run(`DELETE FROM sessions WHERE id = ?`, sessionID);
    });
  }

  /** 会话列表，按最近活跃排序。附带该会话绑定的人格（未绑定为 0/''）。 */
  list(limit = 200): SessionInfo[] {
    return this.db
      .all<SessionRow>(
        `SELECT s.id, s.kind, s.target_id, s.updated_at,
                (SELECT COUNT(1) FROM messages m WHERE m.session_id = s.id) AS cnt,
                COALESCE(b.persona_id, 0)  AS persona_id,
                COALESCE(p.name, '')       AS persona_name,
                COALESCE(b.target_name, '') AS target_name
           FROM sessions s
           LEFT JOIN session_personas b ON b.session_id = s.id
           LEFT JOIN personas p         ON p.id = b.persona_id
          ORDER BY s.updated_at DESC LIMIT ?`,
        limit,
      )
      .map((r) => ({
        id: r.id,
        kind: r.kind,
        target_id: Number(r.target_id),
        messages: Number(r.cnt),
        updated_at: new Date(Number(r.updated_at) * 1000),
        persona_id: Number(r.persona_id),
        persona_name: r.persona_name,
        // 预设时存下的群名/昵称。会话真来过消息后，如果这里为空，
        // 面板就退回显示号码——预设行不能因为"开口说话"就丢掉名字。
        name: r.target_name === '' ? undefined : r.target_name,
      }));
  }

  /** 删除超过保留期的消息，防止数据库无限增长。 */
  prune(retainSeconds: number): number {
    const cutoff = nowSec() - retainSeconds;
    return this.db.run(`DELETE FROM messages WHERE created_at < ?`, cutoff);
  }
}
