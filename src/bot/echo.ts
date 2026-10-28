// 回声式跟进的纯逻辑：延迟采样、触发闸门、内部指令。
//
// 单独一个文件而不是塞进 engine.ts：这几样都是"改一个数、行为全变"的
// 策略点，抽成可注入 rand 的纯函数才能在测试里把概率钉死成 0 或 1。
import type { ProactiveSettings } from '../store/types';

/**
 * 喂给模型的临时指令（以 user 角色追加，但不落库）。
 *
 * 为什么是"指令"而不是一条普通用户消息：跟进不是回复，
 * 历史里不该多出一条谁都没说过的"用户消息"。
 * 关键设计是给模型闭嘴的权利——没有自然可说的内容就输出空，
 * 引擎把空当作正常放弃，而不是错误。
 */
export const ECHO_INSTRUCTION = [
  '（内部指令，用户看不到这段话）',
  '刚才你回复了对方。现在过去了一小会儿，',
  '如果你自然地想起了什么相关的小事，或者想顺着刚才的话题',
  '抛出一个具体的小问题，就只输出那句要直接发送的话。',
  '要求：一句话，口语化；不要说"在吗""在干嘛"这类没有信息量的开场；',
  '如果没有自然想说的内容，只输出一个空字符串。',
].join('');

/**
 * 采样跟进延迟（毫秒），在 [min, max] 内均匀取值。
 *
 * 为什么不用固定值：固定 60 秒是机器特征，均匀抖动足够伪装。
 * max < min 时（面板校验会拦，但旧数据拦不住）退化为 min。
 */
export function echoDelayMs(s: ProactiveSettings, rand: () => number = Math.random): number {
  const min = Math.max(0, s.echo_min_sec);
  const max = Math.max(min, s.echo_max_sec);
  return Math.round((min + rand() * (max - min)) * 1000);
}

/** 闸门的输入状态：由引擎从自己的计数器与冷却表里取。 */
export interface EchoGateState {
  /** 今天已经发过的跟进条数。 */
  sentToday: number;
  /** 距该会话上次跟进是否已过冷却。 */
  cooldownOk: boolean;
}

/**
 * 判断这次回复后要不要排一个跟进。
 *
 * 顺序刻意从硬到软：开关 → 日限额 → 会话冷却 → 概率。
 * 前三样是硬闸，不过就是不过；概率放最后，
 * 这样闸门被拦时不会白白消耗一次"骰子"。
 */
export function shouldEcho(
  s: ProactiveSettings,
  st: EchoGateState,
  rand: () => number = Math.random,
): boolean {
  if (!s.echo_enabled) return false;
  if (s.echo_daily_limit <= 0 || st.sentToday >= s.echo_daily_limit) return false;
  if (!st.cooldownOk) return false;
  return rand() < s.echo_rate;
}
