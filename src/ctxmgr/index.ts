// 会话上下文窗口管理。
//
// 目标是在固定 token 预算内尽可能保留最近、最相关的对话，
// 既不让模型"失忆"，也不让 token 成本失控。
import {
  contentTokens,
  estimateTokens,
  withImages,
  type ContentPart,
  type Message as LlmMessage,
} from '../llm/client';
import type { Store } from '../store';
import type { ContextSettings } from '../store/types';

export class Manager {
  constructor(private readonly store: Store) {}

  /**
   * 组装一次请求的消息列表。
   *
   * 策略：
   *   1. 取最近 maxTurns 轮（一轮 = 用户 + 助手，所以取 maxTurns*2 条）；0 表示不带历史
   *   2. 从最新往回累加，直到逼近 token 预算为止
   *   3. 丢弃更早的整轮，保证 user/assistant 成对出现
   *
   * 为什么按"整轮"丢弃而不是逐条丢弃：如果上下文以 assistant 开头，
   * 部分模型会表现异常（把历史回复当成待续写内容）。
   *
   * images 是本次用户消息附带的图片块：历史的旧图不会重发（库里只存文字），
   * 只有当前这一轮会带图，所以预算要先把它扣掉。
   */
  build(
    sessionID: string,
    cfg: ContextSettings,
    system: string,
    userText: string,
    images: ContentPart[] = [],
  ): LlmMessage[] {
    // max_turns = 0 是面板上的合法值，含义是「不带历史」。
    // 这里不能套 "> 0 ? x : 默认值" 的写法——那会把 0 悄悄变成 10 轮，
    // 用户关掉上下文后机器人还在接着几十条前的对话往下说。
    const rawTurns = Number.isFinite(cfg.max_turns) ? cfg.max_turns : 10;
    const maxTurns = Math.max(0, Math.floor(rawTurns));
    const tokenBudget = cfg.token_budget > 0 ? cfg.token_budget : 3000;

    const history = maxTurns === 0 ? [] : this.store.sessions.recent(sessionID, maxTurns * 2);

    const userContent = withImages(userText, images);

    // 预算里先扣掉固定开销：系统提示、本轮用户消息、预期输出
    let budget = tokenBudget;
    budget -= estimateTokens(system);
    budget -= contentTokens(userContent);
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
    // 用户消息里的图片块只属于这一轮，历史里的旧图不会重发
    msgs.push({ role: 'user', content: userContent });
    return msgs;
  }

  /**
   * 把一轮对话写入历史。
   *
   * speaker 只对用户消息有意义：群聊里几轮对话的 role 都是 'user'，
   * 摘要器要产出"关于某个人的事实"就必须知道是谁说的。
   */
  record(
    sessionID: string,
    role: string,
    content: string,
    tokens: number,
    speaker?: { id: number; name: string },
  ): void {
    this.store.sessions.append(sessionID, role, content, tokens, speaker);
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
