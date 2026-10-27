// 面板可见日志的环形缓冲与广播。
//
// 为什么不直接读 docker logs：面板跑在容器内，读不到宿主机日志；
// 通过 docker.sock 读又需要挂载 socket（安全上不可接受）。
// 所以让进程内日志直接进 hub，面板用 SSE 实时展示。

/** 一条面板可见的日志。字段名与 Go 版 LogLine 的 json tag 一致。 */
export interface LogLine {
  time: string;
  level: string;
  msg: string;
  attrs?: Record<string, string>;
  source?: string;
}

export type LogSubscriber = (line: LogLine) => void;

/**
 * 环形缓冲 + 订阅广播。
 *
 * 慢订阅者直接丢弃：日志写入绝不能被某个卡住的浏览器拖住。
 * 这是 Go 版「channel 满就丢」的等价实现。
 */
export class LogHub {
  private readonly buf: LogLine[] = [];
  private readonly subs = new Set<LogSubscriber>();
  private readonly max: number;

  constructor(max = 500) {
    this.max = max > 0 ? max : 500;
  }

  /** 写入一条并广播。 */
  push(line: LogLine): void {
    if (this.buf.length >= this.max) {
      this.buf.shift();
    }
    this.buf.push(line);
    for (const fn of this.subs) {
      try {
        fn(line);
      } catch {
        // 订阅者自身出错不应影响日志写入
      }
    }
  }

  /** 返回最近 n 条（时间正序）。 */
  recent(n: number): LogLine[] {
    const take = n <= 0 || n > this.buf.length ? this.buf.length : n;
    return this.buf.slice(this.buf.length - take);
  }

  /** 订阅新日志，返回取消订阅函数。 */
  subscribe(fn: LogSubscriber): () => void {
    this.subs.add(fn);
    return () => {
      this.subs.delete(fn);
    };
  }

  /** 当前订阅者数量（诊断用）。 */
  get subscriberCount(): number {
    return this.subs.size;
  }
}
