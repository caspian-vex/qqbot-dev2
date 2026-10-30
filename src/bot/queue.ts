// 消息去重、并发队列、冷却窗口。
//
// 这三样都是"看起来可以省、省了就会出丑"的东西，
// 所以放在一起，注释里写清楚每一样挡住的是什么故障。

/**
 * 消息去重。
 *
 * 为什么需要：协议端在断线重连、或者多个客户端同时订阅时，
 * 同一条消息可能被投递多次。不去重的话机器人会重复回复同一句话，
 * 在群里非常尴尬。
 */
export class Dedupe {
  private readonly seen = new Map<number, number>();
  private lastSweep = Date.now();

  constructor(private readonly ttlMs = 5 * 60_000) {}

  /** 返回 true 表示这条消息之前处理过；第一次见到会登记并返回 false。 */
  seenBefore(messageId: number): boolean {
    if (messageId === 0) return false;

    const now = Date.now();
    if (this.seen.has(messageId)) return true;
    this.seen.set(messageId, now);

    // 顺带做一次惰性清理，避免 map 无限增长。每 5 分钟最多一次，成本可控。
    if (now - this.lastSweep > 5 * 60_000) {
      this.lastSweep = now;
      for (const [id, t] of this.seen) {
        if (now - t > this.ttlMs) this.seen.delete(id);
      }
    }
    return false;
  }

  get size(): number {
    return this.seen.size;
  }
}

/**
 * 「同一会话串行、跨会话并发」的执行模型。
 *
 * 为什么同一会话必须串行：上下文是按消息顺序追加的。
 * 两条消息并发处理时写入历史的顺序会错乱，
 * 模型看到的对话就成了"回答在提问之前"。
 *
 * 实现上用「每个会话一条 Promise 链」而不是简单的计数：
 * 只计数只能限制排队长度，两条同会话任务照样能同时跑起来。
 * 链式实现才真正保证先后顺序。
 */
export class TaskQueue {
  private running = 0;
  private readonly depth = new Map<string, number>();
  private readonly chains = new Map<string, Promise<void>>();
  private readonly waiting: (() => void)[] = [];

  constructor(
    private maxConcurrent = 3,
    private readonly maxDepth = 3,
    /**
     * 任务抛错时的回调。
     *
     * 不给的话链只能 `.catch(() => undefined)`——那是必要的（一个任务失败
     * 不能让整条链断掉），但静默到连日志都没有就过头了：数据库写失败时
     * 用户看到的是"机器人不理我"，面板统计里这条消息不存在，日志一片空白。
     */
    private readonly onError?: (key: string, err: unknown) => void,
  ) {}

  /**
   * 调整跨会话并发上限（面板的「最大并发会话」）。
   *
   * 上限调大时要立刻把等待中的任务放进来，否则新上限要等下一次
   * release 才生效——用户改完设置会以为没生效。
   * 调小时不打断在跑的任务，只是后续不再放新的进来。
   */
  setConcurrency(n: number): void {
    const v = Number.isFinite(n) ? Math.max(1, Math.floor(n)) : 1;
    if (v === this.maxConcurrent) return;
    this.maxConcurrent = v;
    this.drain();
  }

  /**
   * 提交一个任务。返回 false 表示该会话排队已满，任务被丢弃。
   *
   * 丢弃而不是无限排队，是为了在消息洪峰时保护这台 1 核机器：
   * 排队越久回复越滞后，用户早就聊到别的话题了，
   * 迟到的回复比不回复更糟。
   */
  /**
   * 这个会话还能不能再排一个任务。
   *
   * 给"到点必须发"的调用方（定时消息）在不丢弃任务的前提下先问一句：
   * 先 submit 再改状态会在排队超过一个 tick 时重复发送，先改状态再 submit
   * 又会在队列满时永久丢失，只有"先确认有空位"两头都能保住。
   */
  accepts(key: string): boolean {
    return (this.depth.get(key) ?? 0) < this.maxDepth;
  }

  submit(key: string, fn: () => Promise<void> | void): boolean {
    const cur = this.depth.get(key) ?? 0;
    if (cur >= this.maxDepth) return false;
    this.depth.set(key, cur + 1);

    const prev = this.chains.get(key) ?? Promise.resolve();
    // catch 吞掉异常：一个任务失败不能让整条链断掉，
    // 否则这个会话后面的消息永远不会被处理。但要留一条日志，
    // 否则"消息静默消失"这种故障永远查不到原因。
    const next = prev
      .then(() => this.run(key, fn))
      .catch((e: unknown) => {
        this.onError?.(key, e);
      });
    this.chains.set(key, next);

    void next.finally(() => {
      const n = (this.depth.get(key) ?? 1) - 1;
      if (n <= 0) {
        this.depth.delete(key);
        this.chains.delete(key);
      } else {
        this.depth.set(key, n);
      }
    });

    return true;
  }

  private async run(key: string, fn: () => Promise<void> | void): Promise<void> {
    void key;
    await this.acquire();
    try {
      await fn();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.running < this.maxConcurrent) {
      this.running++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.waiting.push(() => {
        this.running++;
        resolve();
      });
    });
  }

  private release(): void {
    this.running--;
    this.drain();
  }

  /**
   * 在并发上限允许的范围内唤醒等待者。
   *
   * 用 while 而不是只唤醒一个：上限被调大（或一次 release 后空出多个槽）时
   * 应该把空位一次填满，否则并发度会永远比设置值低。
   */
  private drain(): void {
    while (this.running < this.maxConcurrent && this.waiting.length > 0) {
      const next = this.waiting.shift();
      if (!next) break;
      next();
    }
  }

  /** 某会话当前排队数。 */
  depthOf(key: string): number {
    return this.depth.get(key) ?? 0;
  }

  /** 当前跨会话并发上限（诊断与测试用）。 */
  get concurrency(): number {
    return this.maxConcurrent;
  }
}

/** 记录每个会话最近一次回复的时间，用于限流。 */
export class Cooldown {
  private readonly last = new Map<string, number>();

  /** 判断是否已过冷却期。通过时会顺带记录当前时间。 */
  allow(key: string, windowMs: number): boolean {
    if (windowMs <= 0) return true;
    const now = Date.now();
    const t = this.last.get(key);
    if (t !== undefined && now - t < windowMs) return false;
    this.last.set(key, now);
    return true;
  }

  /** 只查询不更新，返回剩余毫秒（0 表示已过冷却）。 */
  peek(key: string, windowMs: number): number {
    const t = this.last.get(key);
    if (t === undefined) return 0;
    const remain = windowMs - (Date.now() - t);
    return remain > 0 ? remain : 0;
  }
}
