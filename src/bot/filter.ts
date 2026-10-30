// 触发判断：这条消息该不该回。
import type { Event } from '../onebot/types';
import { isGroup, isPrivate, mentions, plainText } from '../onebot/types';
import type { BotSettings } from '../store/types';
import type { Cooldown } from './queue';

/** 一次触发判断的结果。 */
export interface Decision {
  respond: boolean;
  /** 判断依据，便于在日志里排查"为什么没回"。 */
  reason: string;
  /** 去掉 @ 和唤醒词之后的用户正文。 */
  text: string;
  /**
   * 这条消息是明确冲着机器人来的（@、唤醒词或私聊）。
   * 被动接话的 direct 为 false，会被冷却规则限制。
   */
  direct: boolean;
}

/** 直接对话的最小间隔，防止有人连续 @ 刷屏。 */
const DIRECT_COOLDOWN_MS = 3_000;

function denied(reason: string): Decision {
  return { respond: false, reason, text: '', direct: false };
}

/**
 * 判断是否回复这条消息。
 *
 * 判断顺序刻意从"最确定不该回"到"最确定该回"：
 * 黑名单 → 私聊 → 群白名单 → @/唤醒词 → 被动概率。
 * 这个顺序保证白名单和黑名单永远优先于概率，不会出现
 * "在黑名单里但随机命中被回复"这种荒谬情况。
 */
export function decide(
  ev: Event,
  s: BotSettings,
  selfId: number,
  cool: Cooldown,
  rand: () => number = Math.random,
): Decision {
  const userId = ev.user_id ?? 0;

  if (s.blacklist_users.includes(userId)) return denied('用户在黑名单');

  if (isPrivate(ev)) {
    // 私聊用独立的冷却键。和群里共用 u:<qq> 的话，用户刚在群里 @ 过一次、
    // 紧接着私聊一句，私聊那条会被判成"冷却中"直接丢掉——不回复，正文也
    // 不进历史，模型后面完全不知道他说过这句。群内跨群共用 u:<qq> 是有意的：
    // 同一个人在多个群连着刷屏，本来就该一起限。
    if (!cool.allow(`p:${userId}`, DIRECT_COOLDOWN_MS)) return denied('私聊冷却中');
    return { respond: true, reason: '私聊', text: plainText(ev), direct: true };
  }

  if (!isGroup(ev)) return denied('非消息事件');

  const groupId = ev.group_id ?? 0;

  // 群白名单非空时，只处理白名单内的群
  if (s.whitelist_groups.length > 0 && !s.whitelist_groups.includes(groupId)) {
    return denied('群不在白名单');
  }

  const text = plainText(ev);

  // @ 机器人
  if (selfId !== 0 && mentions(ev, selfId)) {
    if (!cool.allow(`u:${userId}`, DIRECT_COOLDOWN_MS)) return denied('用户冷却中');
    return {
      respond: true,
      reason: '被@',
      text: stripWakeWords(text, s.wake_words),
      direct: true,
    };
  }

  // 唤醒词
  const hit = matchWakeWord(text, s.wake_words);
  if (hit.matched) {
    if (!cool.allow(`u:${userId}`, DIRECT_COOLDOWN_MS)) return denied('用户冷却中');
    return { respond: true, reason: '命中唤醒词', text: hit.rest, direct: true };
  }

  // 被动接话：按概率 + 群冷却
  if (s.passive_rate <= 0) return denied('被动接话已关闭');
  if (text.trim() === '') return denied('无可读文本');
  if (rand() >= s.passive_rate) return denied('未命中被动概率');

  if (!cool.allow(`g:${groupId}`, s.group_cooldown_sec * 1000)) return denied('群冷却中');

  return { respond: true, reason: '被动接话', text, direct: false };
}

/** 检查文本是否以某个唤醒词开头（允许前面有空白）。 */
export function matchWakeWord(
  text: string,
  words: string[],
): { matched: boolean; rest: string } {
  const t = text.trim();
  for (const raw of words) {
    const w = raw.trim();
    if (w === '') continue;
    if (t.startsWith(w)) return { matched: true, rest: t.slice(w.length).trim() };
  }
  return { matched: false, rest: text };
}

/** 去掉文本中出现的唤醒词。 */
export function stripWakeWords(text: string, words: string[]): string {
  let out = text.trim();
  for (const raw of words) {
    const w = raw.trim();
    if (w === '') continue;
    out = out.split(w).join('');
  }
  return out.trim();
}
