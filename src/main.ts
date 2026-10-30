// qqbot 命令行入口。
//
// 子命令与 Go 版一致（run / status / doctor / reset-password / version / help）。
// 为什么保留这么多子命令：容器里只有这一个二进制，没有 sqlite3、
// 没有 jq、没有 curl。任何运维动作都必须由它自己提供，
// 否则用户遇到问题就只剩"删库重装"一条路。
import { existsSync, mkdirSync, statSync, statfsSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig, loadSecrets, root, secretsPath, webDir, type Config } from './config';
import { Engine } from './bot';
import { ApprovalQueue } from './bot/computer-approval';
import { parseFlags, flagName } from './cli/flags';
import { LogHub } from './log/hub';
import { Logger, type LogLevel } from './log/logger';
import { NapCatWebUI } from './napcat/webui';
import { Client, getLoginInfo, portOf, sendGroupMsg, sendPrivateMsg } from './onebot';
import { hashPassword } from './panel/auth';
import { PanelServer } from './panel/server';
import { Box, generateToken } from './secret/box';
import { Store } from './store';
import { sleep } from './util/time';
import { versionString } from './version';

function logLevel(v: string): LogLevel {
  return v === 'debug' || v === 'info' || v === 'warn' || v === 'error' ? v : 'info';
}

// ---- 入口 ----

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const cmd = argv[0] ?? 'help';
  const rest = argv.slice(1);

  // 子命令的 -h/--help 统一在这里拦掉。以前每个子命令都解析出 help 却没人看，
  // 于是 `qqbot reset-password --help` 会真的把密码重置掉并打印新密码。
  if (cmd !== 'help' && rest.some((a) => flagName(a) === 'help' || flagName(a) === 'h')) {
    usage(process.stdout);
    return;
  }

  switch (cmd) {
    case 'version':
    case '-v':
    case '--version':
      process.stdout.write(`${versionString()}\n`);
      return;
    case 'run':
      return cmdRun(rest);
    case 'status':
      return cmdStatus(rest);
    case 'doctor':
      return cmdDoctor(rest);
    case 'reset-password':
      return cmdResetPassword(rest);
    case 'help':
    case '-h':
    case '--help':
      usage(process.stdout);
      return;
    default:
      usage(process.stderr);
      throw new Error(`未知子命令: ${cmd}`);
  }
}

function usage(w: NodeJS.WritableStream): void {
  w.write(`qqbot — 轻量 QQ 机器人

用法:
  qqbot <子命令> [参数]

子命令:
  run             前台运行机器人（容器入口）
  status          查看运行状态
  doctor          环境自检
  reset-password  重置面板管理员密码（忘记密码时用）
  version         打印版本
  help            显示本帮助

配置文件: ${join(root(), 'etc', 'qqbot.toml')}
数据目录: ${join(root(), 'data', 'qqbot')}
`);
}

// ---- run ----

/**
 * 装上"未处理 Promise 拒绝"的兜底。
 *
 * Node 22 默认把未处理拒绝升级为进程退出。这对"写错代码要立刻暴露"是对的，
 * 但对一个 7×24 常驻的机器人是灾难：面板收到一条畸形请求、某个后台 tick
 * 忘了 await，整台机器就进重启循环，而且日志里一个字都没有。
 *
 * 刻意**不**接管 uncaughtException：同步异常往往意味着状态已经半写
 * （事务没提交、文件写了一半），继续跑比退出更危险，该崩就让它崩。
 */
function installCrashGuards(log: Logger): void {
  process.on('unhandledRejection', (reason: unknown) => {
    log.error('未处理的 Promise 拒绝', { err: reason });
  });
}

