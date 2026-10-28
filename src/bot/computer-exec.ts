// 本机执行层：跑一条命令、读一个文件、写一个文件、看一个目录。
//
// 这一层只做「怎么执行」，不做任何业务判断（该不该执行、要不要批准在这之上的
// computer.ts 里）。放在单独文件是为了它能被单元测试直接打——真起一个进程、
// 真写一个文件，比在引擎里隔着假 LLM 断言可靠得多。
//
// 三条硬约束来自部署环境（1 核 2G 的服务器、alpine 容器、非 root 的 node 用户）：
//   1. 输出必须边读边裁。`yes` 一条命令产生的行能把 768MB 的 cgroup 直接打爆，
//      所以不能先累加字符串再截断；
//   2. 超时后要杀「整棵进程树」。只 kill 直接子进程的话，`sh -c 'sleep 999 &'`
//      留下的孙进程会一直在 1 核上转；
//   3. 同一时刻只允许一条命令。1 核机器上并发跑两条命令，两条都变慢，
//      还容易把内存顶到 OOM——这台机器上 OOM 杀的是整个 qqbot 容器。
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { mkdir, open, readdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, normalize, resolve } from 'node:path';

/** 回给模型的输出上限（字符）。超了保留头尾，中间省略。 */
export const DEFAULT_MAX_OUTPUT = 8 * 1024;

/** 命令超时的下限/上限，调用方传什么都会被夹到这个区间。 */
export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 60_000;

/** 读文件时最多读多少字节（超出部分不看，只标注被截断）。 */
export const READ_MAX_BYTES = 128 * 1024;
/** 读文件时最多显示多少行。 */
export const READ_MAX_LINES = 2000;
/** 单次写入的字节上限。 */
export const WRITE_MAX_BYTES = 512 * 1024;

export interface ExecOptions {
  /** 工作目录。相对路径的起点，也是 `/bin/sh` 的 cwd。 */
  cwd: string;
  timeoutMs: number;
  /** 输出上限，默认 8KB。 */
  maxOutput?: number;
  /** 进程退出时一并中止子进程。 */
  signal?: AbortSignal;
  /**
   * 覆盖 shell。测试里用它把「跑 sh 脚本」换成「跑 node -e 脚本」，
   * 这样同一套用例在 Windows 开发机和 alpine 容器里都能跑。
   */
  shell?: { file: string; args: string[] };
}

export interface ExecResult {
  /** 退出码；被信号杀死时为 null。 */
  code: number | null;
  /** 杀死它的信号名，没有则为空串。 */
  signal: string;
  timedOut: boolean;
  aborted: boolean;
  durationMs: number;
  output: string;
  truncated: boolean;
}

/** 默认 shell：容器里是 alpine，只有 busybox 的 sh，没有 bash。 */
function defaultShell(): { file: string; args: string[] } {
  return process.platform === 'win32'
    ? { file: 'cmd.exe', args: ['/c'] }
    : { file: '/bin/sh', args: ['-c'] };
}

function clampInt(v: number | undefined, min: number, max: number, fallback: number): number {
  if (v === undefined || !Number.isFinite(v)) return fallback;
  return Math.min(max, Math.max(min, Math.floor(v)));
}

/**
 * 边读边裁的输出缓冲。
 *
 * 头留一半、尾环形留一半，中间只数字符——这样无论命令吐多少字，
 * 内存占用都是常数。只留头会看不见错误（报错通常在最后几行），
 * 只留尾会看不见「一开始就失败」的原因。
 */
class Collector {
  private head = '';
  private tail = '';
  private dropped = 0;

  constructor(private readonly limit: number) {}

  push(chunk: string): void {
    let s = chunk;
    const headLimit = Math.ceil(this.limit / 2);
    const tailLimit = this.limit - headLimit;

    if (this.head.length < headLimit) {
      const take = Math.min(headLimit - this.head.length, s.length);
      this.head += s.slice(0, take);
      s = s.slice(take);
    }
    if (s === '') return;

    if (tailLimit <= 0) {
      this.dropped += s.length;
      return;
    }
    this.tail += s;
    if (this.tail.length > tailLimit) {
      const extra = this.tail.length - tailLimit;
      this.dropped += extra;
      this.tail = this.tail.slice(extra);
    }
  }

