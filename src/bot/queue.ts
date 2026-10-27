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
    private readonly maxConcurrent = 3,
    private readonly maxDepth = 3,
  ) {}

  /**
   * 提交一个任务。返回 false 表示该会话排队已满，任务被丢弃。
   *
   * 丢弃而不是无限排队，是为了在消息洪峰时保护这台 1 核机器：
   * 排队越久回复越滞后，用户早就聊到别的话题了，
   * 迟到的回复比不回复更糟。
   */
  submit(key: string, fn: () => Promise<void> | void): boolean {
    const cur = this.depth.get(key) ?? 0;
    if (cur >= this.maxDepth) return false;
    this.depth.set(key, cur + 1);

    const prev = this.chains.get(key) ?? Promise.resolve();
    // catch 吞掉异常：一个任务失败不能让整条链断掉，
    // 否则这个会话后面的消息永远不会被处理
    const next = prev.then(() => this.run(key, fn)).catch(() => undefined);
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
    const next = this.waiting.shift();
    if (next) next();
  }

  /** 某会话当前排队数。 */
  depthOf(key: string): number {
    return this.depth.get(key) ?? 0;
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
