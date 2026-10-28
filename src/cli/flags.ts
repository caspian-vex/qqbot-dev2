// 命令行参数解析。
//
// 单独一个文件是为了可测：main.ts 在模块加载时就会执行 main()，
// 任何 import 它的测试都会被卷进真实启动流程，参数解析的边界情况
// （比如 --keep-totp 被当成带值参数）就永远测不到。

export interface Flags {
  config?: string;
  db?: string;
  keepTOTP?: boolean;
  help?: boolean;
}

/** 归一化 flag 名：去掉前导横线，忽略大小写与分隔符。 */
export function flagName(raw: string): string {
  return raw.replace(/^--?/, '').replace(/[-_]/g, '').toLowerCase();
}

/**
 * 布尔开关。用归一化后的名字匹配，所以 --keep-totp / -keepTOTP / --keep_totp
 * 都指向同一个开关（qqbotctl 的提示语写的是 --keep-totp）。
 */
export const BOOL_FLAGS = ['keepTOTP'] as const;
export type BoolFlag = (typeof BOOL_FLAGS)[number];

/**
 * 极简参数解析。
 *
 * 同时认 `--config x` 与 `-config x`：Go 的 flag 包用单横线，
 * 而用户手敲的时候习惯双横线。两种都接受能省掉一次报错。
 */
export function parseFlags(argv: string[]): Flags {
  const out: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i] ?? '';
    if (!raw.startsWith('-')) continue;
    const name = flagName(raw);
    if (name === 'help' || name === 'h') {
      out.help = true;
      continue;
    }
    // 布尔开关必须先判：否则 --keep-totp 会被当成「带值的参数」，
    // 把后面的参数当成它的值吃掉，开关本身还永远是 false。
    const bool: BoolFlag | undefined = BOOL_FLAGS.find((b) => flagName(b) === name);
    if (bool !== undefined) {
      out[bool] = true;
      continue;
    }
    const val = argv[i + 1];
    if (val === undefined) continue;
    i++;
    if (name === 'config') out.config = val;
    else if (name === 'db') out.db = val;
  }
  return out;
}
