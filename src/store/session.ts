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
  name: string;
}

export class SessionRepo {
  constructor(private readonly db: Db) {}

  /**
   * 更新会话最后活跃时间（不存在则创建）。
   *
   * name 是「对话对象的名字」（群名 / 好友昵称），只用于面板显示。
   * 传空串时不会把已有的名字擦掉：群名拉取失败、私聊没带昵称都会传空，
   * 若照写就会把上一次记下的名字清成空白，列表一夜之间退化成一片号码。
   */
  touch(sessionID: string, kind: string, targetID: number, name = ''): void {
    this.db.run(
      `INSERT INTO sessions (id, kind, target_id, updated_at, name) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET updated_at = excluded.updated_at,
               name = CASE WHEN excluded.name <> '' THEN excluded.name ELSE sessions.name END`,
      sessionID,
      kind,
      targetID,
      nowSec(),
      name,
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

  /**
   * 删会话：消息、会话行、以及这一套独立的设置。
   *
   * 设置必须一起删。否则同一个人/群再开口时会建一条新会话，几个月前
   * 那套覆盖会悄悄复活——而用户以为自己早清干净了，只会觉得"这机器人
   * 怎么突然不听全局设置了"。
   */
  delete(sessionID: string): void {
    this.db.tx(() => {
      this.db.run(`DELETE FROM messages WHERE session_id = ?`, sessionID);
      this.db.run(`DELETE FROM sessions WHERE id = ?`, sessionID);
      this.db.run(`DELETE FROM session_settings WHERE session_id = ?`, sessionID);
      // 已经排上的主动消息也必须一起删：会话都没了，几天后它还冒出来
      // 说一句"记得交房租"，用户只会觉得见鬼了。
      this.db.run(`DELETE FROM scheduled_messages WHERE session_id = ?`, sessionID);
    });
  }

  /**
   * 会话列表，按最近活跃排序。附带人格绑定与对话对象的名字。
   *
   * 名字两个来源，先到先用：会话自己记下的（说话时抓的群名/昵称）优先，
   * 其次是预设人格时存下的快照。后者只在绑定里存在，会话主动过消息之后
   * 也该继续用——不能因为"开口说话"就把「夜猫子群」退回成一串号码。
   */
  list(limit = 200): SessionInfo[] {
    return this.db
      .all<SessionRow>(
        `SELECT s.id, s.kind, s.target_id, s.updated_at,
                (SELECT COUNT(1) FROM messages m WHERE m.session_id = s.id) AS cnt,
                COALESCE(b.persona_id, 0)  AS persona_id,
                COALESCE(p.name, '')       AS persona_name,
                COALESCE(NULLIF(s.name, ''), b.target_name, '') AS name
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
        // 两个来源都空时才让前端自己想办法（实时拉群/好友列表，再不行显示号码）
        name: r.name === '' ? undefined : r.name,
      }));
  }

  /** 删除超过保留期的消息，防止数据库无限增长。 */
  prune(retainSeconds: number): number {
    const cutoff = nowSec() - retainSeconds;
    return this.db.run(`DELETE FROM messages WHERE created_at < ?`, cutoff);
  }
}
