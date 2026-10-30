// 结构化日志：同时写标准输出与面板 hub。
//
// 对齐 Go 版的 slog 行为：
//   - 标准输出受 level 过滤
//   - hub 不受 level 过滤（Go 的 hubHandler.Enabled 恒返回 true），
//     所以面板能看到 debug 日志，即使 level 配成 warn
import type { LogHub, LogLine } from './hub';
import { rfc3339 } from '../util/time';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };
const LABEL: Record<LogLevel, string> = {
  debug: 'DEBUG',
  info: 'INFO',
  warn: 'WARN',
  error: 'ERROR',
};

export interface LoggerOptions {
  level: LogLevel;
  format: 'text' | 'json';
  hub?: LogHub;
}

/** slog 的 text handler 会在值含空格等字符时加引号，这里做等价处理。 */
function quoteIfNeeded(v: string): string {
  return /[\s"'=]/.test(v) || v === '' ? JSON.stringify(v) : v;
}

/**
 * 把错误展开成一行可读文本：消息 + 位置 + 原因链。
 *
 * 原来只取 e.message。对 Node 的网络错误来说，message 往往只有一句
 * "fetch failed"，真正的原因（ECONNREFUSED / 证书过期 / DNS 失败）在 cause 里，
 * 出错位置在 stack 里——少这两样，日志基本等于没写。
 * stack 截断到 500 字：完整堆栈会让一条日志占满整屏，也撑爆面板 hub。
 */
function describeError(e: Error): string {
  const base = typeof e.stack === 'string' && e.stack !== '' ? e.stack : e.message;
  let out = base.length > 500 ? `${base.slice(0, 500)}…` : base;

  let cause: unknown = (e as { cause?: unknown }).cause;
  for (let depth = 0; cause !== undefined && cause !== null && depth < 3; depth++) {
    if (cause instanceof Error) {
      out += ` <- ${cause.message === '' ? cause.name : cause.message}`;
      cause = (cause as { cause?: unknown }).cause;
    } else {
      out += ` <- ${String(cause)}`;
      break;
    }
  }
  return out;
}

export class Logger {
  private constructor(
    private readonly level: LogLevel,
    private readonly format: 'text' | 'json',
    private readonly hub: LogHub | undefined,
    private readonly bound: Record<string, string>,
  ) {}

  static create(opts: LoggerOptions): Logger {
    return new Logger(opts.level, opts.format, opts.hub, {});
  }

  /** 派生一个带固定属性的日志器（对应 slog 的 With）。 */
  with(attrs: Record<string, string>): Logger {
    return new Logger(this.level, this.format, this.hub, { ...this.bound, ...attrs });
  }

  debug(msg: string, attrs?: Record<string, unknown>): void {
    this.emit('debug', msg, attrs);
  }
  info(msg: string, attrs?: Record<string, unknown>): void {
    this.emit('info', msg, attrs);
  }
  warn(msg: string, attrs?: Record<string, unknown>): void {
    this.emit('warn', msg, attrs);
  }
  error(msg: string, attrs?: Record<string, unknown>): void {
    this.emit('error', msg, attrs);
  }

  private emit(level: LogLevel, msg: string, attrs?: Record<string, unknown>): void {
    const time = rfc3339(new Date());

    const flat: Record<string, string> = { ...this.bound };
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v === undefined || v === null) continue;
        flat[k] = v instanceof Error ? describeError(v) : String(v);
      }
    }

    // 面板：不受 level 限制，与 Go 版一致
    if (this.hub) {
      const line: LogLine = { time, level: LABEL[level], msg };
      if (Object.keys(flat).length > 0) line.attrs = flat;
      this.hub.push(line);
    }

    // 标准输出：受 level 限制
    if (ORDER[level] < ORDER[this.level]) return;

    if (this.format === 'json') {
      const obj: Record<string, unknown> = { time, level: LABEL[level], msg, ...flat };
      process.stdout.write(`${JSON.stringify(obj)}\n`);
      return;
    }

    let out = `time=${time} level=${LABEL[level]} msg=${quoteIfNeeded(msg)}`;
    for (const [k, v] of Object.entries(flat)) {
      out += ` ${k}=${quoteIfNeeded(v)}`;
    }
    process.stdout.write(`${out}\n`);
  }
}
