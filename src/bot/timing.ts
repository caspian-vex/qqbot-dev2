// 拟人节奏：把「模型返回了一段文本」变成「一个人把这段字打出来」。
//
// 为什么单独一个文件：这里每一个数都会直接改变"像不像人"，
// 而它们全是可注入 rand 的纯函数——测试里才能把分布钉死成
// "必然最快"和"必然最慢"两端，而不是靠跑一万次统计。
//
// 三件事分开算，因为它们的物理含义不同：
//   think  看到消息到开始打字（读一遍、想一下）——与回复长度无关
//   typing 把这段字打出来——与字数成正比，有上限
//   late   这一整条人在忙，过一会儿才回——偶发，且与内容无关
import type { TimingSettings } from '../store/types';

/**
 * 首段之前的总停顿上限（毫秒）。
 *
 * 不设上限的话，一条 200 字的长回复按 5 字/秒算要等 40 秒，
 * 对方早就以为机器人挂了。真人写长文也不是逐字现想，
 * 所以超过这个值就截断——宁可"打字太快"，也不要"像卡住了"。
 */
export const MAX_LEAD_MS = 12_000;

/** 单段打字耗时上限。段与段之间同理，长段不能无限等。 */
export const MAX_SEG_TYPING_MS = 8_000;

/**
 * 停顿分布的形状：80% 的采样落在区间前 40%。
 *
 * 这是对数正态的廉价近似（分段线性 CDF）。真实的人类停顿就是
 * 长尾的：多数几秒内开始打，偶尔要半分钟。均匀分布没有这个性质，
 * 采样出来会"每次都差不多慢"，反而比固定值更假。
 */
const FAST_SHARE = 0.8;
const FAST_SPAN = 0.4;

/** 段间"回车、瞄一眼、接着打"的手停区间（毫秒）。 */
const GAP_MIN_MS = 120;
const GAP_MAX_MS = 400;

/**
 * 在 [min, max] 内按长尾分布采样。
 *
 * rand() 只取一次：两个数会让人没法在测试里复现某个具体延迟，
 * 排查"为什么这条等了 9 秒"时少一个变量。
 */
export function weightedBetween(
  min: number,
  max: number,
  rand: () => number = Math.random,
): number {
  const lo = Math.max(0, min);
  const hi = Math.max(lo, max);
  const u = Math.min(0.999_999, Math.max(0, rand()));
  const x =
    u < FAST_SHARE
      ? (u / FAST_SHARE) * FAST_SPAN
      : FAST_SPAN + ((u - FAST_SHARE) / (1 - FAST_SHARE)) * (1 - FAST_SPAN);
  return Math.round(lo + (hi - lo) * x);
}

/**
 * 一段文字相当于"打了几个字"。
 *
 * 汉字/假名/全角算 1，ASCII 与半角算 0.5：英文一次一个键，
 * 但在中文输入法里 "hello" 是一串拼音加选字，实际不比两个汉字快。
 * 空白不计——没有人会为空格停顿。
 */
export function speakUnits(text: string): number {
  let n = 0;
  for (const ch of text) {
    if (/\s/.test(ch)) continue;
    const cp = ch.codePointAt(0) ?? 0;
    n += cp >= 0x2e80 ? 1 : 0.5;
  }
  return n;
}

/** 把一段文字折算成打字耗时（毫秒），带上限。 */
export function typingMs(text: string, cps: number): number {
  const speed = Math.max(0.5, cps);
  const raw = (speakUnits(text) / speed) * 1000;
  return Math.min(MAX_SEG_TYPING_MS, Math.round(raw));
}

/** 一次发言的节奏计划。由 planSpeech 产出，sendText 照着睡。 */
export interface SpeechPlan {
  /** 第一段之前的总停顿：思考 + 打第一段。 */
  leadMs: number;
  /** 第 i 段之前等多久（下标 0 恒为 0，已含在 leadMs 里）。 */
  gapsMs: number[];
  /** 整条迟到的毫秒数，0 表示不迟到。 */
  lateMs: number;
}

/**
 * 排一次发言的节奏。
 *
 * 注意 leadMs 里已经包含第一段的打字时间：真人不会先发一个空泡
 * 再补内容，第一个字出现之前的那段时间就是"在想 + 在打"。
 * 段间则只算"下一段打多久"，因为上一段已经发出去了，对方不觉得卡。
 */
export function planSpeech(
  segs: string[],
  t: TimingSettings,
  rand: () => number = Math.random,
): SpeechPlan {
  const gapsMs = segs.map(() => 0);
  if (!t.enabled || segs.length === 0) return { leadMs: 0, gapsMs, lateMs: 0 };

  const think = weightedBetween(t.think_min_ms, t.think_max_ms, rand);
  const first = typingMs(segs[0] ?? '', t.typing_cps);
  const leadMs = Math.min(MAX_LEAD_MS, think + first);

  for (let i = 1; i < segs.length; i++) {
    const type = typingMs(segs[i] ?? '', t.typing_cps);
    gapsMs[i] = Math.min(MAX_SEG_TYPING_MS, type + weightedBetween(GAP_MIN_MS, GAP_MAX_MS, rand));
  }

  return { leadMs, gapsMs, lateMs: lateDelayMs(t, rand) };
}

/**
 * 偶尔"人不在"：这一整条晚点再发。
 *
 * 与回声跟进不同，这里发的是**对方正在等的那条回复**，所以默认
 * 概率低、上限短（分钟级）。而且引擎那边一收到新消息就会把这段
 * 等待打断——对方追了一句，还让他等满五分钟是最糟的处理。
 */
export function lateDelayMs(t: TimingSettings, rand: () => number = Math.random): number {
  if (!t.enabled || t.late_rate <= 0) return 0;
  if (rand() >= t.late_rate) return 0;
  const min = Math.max(0, t.late_min_sec) * 1000;
  const max = Math.max(min, t.late_max_sec * 1000);
  return weightedBetween(min, max, rand);
}