/** 容器入口：装配全部组件并前台运行。 */
async function cmdRun(argv: string[]): Promise<void> {
  const flags = parseFlags(argv);
  const { config, warning } = loadConfig(flags.config);

  const hub = new LogHub(500);
  const log = Logger.create({ level: logLevel(config.log.level), format: config.log.format, hub });
  if (warning) log.warn(warning);
  installCrashGuards(log);

  const secrets = loadSecrets();
  const box = buildBox(secrets, log);

  const dbPath = join(config.dataDir, 'qqbot.db');
  const store = new Store(dbPath);
  store.setBox(box);
  store.setLog(log);

  // 图池目录：放图进去机器人就有图可发，删掉目录等于清空池子
  const imagesDir = join(config.dataDir, 'images');
  try {
    mkdirSync(imagesDir, { recursive: true });
  } catch (e) {
    log.warn('图池目录创建失败，图池功能不可用', { dir: imagesDir, err: e });
  }

  const ac = new AbortController();

  try {
    await ensureAdminPassword(store, log);

    // 空串不能当"配了 token"：etc/env 里写了 QQBOT_ONEBOT_TOKEN= 但没填值时，
    // ?? 不会回退到 toml 的 access_token，协议端就会因为 token 不匹配拒绝连接。
    const secretToken = secrets['QQBOT_ONEBOT_TOKEN'] ?? '';
    const token = secretToken !== '' ? secretToken : config.onebot.accessToken;
    // 待批准队列：引擎挂起申请、面板读取并点批准，必须是同一个实例。
    // 放在这里建，两边的生命周期就都由 ac.signal 统一收口。
    const approvals = new ApprovalQueue(log.with({ component: 'computer' }));
    ac.signal.addEventListener('abort', () => approvals.cancelAll(), { once: true });

    const engine = new Engine({ store, log, signal: ac.signal, imagesDir, dataDir: config.dataDir, approvals });
    const client = new Client(config.onebot.url, token, log);

    // 引擎与客户端互相注入：先建引擎再建客户端，然后回填，避免循环依赖
    engine.setSender({
      sendGroup: (id, segs, sig) => sendGroupMsg(client, id, segs, sig),
      sendPrivate: (id, segs, sig) => sendPrivateMsg(client, id, segs, sig),
      groupInfo: async (id, sig) => {
        const d = (await client.call('get_group_info', { group_id: id }, sig)) as
          | { group_name?: string }
          | undefined;
        return d?.group_name ?? '';
      },
    });
    client.setHandler((ev) => engine.handleEvent(ev));

    // 扫码登录走服务端持有的 WebUI token，浏览器永远看不到它
    const qq = new NapCatWebUI(config.napcat.webui, secrets['QQBOT_WEBUI_TOKEN'] ?? '', log);

    const panel = new PanelServer({
      store,
      log,
      hub,
      webDir: webDir(),
      engine,
      client: portOf(client),
      qq,
      // 登录成功后自动补齐这条反向 WS，省掉「去网络页点一下」的手工步骤
      onebotPort: onebotPortOf(config.onebot.url),
      // 补出来的监听要带同一个 token，否则等于开了个无凭据的 OneBot 控制面
      onebotAccessToken: token,
      imagesDir,
      approvals,
    });

    log.info('qqbot 启动', {
      version: versionString(),
      onebot: config.onebot.url,
      panel: config.panel.listen,
      data: config.dataDir,
    });

    await panel.listen(config.panel.listen);

    // 协议端连接在后台跑，失败自动退避重连，不阻塞面板启动
    void client.run(ac.signal).catch((e: unknown) => {
      log.error('协议端连接协程异常退出', { err: e });
    });
    void fetchLoginInfo(ac.signal, client, engine, log);
    void tickLoop(engine, ac.signal, log);

    await waitForSignal(log);
    log.info('收到退出信号，正在关闭');

    ac.abort();
    client.close();
    await panel.close(5000);
  } finally {
    store.close();
  }
}

/**
 * 连接建立后拉取一次登录信息，用于拿到机器人 QQ 号与昵称。
 *
 * 为什么不放在 onOpen 回调里：登录信息依赖 QQ 已扫码登录，
 * 而 WebSocket 建连可能早于扫码完成，一次失败就放弃会永远拿不到昵称。
 * 轮询到成功为止，成功后立即退出。
 */
