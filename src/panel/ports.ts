// 面板依赖的外部能力接口。
//
// 面板不直接 import onebot/bot 模块，而是依赖这两个端口：
//   1. 面板可以脱离真实 OneBot 连接单独测试（P2 阶段还没有客户端）
//   2. 避免循环依赖——引擎将来也会用到面板的 hub
// 时间字段统一用 RFC3339 字符串：序列化是协议端的事，
// 面板只负责搬运，不参与格式转换。

import type { NapCatNetworkConfig, QQInfo, QQLoginStatus, QuickLoginItem } from '../napcat/webui';

/** 协议端连接状态。JSON 键与 Go 版 Status 一致。 */
export interface BotStatus {
  connected: boolean;
  self_id: number;
  nickname: string;
  /** RFC3339；未连接时为零值 */
  connected_at: string;
  /** RFC3339；未收到事件时为零值 */
  last_event_at: string;
  reconnects: number;
  last_error: string;
}

/** 引擎计数器。JSON 键与 Go 版 Snapshot 一致。 */
export interface EngineStats {
  received: number;
  replied: number;
  ignored: number;
  dropped: number;
  errors: number;
  /** RFC3339；从未回复时为零值 */
  last_reply_at: string;
}

export interface GroupInfo {
  group_id: number;
  group_name: string;
  member_count: number;
  max_member_count: number;
}

export interface FriendInfo {
  user_id: number;
  nickname: string;
  remark: string;
}

/** 协议端动作。对应 Go 的 onebot.Client。 */
export interface OneBotPort {
  status(): BotStatus;
  /** get_status 探测账号是否在线（连接在但 QQ 掉线时 connected 仍为 true）。 */
  getOnline(signal?: AbortSignal): Promise<boolean>;
  sendGroupMsg(groupId: number, text: string, signal?: AbortSignal): Promise<number>;
  sendPrivateMsg(userId: number, text: string, signal?: AbortSignal): Promise<number>;
  getGroupList(signal?: AbortSignal): Promise<GroupInfo[]>;
  getFriendList(signal?: AbortSignal): Promise<FriendInfo[]>;
}

/** 消息处理引擎。对应 Go 的 bot.Engine。 */
export interface EnginePort {
  stats(): EngineStats;
  /** 去重表当前条目数（诊断用，用来判断是否在泄漏内存）。 */
  dedupeSize(): number;
  /**
   * 立即整理某个会话的记忆（面板上的「立即整理」）。
   *
   * 可选：不是所有实现都需要它（测试里的空引擎、以及将来可能的其他宿主）。
   * 缺省时面板对这一项返回 501，而不是假装成功——用户点了一次什么都没发生，
   * 比明确说"这个宿主不支持"更让人迷惑。
   */
  digestMemory?(sessionID: string): Promise<{
    ok: boolean;
    added: number;
    summary: string;
    reason?: string;
  }>;
  /**
   * 暂停 / 恢复机器人（面板上的总开关）。
   *
   * 状态本身存在设置里，引擎每次自己读；这个方法只是"切换之后顺带做点内存侧
   * 清理"的钩子，目前是清掉已挂定时器的待发跟进。可选：没有它，暂停依然生效，
   * 只是恢复瞬间可能冒出几句排队中的话。
   */
  setEnabled?(on: boolean): void;
}

/**
 * 协议端的 WebUI 控制能力（扫码登录 QQ）。
 *
 * 抽成接口而不是让面板直接依赖 NapCatWebUI：面板只关心"要二维码、
 * 看状态"，至于背后是 NapCat 还是别的协议端，与它无关。
 */
export interface QQLoginPort {
  /** 是否配置了 WebUI 地址与 token。 */
  readonly configured: boolean;
  status(): Promise<QQLoginStatus>;
  /**
   * 登录二维码。
   *
   * `logined: true` 表示协议端说"已经是登录状态了，不发码"——不是错误，
   * 面板据此收起登录卡片并同步一次状态。
   *
   * `force: true` 会让协议端**重建**二维码。必须能重建：二维码约 2 分钟失效，
   * 而只是重复读取拿到的永远是缓存里那张死码（这就是"过期后点刷新没反应"）。
   * `stale: true` 表示刷新请求已发出但协议端没给出新码，面板要如实提示。
   */
  qrcode(opts?: { force?: boolean }): Promise<{
    image: string;
    content: string;
    logined: boolean;
    stale: boolean;
  }>;
  loginInfo(): Promise<QQInfo>;
  quickLoginList(): Promise<QuickLoginItem[]>;
  quickLogin(uin: string): Promise<void>;
  logout(): Promise<void>;
  /** OneBot11 网络配置（协议端「高级网络配置」）。要求 QQ 已登录。 */
  networkConfig(): Promise<NapCatNetworkConfig>;
  setNetworkConfig(config: Record<string, unknown>, asString: boolean): Promise<void>;
}

/** 未配置协议端 WebUI 时的占位实现。 */
export function nullQQLogin(): QQLoginPort {
  const fail = (): Promise<never> => Promise.reject(new Error('未配置协议端 WebUI'));
  return {
    configured: false,
    status: () =>
      Promise.resolve({ login: false, offline: false, uin: '', nick: '', phase: '', error: '' }),
    qrcode: fail,
    loginInfo: () => Promise.resolve({ uin: '', nick: '' }),
    quickLoginList: () => Promise.resolve([]),
    quickLogin: fail,
    logout: fail,
    networkConfig: fail,
    setNetworkConfig: fail,
  };
}

/** 一个什么都不做的协议端，用于单元测试与「未配置」状态。 */
export function nullOneBot(): OneBotPort {
  const fail = (): Promise<never> => Promise.reject(new Error('协议端未连接'));
  return {
    status: () => ({
      connected: false,
      self_id: 0,
      nickname: '',
      connected_at: '0001-01-01T00:00:00Z',
      last_event_at: '0001-01-01T00:00:00Z',
      reconnects: 0,
      last_error: '',
    }),
    getOnline: () => Promise.resolve(false),
    sendGroupMsg: fail,
    sendPrivateMsg: fail,
    // 拉列表失败而不是返回空数组：与 Go 版一致（未连接时动作调用直接报错），
    // 前端据此提示"协议端未连接"，而不是显示一个空群列表让人以为机器人没进群
    getGroupList: fail,
    getFriendList: fail,
  };
}

/** 一个什么都不做的引擎，用于单元测试。 */
export function nullEngine(): EnginePort {
  return {
    stats: () => ({
      received: 0,
      replied: 0,
      ignored: 0,
      dropped: 0,
      errors: 0,
      last_reply_at: '0001-01-01T00:00:00Z',
    }),
    dedupeSize: () => 0,
  };
}
