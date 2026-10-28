// 电脑操作：把「在这台机器上跑条命令 / 改个文件」变成模型可以调用的工具。
//
// 为什么值得做：机器人在群里最常见的求助不是"陪我聊",而是"帮我看看服务起没起、
// 日志里在报什么"。模型自己看不到这台机器，只能让用户贴日志；给了工具之后，
// 它可以先看一眼再回答。
//
// 与搜索工具的三点不同，都是代价换来的：
//   1. 有副作用。搜索最坏是查不到，命令最坏是把机器搞坏，所以每次执行前
//      默认要在面板点批准，且「谁能触发」被限制到主人/白名单/群管理员；
//   2. 有资源成本。1 核机器上一条 `npm install` 能把整台机器拖死，所以
//      命令全局串行、超时有硬上限、输出超 8KB 只留头尾；
//   3. 有暴露面。这里能读到的东西（含 /opt/qqbot/etc 里的密钥）会过一遍
//      模型服务商，这一点在 README 里明说了，不靠"用户不会这么干"。
import type { ToolDef } from '../llm/client';
import type { Logger } from '../log/logger';
import type { ComputerSettings } from '../store/types';
import type { ApprovalQueue } from './computer-approval';
import {
  MAX_TIMEOUT_MS,
  commandLock,
  listDir,
  readTextFile,
  resolvePath,
  runCommand,
  writeTextFile,
  type ExecResult,
} from './computer-exec';

/** 四个工具的名字。引擎按这些名字分派，模型按这些名字调用。 */
export const COMPUTER_TOOL_NAMES = ['run_command', 'read_file', 'write_file', 'list_dir'] as const;
export type ComputerToolName = (typeof COMPUTER_TOOL_NAMES)[number];

export function isComputerTool(name: string): name is ComputerToolName {
  return (COMPUTER_TOOL_NAMES as readonly string[]).includes(name);
}

/** 审批卡片上摘要的长度：够看清在不在这台机器上动东西，又不至于刷屏。 */
const SUMMARY_MAX = 200;
const DETAIL_MAX = 1200;

export const RUN_COMMAND_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'run_command',
    description:
      '在这台服务器上执行一条 shell 命令并拿到输出。适用于：看服务状态、翻日志、查磁盘/内存、找文件、跑只读的诊断命令。' +
      '不要用于：能靠常识回答的问题；不要用它安装软件包（这台机器只有 1 核 1G 内存，装东西会把整个机器人进程 OOM 掉）。' +
      '命令是串行执行的，同一时刻只能跑一条；超时会被强制结束。',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: '要执行的命令，例如 `df -h` 或 `tail -n 50 /opt/qqbot/data/qqbot.log`' },
        cwd: { type: 'string', description: '可选的工作目录（绝对路径）。不填就用默认工作目录。' },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
};

export const READ_FILE_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'read_file',
    description:
      '读一个文本文件的内容，带行号。适用于看配置、看日志片段、看代码。' +
      '二进制文件会被拒绝；文件很大时只返回前面一部分，需要更多就用命令配合 tail/sed 取。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径，绝对路径或相对默认工作目录' },
        max_lines: { type: 'number', description: '最多看多少行，默认 2000' },
      },
      required: ['path'],
      additionalProperties: false,
    },
  },
};

export const WRITE_FILE_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'write_file',
    description:
      '把内容写入一个文本文件（覆盖整个文件，不是追加）。父目录不存在会自动创建。' +
      '不可逆：覆盖之前如果不确定原内容，先用 read_file 看一眼。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径' },
        content: { type: 'string', description: '完整的新内容' },
      },
      required: ['path', 'content'],
      additionalProperties: false,
    },
  },
};

export const LIST_DIR_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: 'list_dir',
    description: '列出一个目录下的文件和子目录（两层深、最多 300 项）。找东西时先用它定位，再用 read_file 看内容。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '目录路径，不填就是默认工作目录' },
      },
      required: [],
      additionalProperties: false,
    },
  },
};