async function fetchLoginInfo(
  signal: AbortSignal,
  client: Client,
  engine: Engine,
  log: Logger,
): Promise<void> {
  while (!signal.aborted) {
    await sleep(5000, signal);
    if (signal.aborted) return;
    if (!client.status().connected) continue;

    try {
      const info = await getLoginInfo(client, AbortSignal.timeout(5000));
      if (info.user_id === 0) continue;
      engine.setSelf(info.user_id, info.nickname);
      log.info('已登录', { uin: info.user_id, nickname: info.nickname });
      return;
    } catch (e) {
      log.debug('获取登录信息失败', { err: e });
    }
  }
}

/**
 * 每分钟驱动一次引擎的调度：到期的闹钟与闲置唤醒。
 *
 * 为什么轮询而不是给每条消息挂 setTimeout：定时消息要活过进程重启，
 * 靠的是库里的 due_at（见 store/scheduled.ts）。轮询还有个副作用是好的
 * ——系统时间被改（NTP 校准、容器迁移）时它会自然跟上，而 setTimeout
 * 会按单调时钟一路错下去。
 *
 * 启动后立刻跑一轮：重启前欠着的闹钟不该再等 60 秒。
 */
async function tickLoop(engine: Engine, signal: AbortSignal, log: Logger): Promise<void> {
  while (!signal.aborted) {
    try {
      await engine.tick();
    } catch (e) {
      // 引擎自己会兜一层，这里是最后的保险：调度线程不该整个死掉
      log.warn('调度轮询异常', { err: e });
    }
    await sleep(60_000, signal);
  }
}

/** 阻塞到收到 SIGINT/SIGTERM。 */
function waitForSignal(log: Logger): Promise<void> {
  return new Promise<void>((resolve) => {
    const done = (): void => resolve();
    process.once('SIGINT', done);
    process.once('SIGTERM', done);
    // 容器里 docker stop 发的是 SIGTERM，但某些环境（k8s 的 preStop 缺失）
    // 会直接 SIGKILL，那种情况下这段代码根本没机会跑，无需额外处理
    process.once('SIGHUP', () => log.debug('收到 SIGHUP，忽略'));
  });
}

/**
 * 从密钥文件构造加解密器。
 *
 * 缺失时给出可直接照抄的修复命令：这个错误发生在启动最早期，
 * 用户看不到面板、也看不到日志页面，报错必须自己解释清楚。
 */
function buildBox(secrets: Record<string, string>, log: Logger): Box {
  const key = secrets['QQBOT_SECRET_KEY'] ?? '';
  if (key === '') {
    throw new Error(
      '缺少 QQBOT_SECRET_KEY。\n' +
        '  该密钥用于加密存储模型 API Key，不能丢（丢了需要重新录入 Key）。\n' +
        `  修复：在 ${secretsPath()} 中加入一行 QQBOT_SECRET_KEY=<64位十六进制>\n` +
        '  生成：qqbot install 会自动生成，或执行 openssl rand -hex 32',
    );
  }
  try {
    const box = Box.fromHex(key);
    log.debug('密钥已加载');
    return box;
  } catch (e) {
    throw new Error(`QQBOT_SECRET_KEY 无效: ${(e as Error).message}`);
  }
}

/** 首次运行时生成管理员密码并打印一次。 */
/**
 * 从 OneBot 地址里取反向 WS 端口（ws://napcat:3001 → 3001）。
 *
 * 不写死 3001：有人会在 qqbot.toml 里换端口，自动补的监听必须和
 * 机器人实际要连的端口一致，否则补了也白补。
 */
function onebotPortOf(url: string): number {
  try {
    const port = new URL(url).port;
    return port === '' ? 3001 : Number(port);
  } catch {
    return 3001;
  }
}

async function ensureAdminPassword(store: Store, log: Logger): Promise<void> {
  const settings = store.settings.get();
  if (settings.panel.password_hash !== '') return;

  const pw = generateToken(16);
  const hash = await hashPassword(pw);
  store.settings.update((v) => {
    v.panel.password_hash = hash;
    if (v.panel.admin_user === '') v.panel.admin_user = 'admin';
  });

  const user = settings.panel.admin_user === '' ? 'admin' : settings.panel.admin_user;
  // 只在首次生成时打印一次，之后无法再查看
  process.stdout.write(
    '\n================ 面板初始凭据 ================\n' +
      `  用户名: ${user}\n` +
      `  密码  : ${pw}\n` +
      '  以上信息只显示这一次，请立即保存。\n' +
      '==============================================\n\n',
  );
  log.warn('已生成面板初始密码，请登录后立即修改');
}

