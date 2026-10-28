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

/**
 * 主动发言配置。
 *
 * 目前只有「回声式跟进」：回复完用户后隔一小会儿，主动补一句相关的话。
 * 这是主动消息里风险最低的一种——对话刚发生、对方明确在聊，
 * 所以敢做成默认可开的功能（但出厂仍是关的，让用户自己决定）。
 */
export interface ProactiveSettings {
  /** 是否允许回复后延迟补一句。 */
  echo_enabled: boolean;
  /** 每次回复后触发跟进的概率，0-1。 */
  echo_rate: number;
  /** 延迟下限（秒）。真人不会秒回自己，也不会掐着整点补话。 */
  echo_min_sec: number;
  /** 延迟上限（秒），实际延迟在 [min, max] 内均匀采样。 */
  echo_max_sec: number;
  /** 同一会话两次跟进的最小间隔（分钟），0 表示不限制。 */
  echo_cooldown_min: number;
  /** 全局每日跟进上限（跨会话累计），防刷屏与风控的硬闸。 */
  echo_daily_limit: number;
}

/**
 * 图池配置。
 *
 * 图池是数据目录下的 images/ 文件夹，用户放图进去即可。
 * 模型在回复里用 [图:文件名] 标记表达"想发图"，由引擎解析发送。
 * 池子为空时功能天然无效，但开关仍默认关闭——
 * 与回声式跟进同一哲学：新能力出厂全关，让用户自己决定。
 */
export interface ImageSettings {
  /** 是否允许模型在回复里发图。 */
  enabled: boolean;
  /** 单条回复最多发几张图（标记超出部分丢弃）。 */
  max_per_reply: number;
}

/** 上下文窗口配置。 */
export interface ContextSettings {
  max_turns: number;
  token_budget: number;
}

/**
 * 图片识别配置。
 *
 * 用户发图时把图下载下来随消息一起交给模型（OpenAI 兼容的 image_url 块）。
 * 出厂默认开启：默认模型本身支持看图，而"发了图机器人装没看见"是最劝退的体验。
 * 用的是纯文字模型的话，在面板里关掉即可——关掉后图片段仅被忽略，不影响文字回复。
 */
export interface VisionSettings {
  /** 是否把用户发来的图交给模型看。 */
  enabled: boolean;
  /** 单条消息最多看几张（多出来的直接丢，不下载）。 */
  max_images: number;
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
  proactive: ProactiveSettings;
  images: ImageSettings;
  vision: VisionSettings;
  context: ContextSettings;
  panel: PanelSettings;
}

/** 主动发言的出厂默认值。功能关闭、概率保守、上限收紧。 */
export function defaultProactive(): ProactiveSettings {
  return {
    echo_enabled: false,
    echo_rate: 0.35,
    echo_min_sec: 30,
    echo_max_sec: 90,
    echo_cooldown_min: 30,
    echo_daily_limit: 5,
  };
}

/** 图池的出厂默认值。功能关闭，单条回复至多一张图。 */
export function defaultImages(): ImageSettings {
  return {
    enabled: false,
    max_per_reply: 1,
  };
}

/**
 * 图片识别的出厂默认值。
 *
 * 这个块与主动发言、图池不同，出厂是**开**的：默认模型就能看图，
 * 而"用户发了图，机器人当作没看见"是最劝退的体验。
 * 关掉只是一次勾选，误开的代价（多花一点 token）比对不上。
 */
export function defaultVision(): VisionSettings {
  return {
    enabled: true,
    max_images: 4,
  };
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
    proactive: defaultProactive(),
    images: defaultImages(),
    vision: defaultVision(),
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
  // 旧库没有 proactive 块：整个补成默认值。字段级合并没必要——
  // 这个块只能从面板整块保存，不存在"半新半旧"的中间态。
  if (v.proactive === undefined || v.proactive === null || typeof v.proactive !== 'object') {
    v.proactive = defaultProactive();
  }
  // 旧库没有 images 块：整个补成默认值，理由同 proactive。
  if (v.images === undefined || v.images === null || typeof v.images !== 'object') {
    v.images = defaultImages();
  }
  // 旧库没有 vision 块：整个补成默认值，理由同 proactive。
  // 这个块补上之后旧部署是"开启"状态，与出厂默认一致——
  // 图片识别本来就是用户升级后想要的，不该升级完还得去点一下。
  if (v.vision === undefined || v.vision === null || typeof v.vision !== 'object') {
    v.vision = defaultVision();
  }
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
    proactive: { ...v.proactive },
    images: { ...v.images },
    vision: { ...v.vision },
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
