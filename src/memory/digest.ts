// 摘要器：把攒下来的原始对话压成「概述 + 事实」。
//
// 它跑在后台，永远不阻塞回复。所有对外方法（consider / sweep）都是同步返回、
// 把真正的干活扔进事件循环——一条消息的响应时间不能被"整理记忆"拖慢，
// 1 核 2G 上一次模型请求要两秒起。
//
// 一次摘要会写三张表（摘要、事实、水位线），必须落在同一个事务里：
// 只写摘要不推水位线，下次会把同一段对话再压一遍（多花钱 + 重复记忆）；
// 只推水位线不写摘要，那段对话就永远丢了。
import {
  estimateTokens,
  type LlmClient,
  type LlmConfig,
} from '../llm/client';
import type { Logger } from '../log/logger';
import type { DaySummary, Message, Settings, Store } from '../store';
import { isPeak, localDay, nowSec } from '../util/time';
import { buildDigestMessages, buildMergeMessages, parseDigest, type DigestFact } from './prompt';

/** 一次请求最多吃多少条原始消息。约 2700 输入 token，是成本与信息量的折中。 */
export const DIGEST_BATCH = 60;
/** 单次运行最多处理几批。120 条正好对应默认的 digest_force_msgs。 */
const DIGEST_MAX_BATCHES = 2;
/** 一轮 tick 最多排几个会话，避免 20 个群同时到点时把并发打满。 */
export const DIGEST_SWEEP = 4;
export const DIGEST_MAX_TOKENS = 700;
export const DIGEST_TIMEOUT_MS = 20_000;
/** 1 核 2G，宁可排队也别并发抢 CPU。 */
export const DIGEST_CONCURRENCY = 1;
/**
 * 进程级每日硬顶，不可配置。
 *
 * 与 ECHO_DAILY_HARD_CAP 同一个思路：每会话的日上限是配置项，
 * Σ(各会话上限) 会被配置放大；这道闸不上面板，正常用永远碰不到。
 */
export const DIGEST_DAILY_HARD_CAP = 40;
/** 少于这么多条就不值当调一次模型（"嗯""好""在吗"这段话没有可记的）。 */
export const DIGEST_MIN_MSGS = 6;
/** 失败后的冷却，防止一个坏 JSON 让同一会话每分钟重试一次。 */
export const FAILURE_COOLDOWN_SEC = 6 * 3600;

export interface DigestOutcome {
  ok: boolean;
  /** 新写入的事实条数（重复的不会计入）。 */
  added: number;
  summary: string;
  reason?: string;
}

export interface DigesterOptions {
  store: Store;
  llm: LlmClient;
  log: Logger;
  signal?: AbortSignal;
}

interface Job {
  sessionID: string;
  settings: Settings;
}

export class Digester {
  private readonly store: Store;
  private readonly llm: LlmClient;
  private readonly log: Logger;
  private readonly signal: AbortSignal | undefined;

  /** 正在跑的会话。同一个会话绝不并发摘要——两次读到的水位线一样，会重复写。 */
  private readonly inflight = new Set<string>();
  private readonly queue: Job[] = [];
  private running = 0;
  /** 进程级的当日计数与日期标签，跨零点时清零。 */
  private quotaDay = '';
  private quotaUsed = 0;

  constructor(opt: DigesterOptions) {
    this.store = opt.store;
    this.llm = opt.llm;
    // 正常是带 with() 的 Logger；少数集成测试注入的是扁平桩（只有四个级别方法），
    // 退化成直接用，别为了一个 component 标签让整个引擎构造不了。
    const maybe = opt.log as Partial<Logger>;
    this.log =
      typeof maybe.with === 'function' ? (maybe.with({ component: 'memory' }) as Logger) : opt.log;
    this.signal = opt.signal;
  }

