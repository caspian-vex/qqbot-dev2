// 引导配置（etc/qqbot.toml）与密钥（etc/secrets.env）。
//
// 配置刻意分两层，与 Go 版一致：
//   - 引导配置：路径、监听地址、协议端连接串，部署期确定，面板不写
//   - 运行期设置（SQLite settings 表）：模型、人格、触发规则，面板可写、热生效
// 分开是为了避免面板写 TOML 时冲掉人工注释，也避免并发写竞态。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse, stringify } from 'smol-toml';
import type { LogLevel } from '../log/logger';

/** 默认安装根目录，容器内固定为 /opt/qqbot。 */
const DEFAULT_ROOT = '/opt/qqbot';

/** 默认监听地址（本机开发用）。容器内由 QQBOT_LISTEN 覆盖成 0.0.0.0:5666。 */
const DEFAULT_LISTEN = '127.0.0.1:5666';

/** 默认 NapCat WebUI 地址。容器内走 compose 服务名。 */
const DEFAULT_NAPCAT_WEBUI = 'http://127.0.0.1:6099';

export interface Config {
  root: string;
  dataDir: string;
  log: { level: LogLevel; format: 'text' | 'json' };
  onebot: { url: string; accessToken: string };
  panel: { listen: string };
  napcat: { webui: string };
}

/** 安装根目录，优先取 QQBOT_ROOT。 */
export function root(): string {
  const v = process.env.QQBOT_ROOT?.trim();
  return v && v !== '' ? v : DEFAULT_ROOT;
}

export function configPath(): string {
  return join(root(), 'etc', 'qqbot.toml');
}

/**
 * 前端静态资源目录（web/dist）。
 *
 * 为什么要在候选路径里找而不是写死一个：
 * 开发态用 tsx 直接跑源码，__dirname 是 src/config；
 * 生产态跑打包产物，__dirname 是 /app/dist。两者相对 web/dist
 * 的层级不同，写死任何一个都会在另一种模式下 404。
 * 按顺序取第一个真实存在的，两种模式都不用额外配置。
 */
export function webDir(): string {
  const env = process.env.QQBOT_WEB_DIR?.trim();
  if (env && env !== '') return env;

  const candidates = [
    resolve(process.cwd(), 'web', 'dist'),
    resolve(__dirname, '..', '..', 'web', 'dist'), // 源码态：src/config -> 仓库根
    resolve(__dirname, '..', 'web', 'dist'), // 打包态：dist/server.js -> /app/web/dist
  ];
  for (const c of candidates) {
    if (existsSync(join(c, 'index.html'))) return c;
  }
  return candidates[candidates.length - 1]!;
}

/**
 * 密钥文件路径。
 *
 * 历史上安装脚本写的是 etc/env，而 Go 版读的是 etc/secrets.env；
 * 这里两个都认，优先 secrets.env，避免老安装读不到密钥。
 */
export function secretsPath(): string {
  const preferred = join(root(), 'etc', 'secrets.env');
  if (existsSync(preferred)) return preferred;
  const legacy = join(root(), 'etc', 'env');
  if (existsSync(legacy)) return legacy;
  return preferred;
}

/**
 * 面板监听地址：环境变量 > TOML > 默认值。
 *
 * 环境变量压过 TOML 是刻意的——否则老安装里那份写着旧端口的 toml
 * 会让 compose 映射的新端口连不上，症状是「容器 healthy 但打不开」。
 */
function listenFromEnv(): string | undefined {
  const v = (process.env.QQBOT_LISTEN ?? process.env.QQBOT_PANEL_LISTEN)?.trim();
  return v && v !== '' ? v : undefined;
}

export function defaultConfig(): Config {
  const r = root();
  return {
    root: r,
    dataDir: join(r, 'data', 'qqbot'),
    log: { level: 'warn', format: 'text' },
    onebot: { url: 'ws://127.0.0.1:3001', accessToken: '' },
    panel: { listen: listenFromEnv() ?? DEFAULT_LISTEN },
    napcat: { webui: DEFAULT_NAPCAT_WEBUI },
  };
}

const KNOWN_KEYS = new Set([
  'data_dir',
  'log',
  'log.level',
  'log.format',
  'onebot',
  'onebot.url',
  'onebot.access_token',
  'panel',
  'panel.listen',
  'napcat',
  'napcat.webui',
]);

function collectUnknown(obj: unknown, prefix = ''): string[] {
  if (typeof obj !== 'object' || obj === null) return [];
  const out: string[] = [];
  for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
    const key = prefix === '' ? k : `${prefix}.${k}`;
    if (!KNOWN_KEYS.has(key)) out.push(key);
    else if (typeof v === 'object' && v !== null) out.push(...collectUnknown(v, key));
  }
  return out;
}

/**
 * 读取配置。文件不存在时返回默认配置并给出提示（不抛异常，方便 doctor 用）。
 * 返回值里的 warning 由调用方决定是否打印。
 */
