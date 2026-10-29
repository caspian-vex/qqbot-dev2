// 回声式跟进的纯逻辑：延迟采样、触发闸门、内部指令、重复检测。
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
 *
 * 为什么必须把上一条原文引进来：跟进时上下文末尾就是模型自己刚发的
 * 那句，中间没有新输入。不告诉它"你刚说过什么"，它唯一能做的事就是
 * 把那句换个说法再问一遍——2026-10-29 线上就是这样连发了两条
 * 「游戏现在跑顺点了没」/「调过画质之后有没有好点呀」。
 *
 * 注意：开头的「（内部指令」是测试识别的协议（test/echo.test.ts 与
 * test/engine.test.ts 都靠它区分"正常回复"与"跟进"两跳），不要改。
 */
export function echoInstruction(lastReply: string): string {
  const quote = lastReply.trim();
  // 纯发图没打字时没有可引用的上一句，给一版不带引文的措辞。
  const head =
    quote === ''
      ? '（内部指令，用户看不到这段话）你刚才只发了图片，没有打字。'
      : `（内部指令，用户看不到这段话）你上一句已经发出去的是「${quote}」。`;

  return [
    head,
    '现在隔了一小会儿再补一句，这不是重新回答对方。',
    '规则：这句问过的问题不许换个说法再问，也不许把上一句换个说法重说；',
    '上一句没聊透，就把它补完整（给细节、给结论、给具体建议）；',
    '上一句已经说完了，就换一个相关的新方向。',
    '只输出要直接发送的一句口语，不要解释、不要加引号；',
    '没有值得补的内容，就只输出一个空字符串。',
  ].join('');
}

/** 句末语气词：这些收尾基本等于"把球抛给对方了"。 */
const AWAIT_TAIL = /[吗呢嘛么]$/;
/**
 * 「…了没 / …过没」是中文里最常见的无问号问句。
 * 用 [了过] 前缀把陈述句「还没」「也没有」排除掉。
 */
const AWAIT_MEI = /[了过]没(?:有)?$/;

/**
 * 上一条回复是不是已经在问对方问题（等于"在等回答"）。
 *
 * 用"任意位置含问号"而不是"以问号结尾"：颜文字里的问号
 * （「跑顺点了没（・ω・？」）就在字符串中间，按尾部判会漏。
 *
 * 已知缺口：放弃「去不去 / 是不是」这类 V 不 V 问句——判它需要动词表，
 * 误判的代价比漏判高。漏判的结果只是排了一次本该跳过的跟进，
 * 后面还有复读闸门与模型的闭嘴权兜着。
 */
export function isAwaitingAnswer(text: string): boolean {
  const t = text.trim();
  if (t === '') return false; // 没打字就没有"在问"
  if (t.includes('？') || t.includes('?')) return true;
  // 去掉尾部标点/空白后再判语气词，「好点了吗。」也要算
  const core = t.replace(/[\s。！!…~～.、，,）)]+$/u, '');
  return AWAIT_TAIL.test(core) || AWAIT_MEI.test(core);
}

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

/** 归一化：去掉标点/符号/空白并转小写，只留实义字符。 */
function norm(s: string): string {
  return s
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[\p{P}\p{S}\s]/gu, '');
}

/** 字符二元组集合。中文按字切二元组，比按空格分词更适合短句。 */
function bigrams(s: string): Set<string> {
  const out = new Set<string>();
  for (let i = 0; i + 1 < s.length; i++) out.add(s.slice(i, i + 2));
  return out;
}

/** 短于此长度只认"完全相同"：「行」「好呀」只有一个二元组，命中率天然是 1。 */
const MIN_DUP_LEN = 6;
/** 0.6 会漏掉"加个前后缀"的轻度改写，0.5 实测仍不会误伤正常短回复。 */
const DUP_JACCARD = 0.5;

/**
 * 跟进文本是不是把上一条原样重复（或只加了几个字）一遍。
 *
 * **它拦不住语义级重复**，这一点必须说清楚：线上那两句
 * 「游戏现在跑顺点了没」与「调过画质之后有没有好点呀」归一化后的
 * 二元组交集只有「游戏」一个，Jaccard ≈ 0.04，这个函数判为不重复。
 * 真正治本案的是时机闸门（isAwaitingAnswer）+ 指令里带上一条原文 +
 * FORMAT_RULES 里"不要重复自己"那条，不是这里的阈值。
 * 这里只负责拦住更蠢的一种失败：模型直接把上一句吐回来。
 */
export function repeatsLastReply(echo: string, lastReply: string): boolean {
  const a = norm(echo);
  const b = norm(lastReply);
  if (a === '' || b === '') return false;
  // 完全相同也算重复：上一句是"嗯"，这次又是"嗯"，就不该再发一遍
  if (a === b) return true;

  const short = a.length <= b.length ? a : b;
  const long = a.length <= b.length ? b : a;
  // 句子太短时二元组统计不可靠（2 字只有 1 个二元组），只认上面的完全相等
  if (short.length < MIN_DUP_LEN) return false;
  // 一个包含另一个（只是加了开头/结尾）
  if (long.includes(short) && short.length / long.length >= 0.5) return true;

  const A = bigrams(a);
  const B = bigrams(b);
  let inter = 0;
  for (const g of A) if (B.has(g)) inter++;
  return inter / (A.size + B.size - inter) >= DUP_JACCARD;
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