// ---- status ----

/**
 * 打印配置概览与数据目录状态。
 *
 * 刻意不连数据库、不连协议端——排查"服务起不来"时往往连日志都看不到，
 * 这个命令必须绝对可靠。
 */
function cmdStatus(argv: string[]): void {
  const flags = parseFlags(argv);
  const cfgPath = flags.config ?? join(root(), 'etc', 'qqbot.toml');

  const out = (s: string): void => {
    process.stdout.write(`${s}\n`);
  };

  out(`版本      : ${process.platform}/${process.arch} node ${process.version}`);
  out(`安装根目录: ${root()}`);
  out(`配置文件  : ${cfgPath}${existsSync(cfgPath) ? '  [存在]' : '  [不存在]'}`);

  let cfg: Config;
  try {
    cfg = loadConfig(cfgPath).config;
  } catch (e) {
    out(`\n配置加载失败: ${(e as Error).message}`);
    return;
  }

  const dataOk = existsSync(cfg.dataDir) && statSync(cfg.dataDir).isDirectory();
  out(`数据目录  : ${cfg.dataDir}${dataOk ? '  [存在]' : '  [不存在]'}`);
  out(`协议端    : ${cfg.onebot.url}`);
  out(`面板监听  : ${cfg.panel.listen}`);
  out(`日志级别  : ${cfg.log.level}`);

  const sp = secretsPath();
  const secrets = loadSecrets(sp);
  const count = Object.keys(secrets).length;
  out(`密钥文件  : ${sp}${count === 0 ? '  [空]' : `  [${count} 项]`}`);
  if ((secrets['QQBOT_SECRET_KEY'] ?? '') === '') {
    out('  ⚠ 缺少 QQBOT_SECRET_KEY，服务将无法启动');
  }
  if ((secrets['QQBOT_ONEBOT_TOKEN'] ?? '') === '') {
    out('  ⚠ 缺少 QQBOT_ONEBOT_TOKEN，协议端连接可能被拒绝');
  }

  const dbPath = join(cfg.dataDir, 'qqbot.db');
  if (existsSync(dbPath)) {
    out(`数据库    : ${dbPath}  (${(statSync(dbPath).size / 1024).toFixed(1)} KB)`);
  } else {
    out(`数据库    : ${dbPath}  [尚未创建]`);
  }
}

// ---- doctor ----