export function loadConfig(path = configPath()): { config: Config; warning?: string } {
  const cfg = defaultConfig();
  if (!existsSync(path)) {
    return {
      config: cfg,
      warning: `配置文件不存在: ${path}（先运行 qqbot install）`,
    };
  }

  let doc: Record<string, unknown>;
  try {
    doc = parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  } catch (e) {
    throw new Error(`解析 ${path} 失败: ${(e as Error).message}`);
  }

  if (typeof doc.data_dir === 'string' && doc.data_dir !== '') {
    cfg.dataDir = doc.data_dir;
  }

  const log = doc.log as Record<string, unknown> | undefined;
  if (log) {
    if (typeof log.level === 'string' && log.level !== '') {
      cfg.log.level = log.level as LogLevel;
    }
    if (log.format === 'json' || log.format === 'text') {
      cfg.log.format = log.format;
    }
  }

  const onebot = doc.onebot as Record<string, unknown> | undefined;
  if (onebot) {
    if (typeof onebot.url === 'string') cfg.onebot.url = onebot.url;
    if (typeof onebot.access_token === 'string') cfg.onebot.accessToken = onebot.access_token;
  }

  const panel = doc.panel as Record<string, unknown> | undefined;
  if (panel && typeof panel.listen === 'string' && panel.listen !== '') {
    cfg.panel.listen = panel.listen;
  }

  const napcat = doc.napcat as Record<string, unknown> | undefined;
  if (napcat && typeof napcat.webui === 'string' && napcat.webui !== '') {
    cfg.napcat.webui = napcat.webui;
  }

  // 归一化 + 校验
  if (cfg.dataDir === '') cfg.dataDir = join(cfg.root, 'data', 'qqbot');
  if (cfg.onebot.url.trim() === '') throw new Error('onebot.url 不能为空');
  cfg.panel.listen = listenFromEnv() ?? (cfg.panel.listen || DEFAULT_LISTEN);

  // 协议端 WebUI 地址同样允许环境变量覆盖。
  // 容器里必须用 compose 服务名（http://napcat:6099）而不是 127.0.0.1，
  // 而配置文件是只读挂载的——用环境变量覆盖就不用为了换地址去改挂载文件。
  const webuiEnv = process.env.QQBOT_NAPCAT_WEBUI?.trim();
  if (webuiEnv && webuiEnv !== '') cfg.napcat.webui = webuiEnv;

  const unknown = collectUnknown(doc);
  const warning =
    unknown.length > 0 ? `警告: ${path} 中有未知配置项 ${unknown.join(', ')}，已忽略` : undefined;

  return { config: cfg, warning };
}

/** 把配置写回（安装脚本使用）。 */
export function saveConfig(cfg: Config, path = configPath()): void {
  const doc = {
    data_dir: cfg.dataDir,
    log: { level: cfg.log.level, format: cfg.log.format },
    onebot: { url: cfg.onebot.url, access_token: cfg.onebot.accessToken },
    panel: { listen: cfg.panel.listen },
    napcat: { webui: cfg.napcat.webui },
  };
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, stringify(doc), { mode: 0o644 });
}

/**
 * 密钥别名。
 *
 * 安装脚本与 compose 用的是短名（WEBUI_TOKEN），密钥盒里统一带 QQBOT_ 前缀。
 * 不归一的话，症状很隐蔽：面板能开、能登录，但「扫码」和「网络」两页
 * 永远显示未配置——因为服务端拿到的是空 token，而不是报错。
 */
const SECRET_ALIASES: Record<string, string> = {
  SECRET_KEY: 'QQBOT_SECRET_KEY',
  ONEBOT_TOKEN: 'QQBOT_ONEBOT_TOKEN',
  WEBUI_TOKEN: 'QQBOT_WEBUI_TOKEN',
};

/**
 * 读取密钥文件（KEY=VALUE 每行一条），并与进程环境合并。
 * 进程环境优先，便于 docker -e 覆盖。
 */
export function loadSecrets(path = secretsPath()): Record<string, string> {
  const secrets: Record<string, string> = {};
  if (existsSync(path)) {
    for (const rawLine of readFileSync(path, 'utf8').split('\n')) {
      const line = rawLine.trim();
      if (line === '' || line.startsWith('#')) continue;
      const idx = line.indexOf('=');
      if (idx < 0) continue;
      const k = line.slice(0, idx).trim();
      let v = line.slice(idx + 1).trim();
      if (
        (v.startsWith('"') && v.endsWith('"')) ||
        (v.startsWith("'") && v.endsWith("'"))
      ) {
        v = v.slice(1, -1);
      }
      secrets[k] = v;
    }
  }
  for (const k of ['QQBOT_SECRET_KEY', 'QQBOT_ONEBOT_TOKEN', 'QQBOT_WEBUI_TOKEN']) {
    const v = process.env[k];
    if (v !== undefined && v !== '') secrets[k] = v;
  }
  for (const [alias, canonical] of Object.entries(SECRET_ALIASES)) {
    const env = process.env[alias];
    if (env !== undefined && env !== '') secrets[canonical] = env;
    if (secrets[canonical] === undefined && secrets[alias] !== undefined) {
      secrets[canonical] = secrets[alias];
    }
  }
  return secrets;
}
