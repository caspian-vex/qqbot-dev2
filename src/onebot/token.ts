// OneBot 反向 WS 的访问令牌从哪来。
//
// 背景：协议端那条 3001 监听需要一个 access token，而面板上没有任何地方能填它
// （「网络」页只有一个裸 JSON 编辑器）。以前的做法是"没有就警告你一句"，可那句
// 警告没有出路：它让人去"为协议端配置 token"，而协议端的 token 必须和机器人
// 拨号时带的一致，机器人这边只认 etc/env 与 toml——两边各自去填，结果就是
// 握手 401 后无限退避重连，比不填更难排查。
//
// 所以改成服务端托管：自己生成、自己存、自己同步给协议端。
// 优先级 env > toml > 已保存 > 现场生成。前两个是"用户明确指定"，一旦设了就以
// 它为准且**不写库**——否则每次启动都会拿库里的旧值去覆盖用户的显式选择。
import { generateToken } from '../secret/box';

/** 令牌从哪来。日志与排障要靠它区分"用户设的"和"我们生成的"。 */
export type TokenSource = 'env' | 'toml' | 'stored' | 'generated' | 'generated-memory';

/**
 * 生成多少字节。16 字节 = 128 bit = 32 位十六进制。
 *
 * 与面板密码（`generateToken(16)`，见 main.ts 的 ensureAdminPassword）同档：
 * 这个令牌走的是容器内网的明文 WS，不是公网 HTTPS，再长也没有额外收益。
 */
export const TOKEN_BYTES = 16;

/** 只用到这三个级别，收窄接口是为了测试能塞一个假 logger。 */
export interface TokenLogger {
  debug(msg: string, attrs?: Record<string, unknown>): void;
  info(msg: string, attrs?: Record<string, unknown>): void;
  warn(msg: string, attrs?: Record<string, unknown>): void;
}

export interface ResolveTokenOptions {
  /** etc/env（含 etc/secrets.env 与同名进程环境变量）里的 QQBOT_ONEBOT_TOKEN。 */
  env: string;
  /** etc/qqbot.toml 的 onebot.access_token。 */
  toml: string;
  /** 读已保存的值。返回值应已解密（SettingsRepo 的 get 就是这么给的）。 */
  read: () => string;
  /** 写回。加密由 SettingsRepo 负责，这里传明文。 */
  write: (token: string) => void;
  log: TokenLogger;
  /** 测试注入；默认 32 位十六进制。 */
  generate?: () => string;
}

export interface ResolvedToken {
  token: string;
  source: TokenSource;
}

/**
 * 决定本次进程用哪个令牌。
 *
 * 只有走到"现场生成"这一步才会写库，写入失败也不抛：面板与收发消息都还要用，
 * 为了一次落盘失败把进程拦死，等于把一个能在日志里说清的故障变成"打不开面板、
 * 只能删库"。降级成内存令牌后仍然会同步给协议端，本次运行两端是一致的。
 */
export function resolveOnebotToken(o: ResolveTokenOptions): ResolvedToken {
  const env = o.env.trim();
  if (env !== '') {
    o.log.debug('OneBot 访问令牌来自 etc/env（QQBOT_ONEBOT_TOKEN）', { source: 'env' });
    return { token: env, source: 'env' };
  }

  const toml = o.toml.trim();
  if (toml !== '') {
    o.log.debug('OneBot 访问令牌来自 etc/qqbot.toml 的 onebot.access_token', { source: 'toml' });
    return { token: toml, source: 'toml' };
  }

  let stored = '';
  try {
    stored = o.read().trim();
  } catch (e) {
    // 读不出来就当作"还没生成过"。重生成一次是安全的：新值会被同步给协议端，
    // 代价只是协议端多重启一次 OneBot 服务。
    o.log.warn('读取已保存的 OneBot 访问令牌失败，将重新生成', { err: e });
  }
  if (stored !== '') {
    o.log.debug('使用已保存的 OneBot 访问令牌', { source: 'stored' });
    return { token: stored, source: 'stored' };
  }

  const fresh = (o.generate ?? (() => generateToken(TOKEN_BYTES)))();
  try {
    o.write(fresh);
    o.log.info('已生成 OneBot 访问令牌并加密保存，登录后会自动同步到协议端 3001 监听', {
      source: 'generated',
    });
    return { token: fresh, source: 'generated' };
  } catch (e) {
    o.log.warn(
      'OneBot 访问令牌无法保存（数据目录或数据库不可写），本次仅在内存中使用；进程重启后会重新生成并再次同步协议端',
      { err: e },
    );
    return { token: fresh, source: 'generated-memory' };
  }
}
