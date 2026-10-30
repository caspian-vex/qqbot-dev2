// 长期记忆：日摘要、事实、消费水位线。
//
// 三块东西放在一个仓储里，是因为它们被同一件事驱动：摘要。
// 拆成三个仓储的话，摘要器要同时注入三个依赖，而这几个表又互相参照
// （水位线决定读哪些消息，摘要产出写摘要表和事实表），分家只会让调用方
// 拼装顺序变得重要。
import type { Db } from './db';
import type { Message } from './types';
import { nowSec } from '../util/time';

/** 记忆挂在哪个维度上。 */
export type MemoryScope = 'session' | 'user';
/** 事实的种类，只影响面板展示与提示词措辞。 */
export type MemoryKind = 'profile' | 'preference' | 'fact' | 'event';
/** 从哪来的：摘要产出，还是人在面板上手工加的。 */
export type MemorySource = 'digest' | 'manual';

export const MEMORY_SCOPES: readonly MemoryScope[] = ['session', 'user'];
export const MEMORY_KINDS: readonly MemoryKind[] = ['profile', 'preference', 'fact', 'event'];

/** 单条事实的字数上限。超了截断——模型偶尔会把一整天写成一段。 */
export const MAX_CONTENT = 200;
/** 太短的条目没有信息量（"他很忙"），摘要器那边也会挡，这里是第二道。 */
export const MIN_CONTENT = 2;
/**
 * 每个 owner 的事实条数上限。
 *
 * 模型每次的措辞都略有不同，唯一索引挡不住"在杭州做后端"和"杭州，后端开发"
 * 这种同义重复。没有这条闸，一个活跃的群聊半年就能攒出几千条，
 * 而召回只看前几条——多出来的部分只是白占磁盘。
 */
export const MAX_PER_OWNER = 200;
/** 同一行多久之内重复命中不更新 last_used_at（秒）。避免每条回复都写一次库。 */
const TOUCH_INTERVAL = 3600;

export interface Memory {
  id: number;
  scope: MemoryScope;
  owner_id: string;
  owner_name: string;
  kind: MemoryKind;
  content: string;
  score: number;
  source: MemorySource;
  hits: number;
  created_at: Date;
  updated_at: Date;
  last_used_at: Date;
}

export interface NewMemory {
  scope: MemoryScope;
  owner_id: string;
  owner_name?: string;
  kind?: MemoryKind;
  content: string;
  score?: number;
  source?: MemorySource;
}

/** 一次摘要的产物：某段连续对话被压成的一小段文字。 */
export interface DaySummary {
  id: number;
  session_id: string;
  /** 本地日期，仅用于展示与筛选，不参与任何唯一性判断。 */
  day: string;
  period_start: Date;
  period_end: Date;
  msg_count: number;
  content: string;
  tokens: number;
  created_at: Date;
}

export interface NewDaySummary {
  session_id: string;
  day: string;
  period_start: number;
  period_end: number;
  msg_count: number;
  content: string;
  tokens: number;
}

/** 召回时的一个归属（本会话 / 某个人）。 */
export interface MemoryOwner {
  scope: MemoryScope;
  owner_id: string;
}

export interface CursorRow {
  session_id: string;
  owner_name: string;
  /** 已处理到的最大消息 id。0 表示这条会话从未摘要过。 */
  last_msg_id: number;
  last_digest_at: number;
  digests_today: number;
  day_label: string;
  /** 连续失败次数。>=3 时调度会跳过它，等下一次成功或人工干预。 */
  failures: number;
  updated_at: number;
}

/** 一个待摘要的会话。 */
export interface DigestCandidate {
  session_id: string;
  owner_name: string;
  last_digest_at: number;
  /** 会话最后活跃时间（Unix 秒），用于判断"是不是已经安静下来了"。 */
  updated_at: number;
}

interface MemoryRow {
  id: number;
  scope: string;
  owner_id: string;
  owner_name: string;
  kind: string;
  content: string;
  score: number;
  source: string;
  hits: number;
  created_at: number;
  updated_at: number;
  last_used_at: number;
}

interface DayRow {
  id: number;
  session_id: string;
  day: string;
  period_start: number;
  period_end: number;
  msg_count: number;
  content: string;
  tokens: number;
  created_at: number;
}

function asScope(v: string): MemoryScope {
  return v === 'user' ? 'user' : 'session';
}
function asKind(v: string): MemoryKind {
  return v === 'profile' || v === 'preference' || v === 'event' ? v : 'fact';
}
function asSource(v: string): MemorySource {
  return v === 'manual' ? 'manual' : 'digest';
}