  text(): { text: string; truncated: boolean } {
    if (this.dropped === 0) return { text: this.head + this.tail, truncated: false };
    return {
      text: `${this.head}\n…（中间省略 ${this.dropped} 字符）…\n${this.tail}`,
      truncated: true,
    };
  }
}

/** 把一个已知完整的字符串裁成头尾两段，用于命令摘要之类。 */
export function clipOutput(text: string, max = DEFAULT_MAX_OUTPUT): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  const half = Math.floor((max - 16) / 2);
  const cut = text.length - half * 2;
  return { text: `${text.slice(0, half)}\n…（省略 ${cut} 字符）…\n${text.slice(-half)}`, truncated: true };
}

/** 杀整棵进程树。setsid 出去的孙进程杀不到，这是尽力而为。 */
function killTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    // Windows 没有进程组信号，只能交给 taskkill 递归
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // 已经退出了，没什么可做的
    }
  }
}

/** 跑一条命令。超时/中止都会杀掉整棵进程树，但都把已产生的输出带回来。 */
export async function runCommand(command: string, opt: ExecOptions): Promise<ExecResult> {
  const limit = clampInt(opt.maxOutput, 1024, 1024 * 1024, DEFAULT_MAX_OUTPUT);
  const timeoutMs = clampInt(opt.timeoutMs, MIN_TIMEOUT_MS, MAX_TIMEOUT_MS, 20_000);
  const shell = opt.shell ?? defaultShell();
  const started = Date.now();
  const col = new Collector(limit);

  return await new Promise<ExecResult>((done, fail) => {
    let child: ChildProcess;
    try {
      child = spawn(shell.file, [...shell.args, command], {
        cwd: opt.cwd,
        env: process.env,
        // POSIX 上自成进程组，超时才能整组杀；Windows 上 detached 会让窗口独立，反而不好管
        detached: process.platform !== 'win32',
        // stdin 接 /dev/null：不然 `cat`、`read` 这类命令会一直等着输入，直到超时
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
    } catch (e) {
      fail(new Error(`启动命令失败：${(e as Error).message}`));
      return;
    }

    let settled = false;
    let timedOut = false;
    let aborted = false;

    const onData = (b: Buffer): void => col.push(b.toString('utf8'));
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
    }, timeoutMs);

    const onAbort = (): void => {
      aborted = true;
      killTree(child);
    };
    opt.signal?.addEventListener('abort', onAbort, { once: true });

    const cleanup = (): void => {
      clearTimeout(timer);
      opt.signal?.removeEventListener('abort', onAbort);
    };

    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      cleanup();
      fail(new Error(`启动命令失败：${e.message}`));
    });

    child.on('close', (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      const { text, truncated } = col.text();
      done({
        code,
        signal: signal ?? '',
        timedOut,
        aborted,
        durationMs: Date.now() - started,
        output: text,
        truncated,
      });
    });
  });
}

/**
 * 全局串行锁。
 *
 * 第二条命令直接拒绝而不是排队：1 核机器上排第二条只会让两条都超时，
 * 而且模型拿到的是「正在执行」这种可以理解的信息，比干等 40 秒好。
 */
export class CommandLock {
  private running = false;

  get busy(): boolean {
    return this.running;
  }

  async tryRun<T>(fn: () => Promise<T>): Promise<{ ran: true; value: T } | { ran: false }> {
    if (this.running) return { ran: false };
    this.running = true;
    try {
      return { ran: true, value: await fn() };
    } finally {
      this.running = false;
    }
  }
}

export const commandLock = new CommandLock();

/** `~` 展开、相对路径按工作目录解析。 */
export function resolvePath(input: string, cwd: string): string {
  const s = input.trim();
  if (s === '') return normalize(cwd);
  if (s === '~') return homedir();
  if (s.startsWith('~/') || s.startsWith('~\\')) return join(homedir(), s.slice(2));
  return isAbsolute(s) ? normalize(s) : resolve(cwd, s);
}

export interface ReadOptions {
  maxBytes?: number;
  maxLines?: number;
}

export interface ReadResult {
  text: string;
  lines: number;
  bytes: number;
  truncatedBytes: boolean;
  truncatedLines: boolean;
}

