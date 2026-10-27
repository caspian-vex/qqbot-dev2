// 会话上下文窗口管理。
//
// 目标是在固定 token 预算内尽可能保留最近、最相关的对话，
// 既不让模型"失忆"，也不让 token 成本失控。
import { estimateTokens, type Message as LlmMessage } from '../llm/client';
import type { Store } from '../store';
import type { ContextSettings } from '../store/types';

export class Manager {
  constructor(private readonly store: Store) {}

  /**
   * 组装一次请求的消息列表。
   *
   * 策略：
   *   1. 取最近 maxTurns 轮（一轮 = 用户 + 助手，所以取 maxTurns*2 条）
   *   2. 从最新往回累加，直到逼近 token 预算为止
   *   3. 丢弃更早的整轮，保证 user/assistant 成对出现
   *
   * 为什么按"整轮"丢弃而不是逐条丢弃：如果上下文以 assistant 开头，
   * 部分模型会表现异常（把历史回复当成待续写内容）。
   */
  build(sessionID: string, cfg: ContextSettings, system: string, userText: string): LlmMessage[] {
    const maxTurns = cfg.max_turns > 0 ? cfg.max_turns : 10;
    const tokenBudget = cfg.token_budget > 0 ? cfg.token_budget : 3000;

    const history = this.store.sessions.recent(sessionID, maxTurns * 2);

    // 预算里先扣掉固定开销：系统提示、本轮用户消息、预期输出
    let budget = tokenBudget;
    budget -= estimateTokens(system);
    budget -= estimateTokens(userText);
    budget -= 512; // 预留输出空间
    if (budget < 0) budget = 0;

    // 从最新往回挑，凑够预算就停
    let start = history.length;
    let used = 0;
    for (let i = history.length - 1; i >= 0; i--) {
      const t = estimateTokens(history[i]!.content);
      // 第一条永远收下：否则预算极小时会把上下文清空，
      // 连"上一句说了什么"都丢了
      if (used + t > budget && start !== history.length) break;
      used += t;
      start = i;
    }

    // 修正到轮次边界：如果起始位置是 assistant，往前挪一条，让上下文从 user 开始
    if (start < history.length && history[start]!.role === 'assistant' && start > 0) {
      start--;
    }

    const msgs: LlmMessage[] = [{ role: 'system', content: system }];
    for (const h of history.slice(start)) {
      msgs.push({ role: h.role, content: h.content });
    }
    msgs.push({ role: 'user', content: userText });
    return msgs;
  }

  /** 把一轮对话写入历史。 */
  record(sessionID: string, role: string, content: string, tokens: number): void {
    this.store.sessions.append(sessionID, role, content, tokens);
  }

  /** 清空某会话的上下文。 */
  reset(sessionID: string): void {
    this.store.sessions.clear(sessionID);
  }

  /** 某会话的消息条数。 */
  stats(sessionID: string): number {
    return this.store.sessions.count(sessionID);
  }
}