/** 内容归一化：折叠空白、去首尾、截断。唯一索引靠它才挡得住重复。 */
export function normalizeContent(s: string): string {
  return s.replace(/\s+/g, ' ').trim().slice(0, MAX_CONTENT);
}

function clampScore(n: unknown): number {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.round(n) : 3;
  return Math.min(5, Math.max(1, v));
}

function toMemory(r: MemoryRow): Memory {
  return {
    id: Number(r.id),
    scope: asScope(r.scope),
    owner_id: r.owner_id,
    owner_name: r.owner_name,
    kind: asKind(r.kind),
    content: r.content,
    score: Number(r.score),
    source: asSource(r.source),
    hits: Number(r.hits),
    created_at: new Date(Number(r.created_at) * 1000),
    updated_at: new Date(Number(r.updated_at) * 1000),
    last_used_at: new Date(Number(r.last_used_at) * 1000),
  };
}

function toDay(r: DayRow): DaySummary {
  return {
    id: Number(r.id),
    session_id: r.session_id,
    day: r.day,
    period_start: new Date(Number(r.period_start) * 1000),
    period_end: new Date(Number(r.period_end) * 1000),
    msg_count: Number(r.msg_count),
    content: r.content,
    tokens: Number(r.tokens),
    created_at: new Date(Number(r.created_at) * 1000),
  };
}

export class MemoryRepo {
  constructor(private readonly db: Db) {}

  // ---- 日摘要 ----

  /**
   * 写入一次摘要。同样的 (会话, 起, 止) 重复写会覆盖内容。
   *
   * 这条 upsert 是重试安全的：同一个时间段压两遍（进程被杀后重跑、
   * 或者摘要器把同一批消息又取了一次）不会留下两行重复的概述。
   */
  saveDay(s: NewDaySummary): void {
    this.db.run(
      `INSERT INTO memory_days
         (session_id, day, period_start, period_end, msg_count, content, tokens, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(session_id, period_start, period_end) DO UPDATE SET
         day = excluded.day,
         msg_count = excluded.msg_count,
         content = excluded.content,
         tokens = excluded.tokens`,
      s.session_id,
      s.day,
      s.period_start,
      s.period_end,
      s.msg_count,
      s.content,
      s.tokens,
      nowSec(),
    );
  }

  /** 最近 limit 条摘要，按时间段从新到旧。召回用的就是它。 */
  recentDays(sessionID: string, limit: number): DaySummary[] {
    if (limit <= 0) return [];
    return this.db
      .all<DayRow>(
        `SELECT * FROM memory_days WHERE session_id = ?
          ORDER BY period_end DESC LIMIT ?`,
        sessionID,
        limit,
      )
      .map(toDay);
  }

  listDays(f: { session_id?: string; day?: string; q?: string; limit?: number; offset?: number }): {
    items: DaySummary[];
    total: number;
  } {
    const where: string[] = [];
    const params: unknown[] = [];
    if (f.session_id) {
      where.push('session_id = ?');
      params.push(f.session_id);
    }
    if (f.day) {
      where.push('day = ?');
      params.push(f.day);
    }
    if (f.q) {
      where.push('content LIKE ?');
      params.push(`%${f.q}%`);
    }
    const tail = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';
    const limit = Math.min(500, Math.max(1, Math.floor(f.limit ?? 50)));
    const offset = Math.max(0, Math.floor(f.offset ?? 0));

    const row = this.db.get<{ n: number }>(
      `SELECT COUNT(1) AS n FROM memory_days${tail}`,
      ...params,
    );
    const items = this.db
      .all<DayRow>(
        `SELECT * FROM memory_days${tail} ORDER BY period_end DESC LIMIT ? OFFSET ?`,
        ...params,
        limit,
        offset,
      )
      .map(toDay);
    return { items, total: row ? Number(row.n) : 0 };
  }

  removeDay(id: number): boolean {
    return this.db.run(`DELETE FROM memory_days WHERE id = ?`, id) > 0;
  }

  // ---- 事实 ----