  /**
   * 回复落库之后调用：只在「攒够条数」时排一次后台摘要。
   *
   * 每天一次的常规调度在 sweep() 里。这里多一道的原因有两个：
   * 繁忙的群一天就能攒出几百条，等到 24 小时后再压会超出单批容量；
   * 而低流量的私聊可能聊完就散，等不到 tick 的间隔条件。
   */
  consider(sessionID: string, s: Settings, meta?: { ownerName?: string }): void {
    if (!s.memory.enabled) return;
    const force = s.memory.digest_force_msgs;
    if (!(force > 0)) return;
    try {
      // 记下名字：摘要成功后要把它写进水位线，面板上才显示得出是哪个群。
      if (meta?.ownerName) this.rememberName(sessionID, meta.ownerName);
      if (this.store.memory.pending(sessionID) < force) return;
    } catch (e) {
      this.log.warn('检查待摘要条数失败', { session: sessionID, err: e });
      return;
    }
    // 配额必须在这里就问一次。
    //
    // 原来只有 sweep() 查限额，而这条路是"每攒够 digest_force_msgs 条就压一次"——
    // 一个话多的群一天能攒出几百条，于是它每几十条就压一次，
    // 每会话日上限（默认 6）和进程级硬顶对它完全不生效，账单翻几倍。
    if (!this.withinQuota(sessionID, s)) return;
    this.enqueue(sessionID, s);
  }

  /**
   * 今天还能不能给这个会话压一次。
   *
   * 两道闸：进程级硬顶（不可配置，防的是「Σ各会话上限」被配置放大）
   * 与每会话日上限。consider() 与 sweep() 都必须先问它。
   *
   * 硬顶把「排队中 + 在跑」也算进来：quotaUsed 只在成功后才 ++，
   * 同一秒里涌进来的一批会话会全部通过检查，一轮就能冲破硬顶。
   *
   * digestNow() 刻意不问：面板上手动点的那一次是运维的逃生口，
   * 用户明确要求了就不该被自动配额挡住。
   */
  private withinQuota(sessionID: string, s: Settings): boolean {
    const now = nowSec();
    const today = localDay(new Date(now * 1000));
    if (this.quotaDay !== today) {
      this.quotaDay = today;
      this.quotaUsed = 0;
    }
    if (this.quotaUsed + this.pendingJobs() >= DIGEST_DAILY_HARD_CAP) return false;

    try {
      const cur = this.store.memory.cursor(sessionID);
      const limit = Math.max(1, s.memory.digest_daily_limit);
      if (cur.day_label === today && cur.digests_today >= limit) return false;
    } catch {
      // 读不到水位线就当没压过，交给 run() 里的条数判断兜底
    }
    return true;
  }

  /**
   * 每轮 tick 调一次：找出到点的会话并排队。
   *
   * 只做同步数据库查询，从不 await——tick 里还排着闹钟与闲置唤醒，
   * 那些都是「到点必须发」的事，不能被整理记忆拖慢。
   */
  sweep(s: Settings): void {
    if (!s.memory.enabled) return;
    if (this.signal?.aborted) return;

    const now = nowSec();

    const hours = s.memory.digest_interval_hours;
    // 0（或负数）表示不按时间触发，只靠攒条数。传 -1 让
    // "last_digest_at <= sinceSec" 恒为假——直接传 now 会让所有会话立即到点。
    const sinceSec = hours > 0 ? now - hours * 3600 : -1;
    const idleSec = Math.max(0, s.memory.digest_idle_min) * 60;

    let candidates;
    try {
      candidates = this.store.memory.dueSessions({
        sinceSec,
        forceMsgs: s.memory.digest_force_msgs,
        failureCutoff: now - FAILURE_COOLDOWN_SEC,
        limit: DIGEST_SWEEP * 3,
      });
    } catch (e) {
      this.log.warn('查询待摘要会话失败', { err: e });
      return;
    }

    let picked = 0;
    for (const c of candidates) {
      if (picked >= DIGEST_SWEEP) break;
      // 会话还在聊就不压：中途压会把一段对话切成两半，概述和事实都不完整。
      if (idleSec > 0 && now - c.updated_at < idleSec) continue;
      // 与 consider() 同一道闸（硬顶 + 每会话日上限）
      if (!this.withinQuota(c.session_id, s)) {
        // 硬顶撞了就没必要再看后面的会话了，整轮到此为止
        if (this.quotaUsed + this.pendingJobs() >= DIGEST_DAILY_HARD_CAP) break;
        continue;
      }
      if (this.enqueue(c.session_id, s)) picked++;
    }
  }

  /**
   * 立即整理一个会话（面板上的「立即整理」、以及测试）。
   *
   * 绕过 tick 的间隔与空闲判断，但保留「至少几条」与「Key 配了吗」这两道闸：
   * 手动点一次不该因为只聊了两句话就去调模型。
   */
  async digestNow(sessionID: string, s: Settings): Promise<DigestOutcome> {
    if (this.inflight.has(sessionID)) {
      return { ok: false, added: 0, summary: '', reason: 'busy' };
    }
    this.inflight.add(sessionID);
    try {
      return await this.run(sessionID, s);
    } finally {
      this.inflight.delete(sessionID);
    }
  }

