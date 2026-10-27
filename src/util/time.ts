// 与 Go 标准库行为对齐的时间/格式工具。
//
// 面板前端是原样复用的，所以服务端输出的时间与时长必须与 Go 版逐字一致，
// 否则前端解析会出问题（例如把 uptime 当数字处理、把时间当 Date 解析失败）。

/** Go 的零值 time.Time 序列化结果。未连接/未发生的事件用它表示「没有」。 */
export const ZERO_TIME = '0001-01-01T00:00:00Z';

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * 复刻 Go 的 time.Time JSON 序列化：RFC3339，带本地时区偏移，无小数秒。
 * 偏移为 0 时输出 "Z"（Go 的行为），否则输出 +08:00 这样的形式。
 */
export function rfc3339(d: Date | null | undefined): string {
  if (!d || Number.isNaN(d.getTime())) return ZERO_TIME;
  const offMin = -d.getTimezoneOffset();
  const base =
    `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}` +
    `T${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
  if (offMin === 0) return `${base}Z`;
  const sign = offMin > 0 ? '+' : '-';
  const abs = Math.abs(offMin);
  return `${base}${sign}${pad2(Math.floor(abs / 60))}:${pad2(abs % 60)}`;
}

/** Unix 秒 → Date。 */
export function fromUnix(sec: number): Date {
  return new Date(sec * 1000);
}

/** 当前 Unix 秒。 */
export function nowSec(): number {
  return Math.floor(Date.now() / 1000);
}

/**
 * 复刻 Go 的 time.Duration.String()。
 *
 * 调用方（uptime）在 Go 里是 time.Since(start).Round(time.Second).String()，
 * 所以只需要处理整秒的情况：
 *   0      -> "0s"
 *   5      -> "5s"
 *   60     -> "1m0s"
 *   90     -> "1m30s"
 *   3600   -> "1h0m0s"
 *   3723   -> "1h2m3s"
 */
export function formatGoDuration(ms: number): string {
  const neg = ms < 0;
  // Round(time.Second) 的等价实现：四舍五入到整秒
  let total = Math.round(Math.abs(ms) / 1000);
  if (total === 0) return '0s';

  const sec = total % 60;
  total = Math.floor(total / 60);
  const min = total % 60;
  total = Math.floor(total / 60);
  const hour = total;

  let out: string;
  if (hour > 0) out = `${hour}h${min}m${sec}s`;
  else if (min > 0) out = `${min}m${sec}s`;
  else out = `${sec}s`;

  return neg ? `-${out}` : out;
}

/** 本地日期 "YYYY-MM-DD"，对应 Go 的 time.Now().Format("2006-01-02")。 */
export function localDay(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

/**
 * 判断当前是否处于 DeepSeek 峰时（本地时区，周一至周五 9-12、14-18）。
 * 与原 Go 实现的 isPeak 一致。
 */
export function isPeak(now: Date = new Date()): boolean {
  const dow = now.getDay();
  if (dow === 0 || dow === 6) return false;
  const h = now.getHours();
  return (h >= 9 && h < 12) || (h >= 14 && h < 18);
}