  /**
   * 写一条事实。内容相同（同 scope 同 owner）时不算新增，而是顶分与刷新时间。
   *
   * "以前记过这件事，今天又提了一遍"是有意义的信号：说明它重要，
   * 所以取两者较高的分数，并把它推到召回队列前面。
   */
  add(m: NewMemory): void {
    const content = normalizeContent(m.content);
    if (content.length < MIN_CONTENT) return;
    const now = nowSec();
    this.db.run(
      `INSERT INTO memories
         (scope, owner_id, owner_name, kind, content, score, source, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(scope, owner_id, content) DO UPDATE SET
         score = MAX(memories.score, excluded.score),
         kind = excluded.kind,
         owner_name = CASE WHEN excluded.owner_name <> ''
                           THEN excluded.owner_name ELSE memories.owner_name END,
         updated_at = excluded.updated_at`,
      m.scope,
      m.owner_id,
      m.owner_name ?? '',
      asKind(m.kind ?? 'fact'),
      content,
      clampScore(m.score),
      asSource(m.source ?? 'digest'),
      now,
      now,
    );
    this.pruneOwner(m.scope, m.owner_id, MAX_PER_OWNER);
  }

  /**
   * 召回：把多个归属的事实放进同一个排序里取前 limit 条。
   *
   * 用 UNION ALL 而不是分两次查再合并：本群的事和这个人的事谁更该进
   * prompt，是一个跨归属的全局判断。分开查就得在 JS 里重新排序，
   * 而排序键（score, updated_at）恰好是索引顺序，交给 SQLite 免费。
   */
  recall(owners: MemoryOwner[], o: { limit: number; minScore?: number }): Memory[] {
    if (owners.length === 0) return [];
    const limit = Math.max(1, Math.floor(o.limit));
    const minScore = clampScore(o.minScore ?? 1);
    const parts: string[] = [];
    const params: unknown[] = [];
    for (const owner of owners) {
      parts.push(`SELECT * FROM memories WHERE scope = ? AND owner_id = ? AND score >= ?`);
      params.push(owner.scope, owner.owner_id, minScore);
    }
    params.push(limit);
    return this.db
      .all<MemoryRow>(
        `SELECT * FROM (${parts.join(' UNION ALL ')})
          ORDER BY score DESC, updated_at DESC LIMIT ?`,
        ...params,
      )
      .map(toMemory);
  }

  list(f: {
    scope?: MemoryScope;
    owner_id?: string;
    q?: string;
    limit?: number;
    offset?: number;
  }): { items: Memory[]; total: number } {
    const where: string[] = [];
    const params: unknown[] = [];
    if (f.scope) {
      where.push('scope = ?');
      params.push(f.scope);
    }
    if (f.owner_id) {
      where.push('owner_id = ?');
      params.push(f.owner_id);
    }
    if (f.q) {
      where.push('content LIKE ?');
      params.push(`%${f.q}%`);
    }
    const tail = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';
    const limit = Math.min(500, Math.max(1, Math.floor(f.limit ?? 100)));
    const offset = Math.max(0, Math.floor(f.offset ?? 0));

    const row = this.db.get<{ n: number }>(`SELECT COUNT(1) AS n FROM memories${tail}`, ...params);
    const items = this.db
      .all<MemoryRow>(
        `SELECT * FROM memories${tail}
          ORDER BY score DESC, updated_at DESC LIMIT ? OFFSET ?`,
        ...params,
        limit,
        offset,
      )
      .map(toMemory);
    return { items, total: row ? Number(row.n) : 0 };
  }

  get(id: number): Memory | null {
    const row = this.db.get<MemoryRow>(`SELECT * FROM memories WHERE id = ?`, id);
    return row ? toMemory(row) : null;
  }

  update(id: number, patch: { kind?: MemoryKind; content?: string; score?: number }): boolean {
    const sets: string[] = [];
    const params: unknown[] = [];
    if (patch.content !== undefined) {
      const c = normalizeContent(patch.content);
      if (c.length < MIN_CONTENT) return false;
      sets.push('content = ?');
      params.push(c);
    }
    if (patch.kind !== undefined) {
      sets.push('kind = ?');
      params.push(asKind(patch.kind));
    }
    if (patch.score !== undefined) {
      sets.push('score = ?');
      params.push(clampScore(patch.score));
    }
    if (sets.length === 0) return false;
    sets.push('updated_at = ?');
    params.push(nowSec(), id);
    return this.db.run(`UPDATE memories SET ${sets.join(', ')} WHERE id = ?`, ...params) > 0;
  }

  remove(id: number): boolean {
    return this.db.run(`DELETE FROM memories WHERE id = ?`, id) > 0;
  }

  /** 清空事实（可限定范围 / 归属）。面板的「一键清空」走这里。 */
  clear(f: { scope?: MemoryScope; owner_id?: string } = {}): number {
    const where: string[] = [];
    const params: unknown[] = [];
    if (f.scope) {
      where.push('scope = ?');
      params.push(f.scope);
    }
    if (f.owner_id) {
      where.push('owner_id = ?');
      params.push(f.owner_id);
    }
    const tail = where.length > 0 ? ` WHERE ${where.join(' AND ')}` : '';
    return this.db.run(`DELETE FROM memories${tail}`, ...params);
  }

