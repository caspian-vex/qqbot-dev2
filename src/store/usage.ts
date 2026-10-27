// 用量记账与审计。
//
// 与原版的关键差异：原版把每次调用写一行明细，查用量时扫全表逐行累加；
// 这里改成写时聚合到 usage_daily，查询变成一次主键查找。
// 费用用「整数微元」累加，避免浮点漂移，出口再除 1e6。
import type { Db } from './db';
import type { AuditEntry, UsageSummary } from './types';
import { localDay, nowSec } from '../util/time';

interface UsageRow {
  day: string;
  requests: number;
  peak_requests: number;
  prompt_tokens: number;
  completion_tokens: number;
  cost_micros: number;
}

interface AuditRow {
  id: number;
  action: string;
  detail: string;
  remote: string;
  created_at: number;
}

/**
 * DeepSeek Flash 峰谷价：空闲输入 1 元 / 输出 4 元 每百万 token，高峰翻倍。
 * 微元口径下 cost_micros = (pt * 1 + ct * 4) * mult，恒为整数。
 */
function costMicros(promptTokens: number, completionTokens: number, peak: boolean): number {
  const base = promptTokens * 1 + completionTokens * 4;
  return peak ? base * 2 : base;
}

function toSummary(r: UsageRow): UsageSummary {
  return {
    day: r.day,
    prompt_tokens: Number(r.prompt_tokens),
    completion_tokens: Number(r.completion_tokens),
    requests: Number(r.requests),
    peak_requests: Number(r.peak_requests),
    cost_cny: Number(r.cost_micros) / 1_000_000,
  };
}

export class UsageRepo {
  constructor(private readonly db: Db) {}

  /** 记录一次模型调用的 token 消耗。 */
  record(model: string, promptTokens: number, completionTokens: number, peak: boolean): void {
    void model; // 当前不按模型维度统计，保留参数以便将来扩展
    const day = localDay();
    const micros = costMicros(promptTokens, completionTokens, peak);
    this.db.run(
      `INSERT INTO usage_daily (day, requests, peak_requests, prompt_tokens, completion_tokens, cost_micros)
       VALUES (?, 1, ?, ?, ?, ?)
       ON CONFLICT(day) DO UPDATE SET
         requests          = requests + 1,
         peak_requests     = peak_requests + excluded.peak_requests,
         prompt_tokens     = prompt_tokens + excluded.prompt_tokens,
         completion_tokens = completion_tokens + excluded.completion_tokens,
         cost_micros       = cost_micros + excluded.cost_micros`,
      day,
      peak ? 1 : 0,
      promptTokens,
      completionTokens,
      micros,
    );
  }

  /** 指定日期的用量汇总；无数据时返回全零（与原版一致，不是 null）。 */
  forDay(day: string): UsageSummary {
    const row = this.db.get<UsageRow>(`SELECT * FROM usage_daily WHERE day = ?`, day);
    if (!row) {
      return {
        day,
        prompt_tokens: 0,
        completion_tokens: 0,
        requests: 0,
        peak_requests: 0,
        cost_cny: 0,
      };
    }
    return toSummary(row);
  }

  /**
   * 最近 n 天有数据的汇总，按日期升序。
   *
   * 语义照抄原版：取「最近 n 个有记录的 day」，不是最近 n 个自然日。
   * 顺手改成日历填充会让前端折线图多出一堆零点。
   */
  recent(n: number): UsageSummary[] {
    const limit = n > 0 ? n : 7;
    const rows = this.db.all<UsageRow>(
      `SELECT * FROM usage_daily ORDER BY day DESC LIMIT ?`,
      limit,
    );
    return rows.map(toSummary).reverse();
  }

  today(): UsageSummary {
    return this.forDay(localDay());
  }
}

export class AuditRepo {
  constructor(private readonly db: Db) {}

  record(action: string, detail: string, remote: string): void {
    try {
      this.db.run(
        `INSERT INTO audit_log (action, detail, remote, created_at) VALUES (?, ?, ?, ?)`,
        action,
        detail,
        remote,
        nowSec(),
      );
    } catch {
      // 审计失败不影响主流程（与原版一致）
    }
  }

  list(limit = 100): AuditEntry[] {
    const n = limit > 0 ? limit : 100;
    return this.db
      .all<AuditRow>(
        `SELECT id, action, detail, remote, created_at FROM audit_log
          ORDER BY id DESC LIMIT ?`,
        n,
      )
      .map((r) => ({
        id: Number(r.id),
        action: r.action,
        detail: r.detail,
        remote: r.remote,
        created_at: new Date(Number(r.created_at) * 1000),
      }));
  }
}
