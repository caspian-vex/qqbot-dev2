// 召回裁剪：从候选里挑出真正要塞进 prompt 的那几条。
//
// 为什么需要这一步而不是"查出来全塞"：候选来自两个归属（本会话 + 当前
// 说话人），上限是 recall_facts*3 与 recall_days，加起来可能几百 token。
// system prompt 的预算要和聊天历史共用，塞多了会把真正的上下文挤出去——
// 那比"没记性"更糟。
import { estimateTokens } from '../llm/client';
import type { DaySummary, Memory } from '../store';
import { renderFact } from './prompt';

/** 两个标题 + 那句免责声明的固定开销，粗估即可，它只用于预算分配。 */
const BLOCK_OVERHEAD = 60;
/** 概述最多占预算的多少。剩下的留给事实——概述太长时事实先被挤掉更难接受。 */
const DAY_SHARE = 0.6;

export interface RecallPick {
  facts: Memory[];
  days: DaySummary[];
}

/**
 * 在 token 预算内挑概述与事实。
 *
 * 职责边界：facts 必须已按 score/updated_at 排好序（仓储的 recall 就是这么返回的），
 * days 必须已按时间倒序。这里只做「去重 + 预算裁剪」，不重新排序——
 * 排序规则只应该有一个实现。
 */
export function pickForPrompt(
  facts: Memory[],
  days: DaySummary[],
  cfg: { maxFacts: number; budget: number; minScore?: number },
): RecallPick {
  const budget = Math.max(0, Math.floor(cfg.budget));
  const maxFacts = Math.max(1, Math.floor(cfg.maxFacts));
  const minScore = Math.max(1, Math.min(5, Math.floor(cfg.minScore ?? 1)));

  let remaining = Math.max(0, budget - BLOCK_OVERHEAD);

  // 概述优先：它是"刚才在聊什么"，与这一轮的相关性最高。
  // 但仍然限制在 60% 以内，避免一份特别长的概述把"这人是谁"整个挤掉。
  const dayCap = Math.max(1, Math.floor(remaining * DAY_SHARE));
  const pickedDays: DaySummary[] = [];
  let dayUsed = 0;
  for (const d of days) {
    const cost = estimateTokens(`${d.day.slice(5)}：${d.content}`);
    // 第一条永远收下：空着比"塞一条略超预算的"更浪费——概述本身就是
    // 记忆存在的理由，为几十 token 把它丢掉不划算。
    if (pickedDays.length > 0 && dayUsed + cost > dayCap) break;
    dayUsed += cost;
    pickedDays.push(d);
  }
  remaining -= dayUsed;

  const pickedFacts: Memory[] = [];
  const seen = new Set<string>();
  let factUsed = 0;
  for (const m of facts) {
    if (pickedFacts.length >= maxFacts) break;
    if (m.score < minScore) continue;
    // 概述已经把预算吃穿了（一份超长概述），就没有事实的位置了。
    // 反过来硬塞会得到一个超出预算的 system，ctxmgr 只能把历史裁掉。
    if (remaining <= 0) break;
    // 私聊里同一件事可能在「用户」和「会话」两个归属下各存一份——
    // 内容归一化后相同就只留分数高的那条（仓储已排序，先到的就是高的）。
    const key = m.content.replace(/\s+/g, '');
    if (seen.has(key)) continue;
    const cost = estimateTokens(renderFact(m));
    if (factUsed + cost > remaining && pickedFacts.length > 0) break;
    factUsed += cost;
    seen.add(key);
    pickedFacts.push(m);
  }

  return { facts: pickedFacts, days: pickedDays };
}
