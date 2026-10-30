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
 * 同时认 `--config x`、`-config x` 与 `--config=x`：Go 的 flag 包用单横线，
 * 用户手敲习惯双横线，而 systemd/脚本里又常见等号写法。三种都接受能省掉一次报错。
 */
export function parseFlags(argv: string[]): Flags {
  const out: Flags = {};
  for (let i = 0; i < argv.length; i++) {
    const raw = argv[i] ?? '';
    if (!raw.startsWith('-')) continue;

    // 先拆等号再认名字：不拆的话 flagName('--config=/x') 得到 'config=/x'，
    // 匹配不上任何分支，等号写法就静默失效了。
    const eq = raw.indexOf('=');
    const head = eq > 0 ? raw.slice(0, eq) : raw;
    const inline = eq > 0 ? raw.slice(eq + 1) : undefined;
    const name = flagName(head);

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

    // 只给已知的带值开关取值。不认识的开关**绝不能**顺手吃掉下一个 token：
    // `qqbot run --verbose --config /opt/qqbot/etc/qqbot.toml` 会把 --config
    // 当成 --verbose 的值，于是 config 为 undefined、静默回退到默认路径——
    // 机器起来后连的是另一份配置，排查起来毫无线索。
    if (name !== 'config' && name !== 'db') continue;

    const next = argv[i + 1];
    // 下一个 token 长得像开关就认为这个开关没给值（`--config --db /x` 是写错了，
    // 但不能因为写错一处把后面的 --db 也一起吞掉）。真要传以横线开头的路径，
    // 用 --config=./-weird-name 这种等号写法。
    const val = inline ?? (next !== undefined && !next.startsWith('-') ? next : undefined);
    if (val === undefined) continue;
    if (inline === undefined) i++;
    if (name === 'config') out.config = val;
    else out.db = val;
  }
  return out;
}