/** 四个工具一起下发。顺序不影响模型行为，按"最常用"排。 */
export function computerTools(): ToolDef[] {
  return [RUN_COMMAND_TOOL, READ_FILE_TOOL, LIST_DIR_TOOL, WRITE_FILE_TOOL];
}

/** 一次调用的触发者是谁。权限判定只认这几个字段，不碰 store。 */
export interface ComputerActor {
  /** 'group:123' / 'private:456' */
  sid: string;
  kind: string;
  /** 群号或 QQ 号 */
  target: number;
  /** 说话的人 */
  user: number;
  /** 群里的身份：owner / admin / member。私聊为空串。 */
  role: string;
}

export interface AccessVerdict {
  allowed: boolean;
  /** 给人看的原因，写日志与调试用。 */
  reason: string;
}

/**
 * 谁能用这套工具。
 *
 * 顺序是刻意的：总开关 -> 私聊（主人 / 白名单好友）-> 群（白名单 + 管理员）。
 * 群这一层多一道管理员判断，是因为群的成员是流动的：白名单只说明"这个群可信"，
 * 不代表"刚被拉进来的任何人都能让机器人跑命令"。
 */
export function computerAccess(c: ComputerSettings, a: ComputerActor): AccessVerdict {
  if (!c.enabled) return { allowed: false, reason: '电脑操作没有开启' };

  if (a.kind === 'private') {
    if (c.owner_qq > 0 && a.user === c.owner_qq) return { allowed: true, reason: '主人私聊' };
    if (c.allow_users.includes(a.user)) return { allowed: true, reason: '白名单好友' };
    return { allowed: false, reason: '这个账号不在白名单里' };
  }

  if (a.kind === 'group') {
    if (!c.allow_groups.includes(a.target)) return { allowed: false, reason: '这个群不在白名单里' };
    if (a.role !== 'owner' && a.role !== 'admin') {
      return { allowed: false, reason: '群里只有群主和管理员能触发' };
    }
    return { allowed: true, reason: '白名单群的群主/管理员' };
  }

  return { allowed: false, reason: '这种会话不支持电脑操作' };
}

/** 把命令切成「一条条独立命令」，用来判断每条的首个词。 */
function segmentsOf(command: string): string[] {
  return command
    .replace(/\r/g, '\n')
    // 分隔符按 shell 的语义切：; 换行 && || |
    .split(/[\n;]|&&|\|\||\|/)
    .map((s) => s.trim())
    .filter((s) => s !== '');
}

