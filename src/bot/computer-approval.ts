// 待批准队列：模型要在这台机器上动东西之前，先申请主人点头。
//
// 为什么放在内存里而不是建一张表：
//   待批准是「此刻有人在等一个回答」的状态，不是业务数据。进程重启之后
//   那次执行早就不存在了，把记录留在库里只会让面板显示一堆批不了的僵尸条目，
//   点「批准」也唤不醒任何东西。
// 为什么阻塞而不是「先回一句、等批准了再发第二条消息」：
//   后者要引入会话状态机、补发消息、跨重启恢复，代价比收益大得多。阻塞
//   90 秒换一个「模型能接着用命令结果继续推理」的简单模型，是划算的。
//
// 唯一的副作用要说清楚：等待期间这个会话的队列槽位是被占着的（见 TaskQueue），
// 所以上限设得保守——同一时刻最多 4 条待批准，超了直接拒。
import { randomBytes } from 'node:crypto';
import type { Logger } from '../log/logger';

export type ApprovalDecision = 'approved' | 'denied' | 'timeout' | 'cancelled';

/** 申请内容。session/tool/summary 都是给人看的，面板上原样展示。 */
export interface ApprovalInput {
  /** 哪个会话触发的，'group:123' / 'private:456'。 */
  session: string;
  kind: string;
  target: number;
  /** 触发这次调用的 QQ。 */
  user: number;
  tool: string;
  /** 一行摘要，面板上第一眼看到的东西。 */
  summary: string;
  /** 参数原文（可能多行）。面板必须原样显示，概括会漏掉走私进去的第二步命令。 */
  detail: string;
}

export interface ApprovalRequest extends ApprovalInput {
  id: string;
  createdAt: number;
  expiresAt: number;
}

export interface PendingItem extends ApprovalRequest {
  /** 还剩多少毫秒到期，前端直接拿来显示倒计时。 */
  remainMs: number;
}

/** 同时最多挂几条待批准。1 核机器上再多也没人能同时点。 */
export const APPROVAL_MAX_PENDING = 4;

/** 处理过的 id 保留多久：用来区分「本来就没这条」(404) 与「刚过期/刚点过」(410)。 */
const SETTLED_TTL_MS = 5 * 60_000;

interface Entry {
  req: ApprovalRequest;
  finish: (d: ApprovalDecision) => void;
}

export class ApprovalQueue {
  private readonly pending = new Map<string, Entry>();
  private readonly settledAt = new Map<string, number>();

  constructor(private readonly log?: Logger) {}

  get size(): number {
    return this.pending.size;
  }

  /**
   * 登记一条申请并等结果。
   *
   * 队列满时抛错而不是排队：让模型立刻知道「这次别等了」，比挂 90 秒更强。
   * 调用方（computer.ts）会把异常翻成一句中文回灌给模型。
   */
  async ask(input: ApprovalInput, opt: { timeoutMs: number; signal?: AbortSignal }): Promise<ApprovalDecision> {
    if (this.pending.size >= APPROVAL_MAX_PENDING) {
      throw new Error('待批准的操作已经排了几条了，稍后再试');
    }
    // 已经中止（进程在退出）就别再登记，否则又是一条没人能批的僵尸
    if (opt.signal?.aborted === true) return 'cancelled';

    const id = randomBytes(4).toString('hex');
    const now = Date.now();
    const req: ApprovalRequest = {
      ...input,
      id,
      createdAt: now,
      expiresAt: now + Math.max(1, Math.floor(opt.timeoutMs)),
    };

    return await new Promise<ApprovalDecision>((resolve) => {
      let closed = false;

      const cleanup = (): void => {
        this.pending.delete(id);
        clearTimeout(timer);
        opt.signal?.removeEventListener('abort', onAbort);
      };
      const finish = (d: ApprovalDecision): void => {
        if (closed) return;
        closed = true;
        cleanup();
        this.settledAt.set(id, Date.now());
        this.log?.debug('电脑操作审批结束', { id, tool: req.tool, decision: d });
        resolve(d);
      };

      const timer = setTimeout(() => finish('timeout'), req.expiresAt - now);
      const onAbort = (): void => finish('cancelled');
      opt.signal?.addEventListener('abort', onAbort, { once: true });

      this.pending.set(id, { req, finish });
      this.log?.info('等待电脑操作批准', { id, tool: req.tool, session: req.session, expire_in: `${opt.timeoutMs}ms` });
    });
  }

  /** 面板轮询用。顺带清理过期的 settled 记录。 */
  list(): PendingItem[] {
    this.pruneSettled();
    const now = Date.now();
    return [...this.pending.values()].map((e) => ({
      ...e.req,
      remainMs: Math.max(0, e.req.expiresAt - now),
    }));
  }

  /**
   * 面板点了批准/拒绝。
   *
   * 三种返回值分别对应三种 HTTP 语义：处理成功、曾经存在但已经结束（410）、
   * 从来没有过这条（404）。分不清就会出现「点了一个早就不存在的东西，
   * 界面却提示已批准」。
   */
  decide(id: string, approve: boolean): 'ok' | 'expired' | 'unknown' {
    this.pruneSettled();
    const entry = this.pending.get(id);
    if (entry) {
      entry.finish(approve ? 'approved' : 'denied');
      return 'ok';
    }
    return this.settledAt.has(id) ? 'expired' : 'unknown';
  }

  /** 进程退出时把还在等的都收掉，不留悬挂的定时器。 */
  cancelAll(): void {
    for (const e of [...this.pending.values()]) e.finish('cancelled');
  }

  private pruneSettled(): void {
    const deadline = Date.now() - SETTLED_TTL_MS;
    for (const [id, at] of this.settledAt) {
      if (at < deadline) this.settledAt.delete(id);
    }
  }
}
