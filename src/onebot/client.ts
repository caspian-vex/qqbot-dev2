// OneBot v11 正向 WebSocket 客户端。
//
// 只依赖协议本身，不感知对端是 NapCat 还是别的协议端——
// 将来换协议端时上层框架零改动。
//
// 同一连接既收事件也发动作，用 echo 字段把响应和请求对上。
import WebSocket from 'ws';
import type { Logger } from '../log/logger';
import { rfc3339, ZERO_TIME } from '../util/time';
import type { BotStatus } from '../panel/ports';
import type { Event } from './types';

const DIAL_TIMEOUT = 10_000;
const WRITE_TIMEOUT = 10_000;
/** 超过这么久没收到任何报文（含 pong）就认为连接已死。 */
const READ_TIMEOUT = 60_000;
const PING_INTERVAL = 25_000;
const CALL_TIMEOUT = 20_000;
const MIN_BACKOFF = 1_000;
const MAX_BACKOFF = 30_000;
/** 连接稳定超过这么久才重置退避，避免"连上即断"时高频重试。 */
const STABLE_CONN_TIME = 30_000;

export interface Response {
  status: string;
  retcode: number;
  data?: unknown;
  message?: string;
  wording?: string;
  echo?: string;
}

interface Pending {
  action: string;
  resolve: (data: unknown) => void;
  reject: (e: Error) => void;
}

export type EventHandler = (event: Event) => void | Promise<void>;

/** 内部状态用 Date，对外（面板）转成 RFC3339 字符串。 */
interface InnerStatus {
  connected: boolean;
  self_id: number;
  nickname: string;
  connected_at: Date | null;
  last_event_at: Date | null;
  reconnects: number;
  last_error: string;
}

export class Client {
  private readonly log: Logger;
  private handler: EventHandler | null;

  private ws: WebSocket | null = null;
  private readonly pending = new Map<string, Pending>();
  private echoSeq = 0;

  private st: InnerStatus = {
    connected: false,
    self_id: 0,
    nickname: '',
    connected_at: null,
    last_event_at: null,
    reconnects: 0,
    last_error: '',
  };