/** 取一条命令的首个词，跳过 `FOO=bar` 这类前置赋值。 */
function firstWord(seg: string): string {
  for (const part of seg.split(/\s+/)) {
    if (part === '') continue;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(part)) continue;
    return part.replace(/^[([{!]+/, '').toLowerCase();
  }
  return '';
}

/** 首个词命中即拒的命令。写成表是为了报错时能说清"为什么"。 */
const DANGER_COMMANDS: Record<string, string> = {
  mkfs: '格式化文件系统',
  fdisk: '改分区表',
  parted: '改分区表',
  wipefs: '擦除分区签名',
  shutdown: '关机',
  reboot: '重启',
  halt: '关机',
  poweroff: '关机',
  docker: '控制容器',
  podman: '控制容器',
  nerdctl: '控制容器',
  systemctl: '控制系统服务',
  passwd: '改账号密码',
  chpasswd: '改账号密码',
  usermod: '改账号',
  useradd: '建账号',
  adduser: '建账号',
  visudo: '改 sudo 授权',
  sudo: '提权',
  su: '切换用户',
  mount: '挂载文件系统',
  umount: '卸载文件系统',
  insmod: '加载内核模块',
  modprobe: '加载内核模块',
  iptables: '改防火墙',
  nft: '改防火墙',
  sysctl: '改内核参数',
};

/** 递归删除的目标里出现这些就算删根。 */
const ROOT_TARGETS = new Set(['/', '/*', '/**', '~', '~/', '$HOME', '${HOME}']);

export interface DangerVerdict {
  denied: boolean;
  reason: string;
}

/**
 * 这条命令是否属于「连批准也不给执行」的那一类。
 *
 * 必须说清楚：这是绊线，不是沙箱。`base64 -d | sh`、`$(printf '\x72\x6d')`
 * 都能绕过去。它拦的是手滑与最直接的破坏（删根、格式化、关机、停容器），
 * 因为这些一旦发生，机器人都没了，连"事后补救"的机会都没有。
 */
export function dangerOf(command: string): DangerVerdict {
  const raw = command.trim();
  if (raw === '') return { denied: false, reason: '' };

  // 整串级别的特征，切段看不出来
  if (raw.includes('--no-preserve-root')) return { denied: true, reason: '关闭了删除保护' };
  if (/:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/.test(raw)) {
    return { denied: true, reason: 'fork 炸弹' };
  }
  if (/(^|[^0-9])>\s*\/dev\/(sd|nvme|vd|hd)/.test(raw)) return { denied: true, reason: '直接覆写磁盘设备' };

  for (const seg of segmentsOf(raw)) {
    const word = firstWord(seg);
    if (word === '') continue;

    const base = word.split('.')[0] ?? word;
    const why = DANGER_COMMANDS[base];
    if (why !== undefined) return { denied: true, reason: why };

    // 格式化类：mkfs.ext4 / mkfs.xfs …… 上面 split('.') 已经覆盖，这里补 `init 0/6`
    if (base === 'init' && /^init\s+[06]\b/.test(seg.toLowerCase())) {
      return { denied: true, reason: '关机/重启' };
    }
    if (base === 'dd' && /\bof=\/dev\//.test(seg)) return { denied: true, reason: '直接写块设备' };

    if (base === 'rm') {
      const parts = seg.split(/\s+/);
      // -rf / -fr / -r -f 都算；只要带 r 且带 f
      const flags = parts.filter((p) => p.startsWith('-')).join('');
      if (/r/.test(flags) && /f/.test(flags)) {
        for (const p of parts) {
          if (ROOT_TARGETS.has(p)) return { denied: true, reason: '递归删除根目录或家目录' };
        }
      }
    }

    if (base === 'chmod' && /\bchmod\s+(-\S+\s+)*777\s+\/(\s|$)/.test(seg)) {
      return { denied: true, reason: '把根目录放开成 777' };
    }
  }

  return { denied: false, reason: '' };
}

/** 写这些路径会把系统或凭据搞坏，禁止 write_file 落到这里。 */
const DANGER_PATHS = ['/proc', '/sys', '/dev', '/etc/passwd', '/etc/shadow', '/etc/sudoers'];

/** 写文件的路径检查。只挡真正会让机器起不来的位置，不是白名单。 */
export function dangerPathOf(p: string): DangerVerdict {
  const s = p.trim();
  if (s === '') return { denied: false, reason: '' };
  for (const bad of DANGER_PATHS) {
    if (s === bad || s.startsWith(`${bad}/`)) return { denied: true, reason: `${bad} 是系统路径` };
  }
  return { denied: false, reason: '' };
}

/** 默认工作目录：配置为空就用数据目录。 */
export function resolveWorkdir(c: ComputerSettings, fallback: string): string {
  const raw = c.workdir.trim();
  if (raw === '') return fallback;
  return resolvePath(raw, fallback);
}

/**
 * 注入 system 的工具说明。
 *
 * 与搜索一样，只在有权使用时才注入——关掉还告诉模型"你能执行命令"，
 * 它会在回复里编出"我看了一下日志"。
 */
export function computerPromptBlock(c: ComputerSettings, cwd: string): string {
  const timeout = Math.round(c.timeout_sec);
  const calls = Math.round(c.max_calls);
  const lines = [
    '你可以在这台服务器上执行命令、读写文件。环境是 Linux 容器，非 root 用户，只有 sh 没有 bash。',
    `- 默认工作目录：${cwd}。相对路径都相对它解析。`,
    `- 单条命令最多 ${timeout} 秒，超时会被强制结束；输出超过 8KB 只保留头尾。`,
    `- 一条消息最多执行 ${calls} 次，且同一时刻只能跑一条命令。`,
    '- 这台机器只有 1 核、内存很小：不要安装软件包、不要跑编译、不要起常驻进程，否则整个机器人会被系统杀掉。',
    '- 只做用户真的需要的那一步；不要把整屏日志贴进聊天，说结论。',
    '- 删除、覆盖、重启这类不可逆操作，先说清要做什么，再调用工具。',
  ];
  if (c.require_approval) {
    lines.splice(4, 0, `- 每次执行前需要主人在面板上确认，最多等 ${Math.round(c.approval_timeout_sec)} 秒；被拒绝或超时就放弃，不要反复重试。`);
  }
  return lines.join('\n');
}

/** 一次工具调用的运行环境。引擎负责把 store/审批队列接进来。 */
export interface ComputerContext {
  settings: ComputerSettings;
  actor: ComputerActor;
  /** 默认工作目录（已解析成绝对路径）。 */
  cwd: string;
  approvals: ApprovalQueue;
  log: Logger;
  /** 写一条审计记录。引擎传 store.audit.record，测试传空实现。 */
  audit: (action: string, detail: string) => void;
  signal?: AbortSignal;
}

function safeJson(raw: string): Record<string, unknown> {
  try {
    const v: unknown = JSON.parse(raw);
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>;
  } catch {
    // 落空：调用方会给一句"参数不是合法 JSON"
  }
  return {};
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function numArg(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

function clip(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}

/** 命令结果的回灌格式：先给退出码与耗时，再给输出。 */
function formatExec(r: ExecResult, timeoutSec: number): string {
  const cost = (r.durationMs / 1000).toFixed(1);
  let head: string;
  if (r.timedOut) head = `命令超时（上限 ${Math.round(timeoutSec)} 秒），已被强制结束。`;
  else if (r.aborted) head = '命令被中止（进程正在退出）。';
  else if (r.code === 0) head = `退出码 0，耗时 ${cost} 秒。`;
  else if (r.code === null) head = `命令被信号 ${r.signal || '未知'} 结束，耗时 ${cost} 秒。`;
  else head = `退出码 ${r.code}，耗时 ${cost} 秒。`;

  const body = r.output.replace(/\s+$/, '');
  const text = body === '' ? '（没有任何输出）' : body;
  const tail = r.truncated ? '\n（输出太长，中间已省略。要细节就用 head/tail/grep 再取一次，别把整份重跑）' : '';
  return `${head}\n${text}${tail}`;
}

/**
 * 走一次审批。
 *
 * 返回空串表示可以继续执行；否则就是要回灌给模型的那句话。
 * 超时与拒绝的文案必须明确说"没有执行"——模型很容易把"没批准"理解成
 * "执行失败了"，然后编一个结果出来。
 */
async function runApproval(ctx: ComputerContext, tool: string, summary: string, detail: string): Promise<string> {
  if (!ctx.settings.require_approval) return '';

  let decision: string;
  try {
    decision = await ctx.approvals.ask(
      {
        session: ctx.actor.sid,
        kind: ctx.actor.kind,
        target: ctx.actor.target,
        user: ctx.actor.user,
        tool,
        summary: clip(summary, SUMMARY_MAX),
        detail: clip(detail, DETAIL_MAX),
      },
      { timeoutMs: Math.max(1, Math.round(ctx.settings.approval_timeout_sec)) * 1000, signal: ctx.signal },
    );
  } catch (e) {
    return `这次操作没有执行（${(e as Error).message}）。`;
  }

  switch (decision) {
    case 'approved':
      return '';
    case 'denied':
      return '这次操作没有得到批准，没有执行。不要重试，直接用现有信息回答，并告诉用户需要批准。';
    case 'timeout':
      return `等待批准超时（${Math.round(ctx.settings.approval_timeout_sec)} 秒），这次操作没有执行。需要的话请让主人先在面板上确认。`;
    default:
      return '操作已取消，没有执行。';
  }
}

function summaryOfCommand(command: string): string {
  return command.replace(/\s+/g, ' ').trim();
}

/**
 * 执行一个工具调用，返回一段给模型看的中文。
 *
 * 这里**永不抛错**：引擎的分派循环里任何一次抛出都会让整条回复走兜底话术，
 * 而"命令失败"是正常业务结果，应该由模型自己决定怎么跟用户说。
 */
export async function runComputerTool(name: string, rawArgs: string, ctx: ComputerContext): Promise<string> {
  const args = safeJson(rawArgs);
  const cwd = ctx.cwd;

  try {
    if (name === 'run_command') {
      const command = str(args['command']).trim();
      if (command === '') return 'command 是空的。请给出要执行的具体命令。';

      const danger = dangerOf(command);
      if (danger.denied) {
        ctx.log.warn('拒绝危险命令', { session: ctx.actor.sid, reason: danger.reason, command: clip(command, 120) });
        return `这条命令被硬性拒绝（${danger.reason}），批准也不行，换个做法。`;
      }

      const deny = await runApproval(ctx, name, summaryOfCommand(command), command);
      if (deny !== '') return deny;

      const dir = str(args['cwd']).trim() === '' ? cwd : resolvePath(str(args['cwd']), cwd);
      const run = await commandLock.tryRun(() =>
        runCommand(command, {
          cwd: dir,
          timeoutMs: Math.min(MAX_TIMEOUT_MS, Math.max(1, Math.round(ctx.settings.timeout_sec)) * 1000),
          signal: ctx.signal,
        }),
      );
      if (!run.ran) return '当前有另一条命令正在执行（这台机器只有 1 核，命令是串行跑的）。等它结束再试。';

      ctx.audit('computer.exec', `run_command exit=${run.value.code ?? 'signal'} ${clip(command, 120)}`);
      ctx.log.info('已执行命令', {
        session: ctx.actor.sid,
        code: String(run.value.code ?? '-'),
        ms: String(run.value.durationMs),
        command: clip(command, 120),
      });
      return formatExec(run.value, ctx.settings.timeout_sec);
    }

    if (name === 'read_file') {
      const p = resolvePath(str(args['path']), cwd);
      if (p.trim() === '') return 'path 是空的。请给出要读的文件路径。';
      const r = await readTextFile(p, { maxLines: numArg(args['max_lines']) });
      ctx.audit('computer.read', clip(p, 160));
      const notes: string[] = [];
      if (r.truncatedBytes) notes.push('文件比显示的部分长（只读了前 128KB）');
      if (r.truncatedLines) notes.push(`只显示前 ${r.lines} 行`);
      const tail = notes.length === 0 ? '' : `\n（${notes.join('；')}，要看更多请用命令配合 tail/sed）`;
      return `${p}（${r.bytes} 字节）\n${r.text}${tail}`;
    }

    if (name === 'write_file') {
      const p = resolvePath(str(args['path']), cwd);
      if (p.trim() === '') return 'path 是空的。请给出要写入的文件路径。';
      const content = str(args['content']);

      const danger = dangerPathOf(p);
      if (danger.denied) return `这个路径被硬性拒绝（${danger.reason}），不能写。`;

      const deny = await runApproval(ctx, name, `写入 ${p}（${Buffer.byteLength(content, 'utf8')} 字节）`, `${p}\n\n${content}`);
      if (deny !== '') return deny;

      const w = await writeTextFile(p, content);
      ctx.audit('computer.write', `${w.created ? 'new' : 'over'} ${Buffer.byteLength(content, 'utf8')}B ${clip(p, 120)}`);
      return `${w.created ? '新建' : '覆盖'}了 ${p}，写入 ${w.bytes} 字节。`;
    }

    if (name === 'list_dir') {
      const raw = str(args['path']).trim();
      const p = raw === '' ? cwd : resolvePath(raw, cwd);
      const r = await listDir(p);
      const tail = r.truncated ? '\n（条目太多，只列了前面一部分）' : '';
      return `${r.text}${tail}`;
    }

    return `没有名为 ${name} 的工具。`;
  } catch (e) {
    ctx.log.warn('电脑操作失败', { tool: name, session: ctx.actor.sid, err: e });
    const msg = (e as NodeJS.ErrnoException).code === 'ENOENT' ? '路径不存在' : (e as Error).message;
    return `执行失败（${msg}）。不要原样重试，先确认路径和权限，或者换一种做法。`;
  }
}
