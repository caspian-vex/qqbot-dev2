// 预排的主动消息（"闹钟"）。
//
// 存在的唯一理由：**进程会死**。内存里的 setTimeout 撑不过一次
// `qqbot restart`、一次 OOM、一次镜像升级，而主动消息恰恰是
// "隔几小时/隔天"才发的东西——它活在定时器里的时间远远长于
// 一个容器的平均寿命。
//
// 所以这里的语义是"意图"而不是"任务"：库里记的是
// 「这个会话，在这个时刻，说这句话（或让模型自己说）」，
// 由引擎每分钟捞一次到期的。重启后捞到的就是还欠着的那几条。
import type { Db } from './db';
import { nowSec } from '../util/time';

/** 这条消息是怎么来的。只用于日志与面板展示，不影响投递。 */
export type ScheduledSource = 'tool' | 'slot' | 'idle' | 'topic';

/**
 * pending  → 等着发
 * done     → 已发出
 * cancelled→ 被取消（删会话、用户撤了）
 * expired  → 过期太久，主动放弃
 *
 * 为什么把 expired 单列而不是并进 cancelled：前者是"机器停过机"，
 * 后者是"人不想发了"。出了"提醒没到"的问题时，这两者的排查方向完全相反。
 */
export type ScheduledStatus = 'pending' | 'done' | 'cancelled' | 'expired';

/** 一行原文。时间一律 Unix 秒，与库里其它表保持一致。 */
export interface ScheduledRow {
  id: number;
  session_id: string;
  kind: string;
  target_id: number;
  due_at: number;
  source: string;
  body: string;
  status: string;
  created_at: number;
  fired_at: number;
}

export interface NewSchedule {
  session_id: string;
  kind: string;
  target_id: number;
  /** 到点时间（Unix 秒）。 */
  due_at: number;
  /** 要说的原话；空串表示"到点让模型自己组织一句"。 */
  body?: string;
  source?: ScheduledSource;
}

/**
 * 单个会话最多挂几个待发的闹钟。
 *
 * 上限的作用不是省资源，而是挡住"模型被诱导着排了一百条"：
 * 那等于给一个 QQ 号装上定时轰炸机，封号是分分钟的事。
 */
export const MAX_PENDING_PER_SESSION = 5;

/** 过期多久就直接放弃（秒）。 */
export const EXPIRE_AFTER_SEC = 6 * 3600;

interface Row {
  id: number;
  session_id: string;
  kind: string;
  target_id: number;
  due_at: number;
  source: string;
  body: string;
  status: string;
  created_at: number;
  fired_at: number;
}

function toRow(r: Row): ScheduledRow {
  return {
    id: Number(r.id),
    session_id: r.session_id,
    kind: r.kind,
    target_id: Number(r.target_id),
    due_at: Number(r.due_at),
    source: r.source,
    body: r.body,
    status: r.status,
    created_at: Number(r.created_at),
    fired_at: Number(r.fired_at),
  };
}

export class ScheduledRepo {
  constructor(private readonly db: Db) {}

  /**
   * 排一条。返回新行的 id。
   *
   * 满了就抛错而不是静默丢弃：调用方是模型（通过工具），
   * 静默丢会让它以为排上了，转头跟用户说"明天早上叫你"。
   */
  add(s: NewSchedule): number {
    if (this.countPending(s.session_id) >= MAX_PENDING_PER_SESSION) {
      throw new Error(`这个会话已经有 ${MAX_PENDING_PER_SESSION} 条待发的定时消息了`);
    }
    this.db.run(
      `INSERT INTO scheduled_messages
         (session_id, kind, target_id, due_at, source, body, status, created_at, fired_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, 0)`,
      s.session_id,
      s.kind,
      s.target_id,
      Math.floor(s.due_at),
      s.source ?? 'tool',
      s.body ?? '',
      nowSec(),
    );
    const row = this.db.get<{ id: number }>('SELECT last_insert_rowid() AS id');
    return row ? Number(row.id) : 0;
  }

  /**
   * 取到期待发的。
   *
   * 按 due_at 升序：停机久了可能一次积压好几条，先到期的先发，
   * 否则"昨晚的晚安"会排在"今早的早安"后面。
   */
  due(now: number, limit = 8): ScheduledRow[] {
    if (limit <= 0) return [];
    return this.db
      .all<Row>(
        `SELECT * FROM scheduled_messages
          WHERE status = 'pending' AND due_at <= ?
          ORDER BY due_at ASC, id ASC LIMIT ?`,
        Math.floor(now),
        limit,
      )
      .map(toRow);
  }

  /**
   * 把过期太久的直接标掉，返回条数。
   *
   * 为什么要有这一步：停机三天后开机，积压的"晚安"如果照发，
   * 用户会看到一串迟到的自言自语——比漏发难看得多。
   */
  expireStale(now: number): number {
    return this.db.run(
      `UPDATE scheduled_messages SET status = 'expired'
        WHERE status = 'pending' AND due_at < ?`,
      Math.floor(now) - EXPIRE_AFTER_SEC,
    );
  }

  markDone(id: number, at: number = nowSec()): void {
    this.db.run(
      `UPDATE scheduled_messages SET status = 'done', fired_at = ?
        WHERE id = ? AND status = 'pending'`,
      Math.floor(at),
      id,
    );
  }

  /** 单条撤销。返回是否真的撤掉了一条（false 表示它已经发过了）。 */
  cancel(id: number): boolean {
    return (
      this.db.run(
        `UPDATE scheduled_messages SET status = 'cancelled' WHERE id = ? AND status = 'pending'`,
        id,
      ) > 0
    );
  }

  /** 撤掉某会话的全部待发。删会话时用，返回撤掉的条数。 */
  cancelSession(sessionID: string): number {
    return this.db.run(
      `UPDATE scheduled_messages SET status = 'cancelled'
        WHERE session_id = ? AND status = 'pending'`,
      sessionID,
    );
  }

  /** 某会话待发的全部（按时间正序），供面板与"还剩几条"的判断。 */
  pending(sessionID: string): ScheduledRow[] {
    return this.db
      .all<Row>(
        `SELECT * FROM scheduled_messages
          WHERE session_id = ? AND status = 'pending'
          ORDER BY due_at ASC, id ASC`,
        sessionID,
      )
      .map(toRow);
  }

  /** 某会话待发条数；不传会话则统计全库。 */
  countPending(sessionID = ''): number {
    const row =
      sessionID === ''
        ? this.db.get<{ n: number }>(
            `SELECT COUNT(1) AS n FROM scheduled_messages WHERE status = 'pending'`,
          )
        : this.db.get<{ n: number }>(
            `SELECT COUNT(1) AS n FROM scheduled_messages
              WHERE status = 'pending' AND session_id = ?`,
            sessionID,
          );
    return row ? Number(row.n) : 0;
  }

  /** 最近的若干条（含已完成），面板用来给用户看"我说过什么"。 */
  recent(limit = 50): ScheduledRow[] {
    if (limit <= 0) return [];
    return this.db
      .all<Row>(
        `SELECT * FROM scheduled_messages ORDER BY id DESC LIMIT ?`,
        limit,
      )
      .map(toRow);
  }

  /**
   * 清理老记录。
   *
   * 与 messages 的 prune 同一思路：这张表只增不减的话，
   * 一两年后每行 JSON 都变小不了多少，但备份文件会一直涨。
   */
  prune(before: number): number {
    return this.db.run(
      `DELETE FROM scheduled_messages
        WHERE status <> 'pending' AND created_at < ?`,
      Math.floor(before),
    );
  }
}