  /** 最近一次收到任何报文的时刻，用于读超时判定。 */
  private lastSeen = 0;
  private watchdog: NodeJS.Timeout | null = null;
  private pingTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly url: string,
    private readonly token: string,
    log: Logger,
    handler?: EventHandler,
  ) {
    this.log = log.with({ component: 'onebot' });
    this.handler = handler ?? null;
  }

  /** 允许构造后再注入，避免与上层循环依赖。 */
  setHandler(h: EventHandler): void {
    this.handler = h;
  }

  status(): BotStatus {
    return {
      connected: this.st.connected,
      self_id: this.st.self_id,
      nickname: this.st.nickname,
      connected_at: this.st.connected_at ? rfc3339(this.st.connected_at) : ZERO_TIME,
      last_event_at: this.st.last_event_at ? rfc3339(this.st.last_event_at) : ZERO_TIME,
      reconnects: this.st.reconnects,
      last_error: this.st.last_error,
    };
  }

  // ---- 连接维持 ----

  /**
   * 持续维持连接，直到 signal 中止。
   *
   * 断线后指数退避重连（1s → 30s）；连接稳定超过 30 秒才重置退避，
   * 否则协议端"握手成功但立刻断开"时会把重试频率钉在最高档。
   */
  async run(signal: AbortSignal): Promise<void> {
    let backoff = MIN_BACKOFF;

    while (!signal.aborted) {
      const startedAt = Date.now();
      let err: Error | null = null;
      try {
        await this.serve(signal);
      } catch (e) {
        err = e instanceof Error ? e : new Error(String(e));
      }

      if (signal.aborted) return;

      if (err) {
        this.log.warn('连接断开', { err: err.message, retry_in: `${backoff}ms` });
        this.st.connected = false;
        this.st.last_error = err.message;
        this.st.reconnects++;
      }

      if (Date.now() - startedAt > STABLE_CONN_TIME) backoff = MIN_BACKOFF;

      await sleep(backoff, signal);
      if (signal.aborted) return;
      if (backoff < MAX_BACKOFF) backoff = Math.min(backoff * 2, MAX_BACKOFF);
    }
  }

  private async serve(signal: AbortSignal): Promise<void> {
    const ws = await this.dial(signal);
    this.ws = ws;
    this.pending.clear();
    this.st.connected = true;
    this.st.connected_at = new Date();
    this.st.last_error = '';
    this.log.info('已连接协议端', { url: this.url });

    this.lastSeen = Date.now();
    this.startPing();
    this.startWatchdog();

    try {
      await this.readLoop(ws, signal);
    } finally {
      this.stopTimers();
      this.ws = null;
      // 连接断了要立刻唤醒所有等待中的调用，否则每个调用都要白等到超时
      this.failPending();
    }
  }

  private dial(signal: AbortSignal): Promise<WebSocket> {
    return new Promise<WebSocket>((resolve, reject) => {
      const headers: Record<string, string> = {};
      if (this.token !== '') headers['Authorization'] = `Bearer ${this.token}`;

      const ws = new WebSocket(this.url, { headers, handshakeTimeout: DIAL_TIMEOUT });

      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error('拨号失败: 握手超时'));
      }, DIAL_TIMEOUT);

      const onAbort = (): void => {
        clearTimeout(timer);
        ws.terminate();
        reject(new Error('已取消'));
      };
      signal.addEventListener('abort', onAbort, { once: true });

      ws.once('open', () => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        resolve(ws);
      });

      ws.once('error', (e: Error) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        reject(new Error(`拨号失败: ${e.message}`));
      });

      ws.once('unexpected-response', (_req, res) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', onAbort);
        ws.terminate();
        reject(new Error(`握手失败 HTTP ${res.statusCode}`));
      });
    });
  }

  private readLoop(ws: WebSocket, signal: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const onAbort = (): void => {
        ws.terminate();
        resolve();
      };
      signal.addEventListener('abort', onAbort, { once: true });

      ws.on('message', (data: Buffer | string) => {
        this.lastSeen = Date.now();
        this.dispatch(typeof data === 'string' ? data : data.toString('utf8'));
      });

      ws.on('pong', () => {
        this.lastSeen = Date.now();
      });

      ws.on('close', (code: number, reason: Buffer) => {
        signal.removeEventListener('abort', onAbort);
        if (code === 1000 || code === 1001) {
          reject(new Error('协议端主动关闭连接'));
          return;
        }
        const why = reason.length > 0 ? ` ${reason.toString('utf8')}` : '';
        reject(new Error(`连接关闭 code=${code}${why}`));
      });

      ws.on('error', (e: Error) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      });
    });
  }

  private startPing(): void {
    this.pingTimer = setInterval(() => {
      const ws = this.ws;
      if (!ws) return;
      try {
        ws.ping();
      } catch {
        ws.terminate();
      }
    }, PING_INTERVAL);
    this.pingTimer.unref();
  }

  /**
   * 读超时看门狗。
   *
   * ws 没有 Go 那种 SetReadDeadline，靠 ping/pong 维持的 TCP 连接
   * 在对端进程被冻住时会一直挂着不报错。这里用"多久没收到任何报文"
   * 来判定死连接，行为上等价于 Go 的 60 秒读超时。
   */
  private startWatchdog(): void {
    this.watchdog = setInterval(() => {
      if (Date.now() - this.lastSeen <= READ_TIMEOUT) return;
      const ws = this.ws;
      if (ws) ws.terminate();
    }, 10_000);
    this.watchdog.unref();
  }

  private stopTimers(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
    if (this.watchdog) {
      clearInterval(this.watchdog);
      this.watchdog = null;
    }
  }

  // ---- 收发 ----

  /**
   * 区分「动作响应」与「事件上报」。
   *
   * 判据：有 echo 且没有 post_type → 响应；其余一律当事件。
   * 少数协议端会在事件里也带 echo，所以两个条件都要判。
   */
  private dispatch(text: string): void {
    let probe: { echo?: string; post_type?: string };
    try {
      probe = JSON.parse(text) as { echo?: string; post_type?: string };
    } catch {
      this.log.debug('收到无法解析的报文');
      return;
    }

    if (probe.echo && !probe.post_type) {
      const p = this.pending.get(probe.echo);
      if (p) {
        this.pending.delete(probe.echo);
        p.resolve(probe);
      }
      return;
    }

    let ev: Event;
    try {
      ev = JSON.parse(text) as Event;
    } catch {
      this.log.debug('解析事件失败');
      return;
    }
    ev.raw = ev as unknown as Record<string, unknown>;

    this.st.last_event_at = new Date();
    if (ev.self_id) this.st.self_id = ev.self_id;

    const h = this.handler;
    if (!h) return;
    // 处理函数在微任务里跑：一条慢消息不能卡住后续事件的分发
    void Promise.resolve()
      .then(() => h(ev))
      .catch((e: unknown) => {
        this.log.error('事件处理异常', { err: e });
      });
  }

  /**
   * 调用一个 OneBot 动作，返回 data 字段。
   *
   * 外层 signal 与内部 20 秒超时取先到者：面板给的 10 秒超时、
   * 引擎给的取消信号都能生效，同时不会因为调用方忘了传 signal 而永久挂住。
   */
  async call(action: string, params: Record<string, unknown> = {}, signal?: AbortSignal): Promise<unknown> {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error('尚未连接到协议端');
    }

    const echo = `q${++this.echoSeq}`;
    const timeout = AbortSignal.timeout(CALL_TIMEOUT);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

    // 调用方给的 signal 可能已经中止（进程正在退出、上层超时已到）。
    // AbortSignal.any 在这种情况下返回的就是一个已中止的信号，
    // 而给已中止的信号补监听器永远不会触发——不在这里拦一下，
    // 这个 promise 会一直挂着，pending 条目也要等到断线才被清掉。
    if (combined.aborted) throw new Error(`调用 ${action} 已取消`);

    const result = new Promise<unknown>((resolve, reject) => {
      this.pending.set(echo, { action, resolve, reject });
    });
    // 先挂一个空 catch：取消/超时可能发生在下面 send 完成之前，
    // 那时 result 还没有 await 的接收者，Node 会把它记成 unhandled rejection。
    // 真正的错误仍由 await result 抛出，这里只是别让进程先崩。
    void result.catch(() => undefined);

    const onAbort = (): void => {
      const p = this.pending.get(echo);
      if (!p) return;
      this.pending.delete(echo);
      p.reject(
        timeout.aborted ? new Error(`调用 ${action} 超时`) : new Error(`调用 ${action} 已取消`),
      );
    };
    combined.addEventListener('abort', onAbort, { once: true });

    try {
      const payload = JSON.stringify({ action, params, echo });
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('发送动作请求超时')), WRITE_TIMEOUT);
        ws.send(payload, (e?: Error) => {
          clearTimeout(t);
          if (e) reject(new Error(`发送动作请求失败: ${e.message}`));
          else resolve();
        });
      });

      const resp = (await result) as Response;
      if (resp.retcode !== 0) {
        const msg = resp.wording !== '' && resp.wording !== undefined ? resp.wording : (resp.message ?? '');
        throw new Error(`调用 ${action} 失败 retcode=${resp.retcode}: ${msg}`);
      }
      return resp.data;
    } finally {
      combined.removeEventListener('abort', onAbort);
      this.pending.delete(echo);
    }
  }

  /** 连接断开时唤醒所有等待者。 */
  private failPending(): void {
    const all = [...this.pending.values()];
    this.pending.clear();
    for (const p of all) {
      p.reject(new Error(`调用 ${p.action} 时连接中断`));
    }
  }

  /** 主动断开（退出时用）。 */
  close(): void {
    this.stopTimers();
    const ws = this.ws;
    this.ws = null;
    this.failPending();
    if (ws) {
      try {
        ws.close(1000);
      } catch {
        ws.terminate();
      }
    }
  }
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const t = setTimeout(() => {
      signal.removeEventListener('abort', onDone);
      resolve();
    }, ms);
    const onDone = (): void => {
      clearTimeout(t);
      resolve();
    };
    signal.addEventListener('abort', onDone, { once: true });
  });
}