/** 环境自检，输出可直接照着修的问题清单。 */
function cmdDoctor(argv: string[]): void {
  // 必须真的用上这个参数：`qqbot doctor --config /x` 的人想知道的就是那份
  // 配置有没有问题；丢掉返回值会拿默认路径自检，给出一份"看着没问题"的答案。
  const flags = parseFlags(argv);
  let problems = 0;
  const out = (s: string): void => {
    process.stdout.write(`${s}\n`);
  };
  const ok = (s: string): void => out(`  ✓ ${s}`);
  const warn = (s: string): void => out(`  ! ${s}`);
  const fail = (s: string): void => {
    problems++;
    out(`  ✗ ${s}`);
  };

  out('环境');
  out(`  · ${process.platform}/${process.arch}，node ${process.version}`);
  const [major] = process.versions.node.split('.').map(Number);
  if ((major ?? 0) < 22) {
    fail(`node 版本过低（需要 >= 22.13，当前 ${process.version}）`);
  } else {
    ok('node 版本满足要求');
  }

  out('配置');
  let cfg: Config | null = null;
  try {
    cfg = loadConfig(flags.config).config;
    ok('配置可解析');
  } catch (e) {
    fail((e as Error).message);
  }

  out('密钥');
  const secrets = loadSecrets();
  const key = secrets['QQBOT_SECRET_KEY'] ?? '';
  if (key === '') fail('缺少 QQBOT_SECRET_KEY（生成：openssl rand -hex 32）');
  else if (key.length !== 64) fail(`QQBOT_SECRET_KEY 长度应为 64 位十六进制，当前 ${key.length} 位`);
  else ok('QQBOT_SECRET_KEY 格式正确');

  if ((secrets['QQBOT_ONEBOT_TOKEN'] ?? '') === '') warn('缺少 QQBOT_ONEBOT_TOKEN');
  else ok('QQBOT_ONEBOT_TOKEN 已配置');

  out('目录');
  if (cfg) {
    if (existsSync(cfg.dataDir) && statSync(cfg.dataDir).isDirectory()) {
      ok('数据目录存在');
      try {
        checkWritable(cfg.dataDir);
        ok('数据目录可写');
      } catch (e) {
        fail(`数据目录不可写：${(e as Error).message}`);
      }
      try {
        const s = statfsSync(cfg.dataDir);
        const gb = (s.bavail * s.bsize) / 1024 ** 3;
        if (gb < 2) warn(`磁盘剩余仅 ${gb.toFixed(1)} GB，建议至少保留 2 GB`);
        else ok(`磁盘剩余 ${gb.toFixed(1)} GB`);
      } catch {
        // statfs 在某些文件系统上不可用，不影响自检结论
      }
    } else {
      warn('数据目录不存在（首次启动会自动创建）');
    }
  }

  out('');
  if (problems > 0) {
    out(`发现 ${problems} 个必须修复的问题`);
    throw new Error('自检未通过');
  }
  out('自检通过');
}

function checkWritable(dir: string): void {
  const probe = mkdtempSync(join(dir, '.write-test-'));
  rmSync(probe, { recursive: true, force: true });
}

// ---- reset-password ----

/**
 * 重置面板管理员密码。
 *
 * 存在的理由：密码是 argon2id 哈希存的，取不回明文。
 * 忘了密码原本只能删库重装，代价是丢掉会话历史和全部配置。
 * 这个命令只改 password_hash 一个字段，其余数据原样保留。
 *
 * 顺带清掉 TOTP：会走到这一步的多半是完全进不去了，
 * 留着二步验证等于换了密码还是登不进。
 */
async function cmdResetPassword(argv: string[]): Promise<void> {
  const flags = parseFlags(argv);

  let path = flags.db ?? '';
  if (path === '') {
    let dataDir = join(root(), 'data', 'qqbot');
    try {
      // 优先读引导配置里的 data_dir：它可能不是默认路径（容器里是 /opt/qqbot/data）
      const cfg = loadConfig(flags.config).config;
      if (cfg.dataDir !== '') dataDir = cfg.dataDir;
    } catch {
      // 配置坏了也要能重置密码，退回默认路径
    }
    path = join(dataDir, 'qqbot.db');
  }

  if (!existsSync(path)) {
    throw new Error(`找不到数据库 ${path}（用 --db 指定路径）`);
  }

  const store = new Store(path);
  try {
    const pw = generateToken(16);
    const hash = await hashPassword(pw);

    let user = 'admin';
    let hadTOTP = false;
    store.settings.update((v) => {
      v.panel.password_hash = hash;
      if (v.panel.admin_user === '') v.panel.admin_user = 'admin';
      user = v.panel.admin_user;
      hadTOTP = v.panel.totp_enabled;
      if (flags.keepTOTP !== true) {
        v.panel.totp_secret = '';
        v.panel.totp_enabled = false;
      }
    });

    const lines = [
      '',
      '================ 密码已重置 ================',
      `  用户名: ${user}`,
      `  新密码: ${pw}`,
    ];
    if (flags.keepTOTP !== true && hadTOTP) {
      lines.push('  TOTP  : 已关闭（原配置被清除）');
    }
    lines.push('  以上信息只显示这一次，请立即保存。', '==============================================', '');
    process.stdout.write(`${lines.join('\n')}\n`);
  } finally {
    store.close();
  }
}

// ---- 启动 ----

main().then(
  () => {
    process.exit(0);
  },
  (e: unknown) => {
    process.stderr.write(`错误: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  },
);
