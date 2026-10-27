// 持久化层的公共类型。
//
// 这里的 JSON 键名必须与 Go 版逐字一致——面板前端直接消费这些字段，
// 改一个键就是白屏。

/** 模型接入配置。 */
export interface LLMSettings {
  base_url: string;
  api_key: string;
  model: string;
  temperature: number;
  max_tokens: number;
  /** false 时显式关闭思考模式（DeepSeek 默认开启，机器人场景必须关）。 */
  thinking: boolean;
  timeout_sec: number;
}

/** 触发与投递配置。 */
export interface BotSettings {
  wake_words: string[];
  passive_rate: number;
  group_cooldown_sec: number;
  max_concurrent: number;
  max_segments: number;
  seg_delay_min_ms: number;
  seg_delay_max_ms: number;
  whitelist_groups: number[];
  blacklist_users: number[];
  quote_reply: boolean;
}

/** 上下文窗口配置。 */
export interface ContextSettings {
  max_turns: number;
  token_budget: number;
}

/** 面板凭据配置。 */
export interface PanelSettings {
  admin_user: string;
  password_hash: string;
  totp_secret: string;
  totp_enabled: boolean;
}

/** 全部运行期设置，整体以一个 JSON 文档存放。 */
export interface Settings {
  llm: LLMSettings;
  bot: BotSettings;
  context: ContextSettings;
  panel: PanelSettings;
}

/** 出厂默认值。刻意保守：被动接话概率低、上下文预算小、思考模式关闭。 */
export function defaultSettings(): Settings {
  return {
    llm: {
      base_url: 'https://api.deepseek.com',
      api_key: '',
      model: 'deepseek-flash',
      temperature: 1.0,
      max_tokens: 512,
      thinking: false,
      timeout_sec: 60,
    },
    bot: {
      wake_words: [],
      passive_rate: 0.15,
      group_cooldown_sec: 30,
      max_concurrent: 3,
      max_segments: 4,
      seg_delay_min_ms: 300,
      seg_delay_max_ms: 800,
      whitelist_groups: [],
      blacklist_users: [],
      quote_reply: true,
    },
    context: {
      max_turns: 10,
      token_budget: 3000,
    },
    panel: {
      admin_user: 'admin',
      password_hash: '',
      totp_secret: '',
      totp_enabled: false,
    },
  };
}

/**
 * 把 nil 切片收敛成空数组。
 *
 * JSON 里 null 与 [] 反序列化后长度都是 0，但序列化出去一个 null 一个 []。
 * 前端拿到 null 直接 .map 会抛异常，所以对外统一成 []。
 */
export function normalizeSettings(v: Settings): Settings {
  if (!Array.isArray(v.bot.wake_words)) v.bot.wake_words = [];
  if (!Array.isArray(v.bot.whitelist_groups)) v.bot.whitelist_groups = [];
  if (!Array.isArray(v.bot.blacklist_users)) v.bot.blacklist_users = [];
  return v;
}

/** 深拷贝设置，避免调用方改到缓存。切片必须显式复制。 */
export function cloneSettings(v: Settings): Settings {
  return {
    llm: { ...v.llm },
    bot: {
      ...v.bot,
      wake_words: [...v.bot.wake_words],
      whitelist_groups: [...v.bot.whitelist_groups],
      blacklist_users: [...v.bot.blacklist_users],
    },
    context: { ...v.context },
    panel: { ...v.panel },
  };
}

export const DEFAULT_PERSONA_NAME = 'default';
export const DEFAULT_SYSTEM_PROMPT = 'You are a helpful assistant';

/** 一套人格设定。 */
export interface Persona {
  id: number;
  name: string;
  system_prompt: string;
  active: boolean;
  created_at: Date;
  updated_at: Date;
}

/** 一条会话消息。 */
export interface Message {
  id: number;
  session_id: string;
  role: string;
  content: string;
  tokens: number;
  created_at: Date;
}

/** 会话列表的一项。 */
export interface SessionInfo {
  id: string;
  kind: string;
  target_id: number;
  messages: number;
  updated_at: Date;
}

/** 某一天的用量汇总。 */
export interface UsageSummary {
  day: string;
  prompt_tokens: number;
  completion_tokens: number;
  requests: number;
  peak_requests: number;
  cost_cny: number;
}

/** 一条操作审计记录。 */
export interface AuditEntry {
  id: number;
  action: string;
  detail: string;
  remote: string;
  created_at: Date;
}

/** 拼接会话标识。群与私聊分开，避免同号冲突。 */
export function sessionId(kind: string, targetId: number): string {
  return `${kind}:${targetId}`;
}