/** 读文本文件，带行号。二进制、目录、超大文件都在这里挡住。 */
export async function readTextFile(p: string, opt: ReadOptions = {}): Promise<ReadResult> {
  const maxBytes = clampInt(opt.maxBytes, 1024, 4 * 1024 * 1024, READ_MAX_BYTES);
  const maxLines = clampInt(opt.maxLines, 1, 20_000, READ_MAX_LINES);

  const st = await stat(p);
  if (st.isDirectory()) throw new Error('这是一个目录，用 list_dir 看它的内容');

  const want = Math.min(st.size, maxBytes);
  const fh = await open(p, 'r');
  let buf: Buffer;
  try {
    buf = Buffer.alloc(Math.max(want, 1));
    const { bytesRead } = await fh.read(buf, 0, want, 0);
    buf = buf.subarray(0, bytesRead);
  } finally {
    await fh.close();
  }

  // 前 8KB 里出现 NUL 就按二进制处理：把一段 PNG 塞进上下文既没用又费钱
  const probe = buf.subarray(0, Math.min(buf.length, 8192));
  if (probe.includes(0)) throw new Error('这是二进制文件，不读');

  const raw = buf.toString('utf8');
  const truncatedBytes = st.size > buf.length;
  const all = raw.split('\n');
  // 结尾的换行会多分出一个空串，不该算成一行
  if (all.length > 0 && all[all.length - 1] === '') all.pop();

  const keep = all.slice(0, maxLines);
  const width = String(keep.length).length;
  const text = keep
    .map((line, i) => `${String(i + 1).padStart(width, ' ')}| ${line.replace(/\r$/, '')}`)
    .join('\n');

  return {
    text,
    lines: keep.length,
    bytes: buf.length,
    truncatedBytes,
    truncatedLines: all.length > maxLines,
  };
}

export interface WriteResult {
  created: boolean;
  bytes: number;
}

/** 写文本文件（覆盖），父目录不存在就建。 */
export async function writeTextFile(p: string, content: string): Promise<WriteResult> {
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > WRITE_MAX_BYTES) {
    throw new Error(`内容有 ${bytes} 字节，超过单次写入上限 ${WRITE_MAX_BYTES} 字节，分几次写`);
  }
  if (existsSync(p) && statSync(p).isDirectory()) throw new Error('目标是目录，不能当文件写');

  const existed = existsSync(p);
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, content, 'utf8');
  return { created: !existed, bytes };
}

export interface ListOptions {
  maxDepth?: number;
  maxEntries?: number;
}

export interface ListResult {
  text: string;
  entries: number;
  truncated: boolean;
}

function sizeText(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)}K`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)}M`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)}G`;
}

/**
 * 列目录。深度与条数都设了上限：`/opt/qqbot/data` 下面挂着一个 image 池，
 * 不设限的话一次 list_dir 就能把整个上下文预算吃掉。
 */
export async function listDir(p: string, opt: ListOptions = {}): Promise<ListResult> {
  const maxDepth = clampInt(opt.maxDepth, 0, 4, 2);
  const maxEntries = clampInt(opt.maxEntries, 10, 2000, 300);

  const st = await stat(p);
  if (!st.isDirectory()) throw new Error('这不是目录，用 read_file 看文件内容');

  const lines: string[] = [p];
  let total = 0;
  let truncated = false;

  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > maxDepth || total >= maxEntries) return;
    let ents;
    try {
      ents = await readdir(dir, { withFileTypes: true });
    } catch (e) {
      lines.push(`${'  '.repeat(depth + 1)}（读不了：${(e as NodeJS.ErrnoException).code ?? '未知错误'}）`);
      return;
    }

    // 目录在前、各自按名字排：人看目录是找位置，不是找时间
    ents.sort((a, b) => {
      const ad = a.isDirectory() ? 0 : 1;
      const bd = b.isDirectory() ? 0 : 1;
      if (ad !== bd) return ad - bd;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });

    for (const ent of ents) {
      if (total >= maxEntries) {
        truncated = true;
        return;
      }
      total++;
      const pad = '  '.repeat(depth + 1);
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        lines.push(`${pad}${ent.name}/`);
        await walk(full, depth + 1);
      } else if (ent.isSymbolicLink()) {
        lines.push(`${pad}${ent.name}@ -> 链接`);
      } else {
        let size = 0;
        try {
          size = (await stat(full)).size;
        } catch {
          // 权限不足时 size 拿不到，显示 0 不如不显示
        }
        lines.push(`${pad}${ent.name}  ${sizeText(size)}`);
      }
    }
  };

  await walk(p, 0);
  if (truncated) lines.push(`…（超过 ${maxEntries} 项，只列了前面这些）`);
  return { text: lines.join('\n'), entries: total, truncated };
}