  /**
   * 把某个归属裁到 keep 条以内。
   *
   * 只删摘要产出的（source='digest'）：手工加的是人确认过的，
   * 被自动清理掉会让人以为"我明明加过"。
   */
  pruneOwner(scope: MemoryScope, ownerID: string, keep: number): number {
    return this.db.run(
      `DELETE FROM memories
        WHERE scope = ? AND owner_id = ? AND source = 'digest'
          AND id NOT IN (
            SELECT id FROM memories
             WHERE scope = ? AND owner_id = ?
             ORDER BY score DESC, updated_at DESC LIMIT ?
          )`,
      scope,
      ownerID,
      scope,
      ownerID,
      Math.max(1, keep),
    );
  }

  /** 所有有记忆的归属，面板的下拉用。 */
  owners(): { scope: MemoryScope; owner_id: string; owner_name: string; n: number }[] {
    return this.db
      .all<{ scope: string; owner_id: string; owner_name: string; n: number }>(
        `SELECT scope, owner_id,
                COALESCE(MAX(NULLIF(owner_name, '')), '') AS owner_name,
                COUNT(1) AS n
           FROM memories GROUP BY scope, owner_id ORDER BY n DESC`,
      )
      .map((r) => ({
        scope: asScope(r.scope),
        owner_id: r.owner_id,
        owner_name: r.owner_name,
        n: Number(r.n),
      }));
  }

  /** 记一次命中。只动一小时没被碰过的行，避免每条回复都写库。 */
  touchUsed(ids: number[], now = nowSec()): number {
    if (ids.length === 0) return 0;
    const marks = ids.map(() => '?').join(',');
    return this.db.run(
      `UPDATE memories SET hits = hits + 1, last_used_at = ?
        WHERE id IN (${marks}) AND last_used_at < ?`,
      now,
      ...ids,
      now - TOUCH_INTERVAL,
    );
  }

  // ---- 水位线 ----

  cursor(sessionID: string): CursorRow {
    const row = this.db.get<{
      session_id: string;
      owner_name: string;
      last_msg_id: number;
      last_digest_at: number;
      digests_today: number;
      day_label: string;
      failures: number;
      updated_at: number;
    }>(`SELECT * FROM memory_cursors WHERE session_id = ?`, sessionID);
    if (!row) {
      return {
        session_id: sessionID,
        owner_name: '',
        last_msg_id: 0,
        last_digest_at: 0,
        digests_today: 0,
        day_label: '',
        failures: 0,
        updated_at: 0,
      };
    }
    return {
      session_id: row.session_id,
      owner_name: row.owner_name,
      last_msg_id: Number(row.last_msg_id),
      last_digest_at: Number(row.last_digest_at),
      digests_today: Number(row.digests_today),
      day_label: row.day_label,
      failures: Number(row.failures),
      updated_at: Number(row.updated_at),
    };
  }

  /** 水位线之后还有多少条消息没被摘要过。 */
  pending(sessionID: string): number {
    const row = this.db.get<{ n: number }>(
      `SELECT COUNT(1) AS n FROM messages
        WHERE session_id = ?
          AND id > COALESCE((SELECT last_msg_id FROM memory_cursors WHERE session_id = ?), 0)`,
      sessionID,
      sessionID,
    );
    return row ? Number(row.n) : 0;
  }

  /** 水位线之后最早的一批消息（时间正序）。摘要器的输入。 */
  pendingBatch(sessionID: string, limit: number): Message[] {
    if (limit <= 0) return [];
    return this.db
      .all<{
        id: number;
        session_id: string;
        role: string;
        content: string;
        tokens: number;
        created_at: number;
        speaker_id: number;
        speaker_name: string;
      }>(
        `SELECT id, session_id, role, content, tokens, created_at, speaker_id, speaker_name
           FROM messages
          WHERE session_id = ?
            AND id > COALESCE((SELECT last_msg_id FROM memory_cursors WHERE session_id = ?), 0)
          ORDER BY id ASC LIMIT ?`,
        sessionID,
        sessionID,
        limit,
      )
      .map((r) => ({
        id: Number(r.id),
        session_id: r.session_id,
        role: r.role,
        content: r.content,
        tokens: Number(r.tokens),
        created_at: new Date(Number(r.created_at) * 1000),
        speaker_id: Number(r.speaker_id),
        speaker_name: r.speaker_name,
      }));
  }