  /** 正在排队的会话数，给面板/状态用。 */
  pendingJobs(): number {
    return this.queue.length + this.running;
  }

  // ---- 内部 ----

  private rememberName(sessionID: string, name: string): void {
    try {
      // 只是给面板显示用，写失败不影响任何逻辑
      this.store.db.run(
        `INSERT INTO memory_cursors (session_id, owner_name, updated_at) VALUES (?, ?, 0)
         ON CONFLICT(session_id) DO UPDATE SET owner_name = excluded.owner_name
         WHERE memory_cursors.owner_name = ''`,
        sessionID,
        name,
      );
    } catch {
      // 忽略
    }
  }

  /** 入队并尝试启动。返回是否真的排上了（已在跑/已在队列里的不重复排）。 */
  private enqueue(sessionID: string, s: Settings): boolean {
    if (this.inflight.has(sessionID)) return false;
    if (this.queue.some((j) => j.sessionID === sessionID)) return false;
    this.queue.push({ sessionID, settings: s });
    // 拆到微任务里：调用方（reply / tick）不该等摘要的数据库查询。
    setImmediate(() => this.pump());
    return true;
  }

  private pump(): void {
    if (this.signal?.aborted) {
      this.queue.length = 0;
      return;
    }
    while (this.running < DIGEST_CONCURRENCY && this.queue.length > 0) {
      const job = this.queue.shift();
      if (job === undefined) break;
      if (this.inflight.has(job.sessionID)) continue;
      this.inflight.add(job.sessionID);
      this.running++;
      void this.run(job.sessionID, job.settings)
        .catch((e: unknown) => {
          this.log.warn('整理记忆失败', { session: job.sessionID, err: e });
        })
        .finally(() => {
          this.inflight.delete(job.sessionID);
          this.running--;
          this.pump();
        });
    }
  }

  private llmConfig(s: Settings): LlmConfig {
    const model = s.memory.digest_model !== '' ? s.memory.digest_model : s.llm.model;
    return {
      baseURL: s.llm.base_url,
      apiKey: s.llm.api_key,
      model,
      // 低温：摘要要的是"照实写"，不是发挥
      temperature: 0.2,
      maxTokens: DIGEST_MAX_TOKENS,
      thinking: false,
      timeoutMs: DIGEST_TIMEOUT_MS,
    };
  }