  /**
   * 推进水位线并记一次成功。
   *
   * last_msg_id 取 MAX：并发或重试时可能出现较小的值，退回去会导致
   * 同一段对话被反复摘要（多花钱 + 重复记忆）。
   */
  advance(sessionID: string, msgID: number, ownerName: string, now: number, dayLabel: string): void {
    this.db.run(
      `INSERT INTO memory_cursors
         (session_id, owner_name, last_msg_id, last_digest_at, digests_today, day_label, failures, updated_at)
       VALUES (?, ?, ?, ?, 1, ?, 0, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         owner_name = CASE WHEN excluded.owner_name <> ''
                           THEN excluded.owner_name ELSE memory_cursors.owner_name END,
         last_msg_id = MAX(memory_cursors.last_msg_id, excluded.last_msg_id),
         last_digest_at = excluded.last_digest_at,
         digests_today = CASE WHEN memory_cursors.day_label = excluded.day_label
                              THEN memory_cursors.digests_today + 1 ELSE 1 END,
         day_label = excluded.day_label,
         failures = 0,
         updated_at = excluded.updated_at`,
      sessionID,
      ownerName,
      msgID,
      now,
      dayLabel,
      now,
    );
  }

  /**
   * 记一次失败。只动 failures 与 updated_at，水位线原地不动——
   * 下一次会从同一批消息重试，而不是悄悄跳过一段。
   */
  noteFailure(sessionID: string, now: number): void {
    this.db.run(
      `INSERT INTO memory_cursors (session_id, failures, updated_at) VALUES (?, 1, ?)
       ON CONFLICT(session_id) DO UPDATE SET
         failures = memory_cursors.failures + 1,
         updated_at = excluded.updated_at`,
      sessionID,
      now,
    );
  }

  /**
   * 到点该摘要的会话。
   *
   * 两个触发条件任一成立即可：
   *   ① 距上次摘要超过 sinceSec（每天一次的主路径）
   *   ② 水位线之后攒够 forceMsgs 条（繁忙群一天内的提前压）
   *
   * 失败过的会话要等冷却，否则一个坏 JSON 会让它每分钟重试一次。
   */
  dueSessions(o: {
    sinceSec: number;
    forceMsgs: number;
    failureCutoff: number;
    limit: number;
  }): DigestCandidate[] {
    // forceMsgs <= 0 表示关闭提前压。用一个大数而不是 0：0 会让
    // ">= 0" 永远成立，每个会话都被当成攒够了。
    const force = o.forceMsgs > 0 ? o.forceMsgs : Number.MAX_SAFE_INTEGER;
    return this.db
      .all<{
        session_id: string;
        owner_name: string;
        last_digest_at: number;
        updated_at: number;
      }>(
        `SELECT s.id AS session_id,
                COALESCE(c.owner_name, '') AS owner_name,
                COALESCE(c.last_digest_at, 0) AS last_digest_at,
                s.updated_at AS updated_at
           FROM sessions s
           LEFT JOIN memory_cursors c ON c.session_id = s.id
          WHERE (COALESCE(c.failures, 0) = 0 OR COALESCE(c.updated_at, 0) <= ?)
            AND (
              COALESCE(c.last_digest_at, 0) <= ?
              OR (SELECT COUNT(1) FROM messages m
                   WHERE m.session_id = s.id AND m.id > COALESCE(c.last_msg_id, 0)) >= ?
            )
            AND (SELECT COALESCE(MAX(m.id), 0) FROM messages m WHERE m.session_id = s.id)
                > COALESCE(c.last_msg_id, 0)
          ORDER BY s.updated_at DESC
          LIMIT ?`,
        o.failureCutoff,
        o.sinceSec,
        force,
        Math.max(1, o.limit),
      )
      .map((r) => ({
        session_id: r.session_id,
        owner_name: r.owner_name,
        last_digest_at: Number(r.last_digest_at),
        updated_at: Number(r.updated_at),
      }));
  }

  /** 会话的显示名（群名/昵称）。摘要时用来给 session 维度的事实一个人类可读的归属。 */
  sessionName(sessionID: string): string {
    const row = this.db.get<{ name: string }>(`SELECT name FROM sessions WHERE id = ?`, sessionID);
    return row ? row.name : '';
  }

  /** 删会话时连带清掉它的摘要与水位线。事实按 scope 分开处理，见 SessionRepo.delete。 */
  forgetSession(sessionID: string): void {
    this.db.run(`DELETE FROM memory_days WHERE session_id = ?`, sessionID);
    this.db.run(`DELETE FROM memory_cursors WHERE session_id = ?`, sessionID);
  }
}