  private async run(sessionID: string, s: Settings): Promise<DigestOutcome> {
    const cfg = this.llmConfig(s);
    // 没有 Key 就别发请求：LlmClient 会抛错，而这里能给出更准确的原因。
    if (cfg.apiKey === '' || cfg.model === '') {
      return { ok: false, added: 0, summary: '', reason: 'no_key' };
    }

    let batch: Message[];
    try {
      batch = this.store.memory.pendingBatch(sessionID, DIGEST_BATCH * DIGEST_MAX_BATCHES);
    } catch (e) {
      this.log.warn('读取待摘要消息失败', { session: sessionID, err: e });
      return { ok: false, added: 0, summary: '', reason: 'read_failed' };
    }
    if (batch.length < DIGEST_MIN_MSGS) {
      // 条数不够就原样返回，且**不动水位线**：这几条要留给下次一起压。
      return { ok: true, added: 0, summary: '' };
    }

    const sessionName = this.store.memory.sessionName(sessionID);
    const batches: Message[][] = [];
    for (let i = 0; i < batch.length; i += DIGEST_BATCH) {
      batches.push(batch.slice(i, i + DIGEST_BATCH));
    }

    const facts: DigestFact[] = [];
    const factKeys = new Set<string>();
    const summaries: string[] = [];
    let promptTokens = 0;
    let completionTokens = 0;

    for (const chunk of batches) {
      if (this.signal?.aborted) return { ok: false, added: 0, summary: '', reason: 'aborted' };

      const speakers = new Map<number, string>();
      for (const m of chunk) {
        if (m.role === 'user' && m.speaker_id > 0 && !speakers.has(m.speaker_id)) {
          speakers.set(m.speaker_id, m.speaker_name);
        }
      }

      let existing: import('../store').Memory[] = [];
      try {
        existing = this.store.memory.recall(
          [
            { scope: 'session', owner_id: sessionID },
            ...[...speakers.keys()].map((qq) => ({
              scope: 'user' as const,
              owner_id: String(qq),
            })),
          ],
          { limit: 20, minScore: 1 },
        );
      } catch {
        existing = [];
      }

      let prev: DaySummary[] = [];
      try {
        prev = this.store.memory.recentDays(sessionID, 2);
      } catch {
        prev = [];
      }

      let raw = '';
      try {
        const res = await this.llm.chat(
          cfg,
          buildDigestMessages({ messages: chunk, existingFacts: existing, prevSummaries: prev }),
          this.signal,
        );
        raw = res.content;
        promptTokens += res.usage.prompt_tokens;
        completionTokens += res.usage.completion_tokens;
      } catch (e) {
        // 传输失败：水位线原地不动，下次重试这一批。
        this.log.warn('摘要请求失败', { session: sessionID, err: e });
        this.noteFailure(sessionID);
        return { ok: false, added: 0, summary: '', reason: 'request_failed' };
      }

      const parsed = parseDigest(raw, { sessionID, sessionName, speakers });
      if (!parsed.ok) {
        this.log.warn('摘要输出无法解析', { session: sessionID, reason: parsed.reason });
        this.noteFailure(sessionID);
        return { ok: false, added: 0, summary: '', reason: parsed.reason };
      }

      if (parsed.summary !== '') summaries.push(parsed.summary);
      for (const f of parsed.facts) {
        const key = `${f.scope}|${f.owner_id}|${f.content}`;
        if (factKeys.has(key)) continue;
        factKeys.add(key);
        facts.push(f);
      }
    }

    // 多批时要合并概述，否则一次摘要会留下两行"当天概述"。
    // 单批是常态（一次最多 60 条），走不到这里。
    //
    // 拼接必须带分隔：中文句子之间没有空格，直接 join('') 会让上一段的结尾
    // 和下一段的开头粘成一句读不通的话（合并请求失败时就是这个兜底在用）。
    let summary = summaries.join('\n');
    if (summaries.length > 1) {
      try {
        const res = await this.llm.chat(cfg, buildMergeMessages(summaries), this.signal);
        const merged = res.content.trim().slice(0, 400);
        if (merged !== '') summary = merged;
        promptTokens += res.usage.prompt_tokens;
        completionTokens += res.usage.completion_tokens;
      } catch (e) {
        // 合并失败不算失败：用拼接版也能用，总比丢掉整天强
        this.log.warn('合并概述失败，改用拼接', { session: sessionID, err: e });
      }
    }

    const now = nowSec();
    const today = localDay(new Date(now * 1000));
    const first = batch[0];
    const last = batch[batch.length - 1];
    if (first === undefined || last === undefined) {
      return { ok: true, added: 0, summary: '' };
    }
    const startSec = Math.floor(first.created_at.getTime() / 1000);
    const endSec = Math.floor(last.created_at.getTime() / 1000);
    const msgCount = batch.length;
    const tokens = estimateTokens(summary);

    try {
      this.store.db.tx(() => {
        if (summary !== '') {
          this.store.memory.saveDay({
            session_id: sessionID,
            day: today,
            period_start: startSec,
            period_end: endSec,
            msg_count: msgCount,
            content: summary,
            tokens,
          });
        }
        for (const f of facts) this.store.memory.add(f);
        this.store.memory.advance(sessionID, last.id, sessionName, now, today);
      });
    } catch (e) {
      this.log.error('写入记忆失败', { session: sessionID, err: e });
      this.noteFailure(sessionID);
      return { ok: false, added: 0, summary: '', reason: 'write_failed' };
    }

    this.quotaUsed++;
    try {
      // 摘要也是真金白银的 token，不记进来用量页就对不上账。
      const usagePrompt = promptTokens > 0 ? promptTokens : estimateTokens(summary);
      this.store.usage.record(cfg.model, usagePrompt, completionTokens, isPeak());
    } catch (e) {
      this.log.warn('记录摘要用量失败', { err: e });
    }

    this.log.info('已整理记忆', {
      session: sessionID,
      messages: msgCount,
      facts: facts.length,
      summary_tokens: tokens,
    });

    return { ok: true, added: facts.length, summary };
  }

  private noteFailure(sessionID: string): void {
    try {
      this.store.memory.noteFailure(sessionID, nowSec());
    } catch {
      // 记录失败本身不该再抛
    }
  }
}
