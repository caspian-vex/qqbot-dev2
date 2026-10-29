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
  /**
   * 本会话每日跟进上限，防刷屏与风控的硬闸。
   *
   * 曾经是"全局累计"，改成按会话之后才能按会话覆盖——否则群 1 把上限
   * 调到 20 会吃掉私聊的额度，用户看到的是"我明明设了 20，第三条就不补了"，
   * 覆盖像是没生效。总量另有进程级硬顶兜底（引擎的 ECHO_DAILY_HARD_CAP）。
   */
  echo_daily_limit: number;

  // ---- 以下为「闲置唤醒」——目前唯一一种真正的主动开口 ----
  //
  // 与回声跟进的差别：跟进发生在"刚聊完"，对方明确还在；闲置唤醒发生在
  // "对方说完最后一句、机器人没接住"之后，隔了一段时间再回头补。
  // 后者更自然，也更危险（可能已经没人在了），所以默认值更保守：
  // 只看私聊、默认 45 分钟、每天几条。

  /**
   * 对方说完最后一句、隔多少分钟后可以主动开口。0 表示关闭。
   *
   * 只对**私聊**生效：群里机器人突然插话是扰民，且更容易被判定为营销号。
   * 群里的主动消息只能来自模型自己排的闹钟（schedule_message）。
   */
  idle_after_min: number;
  /** 满足闲置条件后仍要掷一次骰子，0-1。 */
  idle_rate: number;
  /** 本会话每日主动开口上限（含闹钟发的），0 表示关闭。 */
  proactive_daily_limit: number;
  /**
   * 免打扰时段：从 quiet_start_hour 到 quiet_end_hour 之间不主动说话（本地时区）。
   * 两个值相等表示不启用。支持跨零点的窗（23 → 8）。
   */
  quiet_start_hour: number;
  quiet_end_hour: number;
}

/**
 * 拟人节奏配置：怎么"把字打出来"。
 *
 * 与主动发言分开：那个决定**说不说**，这个决定**说完之后看起来像不像人**。
 * 两者混成一块的话，想关掉"主动插话"的人会连打字节奏一起丢掉。
 *
 * 出厂**开**着，与主动发言不同。理由：这不会让机器人多说一个字，
 * 只是把已有回复的时序改得像人，风险为零；默认关掉等于用户
 * 永远看不到这个能力——而"一问一答太假"正是最劝退的体验。
 */
export interface TimingSettings {
  /** 关掉即回到旧行为：收到消息立刻发，段间只按 seg_delay_* 抖一下。 */
  enabled: boolean;
  /** 「看到消息」到「开始打字」的停顿下限（毫秒）。 */
  think_min_ms: number;
  /** 同上，上限。采样落在 [min, max]，带长尾。 */
  think_max_ms: number;
  /** 打字速度（字/秒）。中文按字、英文按半字计。 */
  typing_cps: number;
  /** 整条回复"晚点再发"的概率，0 表示永不迟到。 */
  late_rate: number;
  /** 迟到时长的下限（秒）。 */
  late_min_sec: number;
  /** 迟到时长的上限（秒）。**不要调得很大**：迟到的回复比不回复更糟。 */
  late_max_sec: number;
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

/**
 * 联网搜索配置。
 *
 * 走的是 OpenAI 兼容的 function calling：把 web_search 作为一个工具交给模型，
 * 由它判断"这句话要不要查"。不做关键词猜谜——猜错了要么把闲聊变成念新闻，
 * 要么该查的时候不查。代价是模型侧必须支持工具调用（主流模型都已经支持，
 * 不支持时会自动退回普通对话，不会把回复链路搞挂）。
 *
 * 搜索后端固定用 DeepSeek 官方 Search API，和模型共用一个 API Key，
 * 所以这里没有 provider / api_key / base_url——没得选，也就不需要配。
 *
 * 出厂关闭：每次搜索都单独计费，默认替用户花钱不合适。
 */
export interface SearchSettings {
  /** 是否允许模型联网搜索。 */
  enabled: boolean;
  /** 每次搜索取几条结果（1-10）。 */
  max_results: number;
  /** 单次搜索的超时（秒）。搜索是回复链路里的串行等待，别给太久。 */
  timeout_sec: number;
  /** 一条回复里最多搜几次（1-3）。这是成本的硬闸。 */
  max_calls: number;
}

/**
 * 电脑操作：把容器内的 shell 与文件系统交给模型。
 *
 * 这一块是整套设置里唯一「开对了没感觉、开错了直接丢机器」的开关，
 * 所以默认全关、默认每次执行都要批准，并且把「谁能触发」做成部署级字段
 * （不参与按会话覆盖：会话能改白名单，等于被拉进来的人自己决定还能拉谁）。
 *
 * 边界说明：机器人跑在容器里（alpine、非 root 的 node 用户），
 * 「完全放开」指的是不限制路径，不是指能动宿主机——没有挂载就够不着。
 */
export interface ComputerSettings {
  /** 是否允许模型操作这台机器。关掉时工具根本不下发给模型。 */
  enabled: boolean;
  /** 主人 QQ：私聊时始终可用。0 表示不设主人，只靠白名单。 */
  owner_qq: number;
  /**
   * 默认工作目录。空串表示用数据目录（/opt/qqbot/data）。
   * 它同时是相对路径的解析起点和命令的 cwd。
   */
  workdir: string;
  /** 单条命令的超时（秒）。 */
  timeout_sec: number;
  /** 一条消息里最多执行几次（搜索之外独立计数）。 */
  max_calls: number;
  /** 每次执行前是否需要在面板点批准。关掉就是全自动，没有第二次机会。 */
  require_approval: boolean;
  /** 等待批准的秒数，超时按拒绝处理。 */
  approval_timeout_sec: number;
  /** 额外允许的好友 QQ（私聊）。 */
  allow_users: number[];
  /** 额外允许的群号：群内只有群主/管理员能触发。 */
  allow_groups: number[];
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
  timing: TimingSettings;
  images: ImageSettings;
  vision: VisionSettings;
  search: SearchSettings;
  computer: ComputerSettings;
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
    // 闲置唤醒出厂也是关的：这是唯一一种"没人说话时机器人自己开口"的能力，
    // 要不要让一个号在你的好友列表里主动发消息，得你自己决定。
    idle_after_min: 0,
    idle_rate: 0.3,
    proactive_daily_limit: 3,
    quiet_start_hour: 23,
    quiet_end_hour: 8,
  };
}

/**
 * 拟人节奏的出厂默认值。
 *
 * 数值都取"能看出人味、又不至于让人等"的那一档：
 * 思考 0.4-2.4 秒、5 字/秒，一条 20 字的回复大约等 4-6 秒。
 * 再慢就进入"这机器人是不是卡了"的区间，比机械更糟。
 * 迟发默认 10%、最多 5 分钟，且会被新消息打断（见引擎的 waitLate）。
 */
export function defaultTiming(): TimingSettings {
  return {
    enabled: true,
    think_min_ms: 400,
    think_max_ms: 2400,
    typing_cps: 5,
    late_rate: 0.1,
    late_min_sec: 60,
    late_max_sec: 300,
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

/**
 * 联网搜索的出厂默认值。
 *
 * 关着，而且除 provider 外都是保守值：搜索是一次额外的外部请求，
 * 既花钱又多一跳延迟，该由用户明确开启。
 */
export function defaultSearch(): SearchSettings {
  return {
    enabled: false,
    max_results: 5,
    timeout_sec: 8,
    max_calls: 2,
  };
}

/**
 * 电脑操作的出厂默认值。
 *
 * 全关、无主人、无白名单——开着它就意味着「某个 QQ 能在这台机器上执行命令」，
 * 这种能力不能靠安装脚本替用户默认打开。批准也必须默认开：
 * 关掉批准等于把面板上那一次点击也省了，出事时没有任何人工环节。
 */
export function defaultComputer(): ComputerSettings {
  return {
    enabled: false,
    owner_qq: 0,
    workdir: '',
    timeout_sec: 20,
    max_calls: 1,
    require_approval: true,
    approval_timeout_sec: 90,
    allow_users: [],
    allow_groups: [],
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
    timing: defaultTiming(),
    images: defaultImages(),
    vision: defaultVision(),
    search: defaultSearch(),
    computer: defaultComputer(),
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
  } else {
    // 块在、但缺后加的字段（老库升上来的常态）：逐字段兜。
    // 这里是**必须**的，不是洁癖：idle_after_min 为 undefined 时
    // `undefined <= 0` 是 false，闲置唤醒会被当成"开着"，随后拿
    // NaN 去比时间——表现是开机就对着几个老会话乱发消息。
    const dp = defaultProactive();
    const p = v.proactive;
    const nums: [keyof ProactiveSettings, number][] = [
      ['echo_rate', dp.echo_rate],
      ['echo_min_sec', dp.echo_min_sec],
      ['echo_max_sec', dp.echo_max_sec],
      ['echo_cooldown_min', dp.echo_cooldown_min],
      ['echo_daily_limit', dp.echo_daily_limit],
      ['idle_after_min', dp.idle_after_min],
      ['idle_rate', dp.idle_rate],
      ['proactive_daily_limit', dp.proactive_daily_limit],
      ['quiet_start_hour', dp.quiet_start_hour],
      ['quiet_end_hour', dp.quiet_end_hour],
    ];
    for (const [k, fallback] of nums) {
      if (!Number.isFinite(p[k])) (p[k] as number) = fallback;
    }
    if (typeof p.echo_enabled !== 'boolean') p.echo_enabled = dp.echo_enabled;
  }
  // 旧库没有 timing 块：整块补默认值（开着的）。补上之后升级即生效，
  // 不需要用户再去点一下——这正是他想解决的问题。
  if (v.timing === undefined || v.timing === null || typeof v.timing !== 'object') {
    v.timing = defaultTiming();
  } else {
    // 字段级兜底在这里比别的块更要紧：NaN 进 setTimeout 会 1 毫秒触发，
    // 表现成"每条都秒回"；typing_cps 为 0 则让打字耗时变成 Infinity 再被截断，
    // 表面看是"每条都等满 8 秒"。这类故障看起来像玄学，其实是脏数据。
    const dt = defaultTiming();
    const t = v.timing;
    if (typeof t.enabled !== 'boolean') t.enabled = dt.enabled;
    if (!Number.isFinite(t.think_min_ms)) t.think_min_ms = dt.think_min_ms;
    if (!Number.isFinite(t.think_max_ms)) t.think_max_ms = dt.think_max_ms;
    if (!Number.isFinite(t.typing_cps) || t.typing_cps <= 0) t.typing_cps = dt.typing_cps;
    if (!Number.isFinite(t.late_rate)) t.late_rate = dt.late_rate;
    if (!Number.isFinite(t.late_min_sec)) t.late_min_sec = dt.late_min_sec;
    if (!Number.isFinite(t.late_max_sec)) t.late_max_sec = dt.late_max_sec;
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
  // 旧库没有 search 块：整块补默认值（关着的），升级不会突然开始对外发请求。
  if (v.search === undefined || v.search === null || typeof v.search !== 'object') {
    v.search = defaultSearch();
  } else {
    // 块在但字段缺（手改过库、跨版本升级）：逐字段兜。别的块缺字段最坏是
    // 显示难看，这里缺 max_calls 会让引擎算出 NaN，工具循环直接转会死。
    const ds = defaultSearch();
    if (typeof v.search.enabled !== 'boolean') v.search.enabled = ds.enabled;
    // 老库里可能留着 provider / api_key / base_url（上一版接第三方搜索源时写的）。
    // 留着不会报错，但会把已经作废的凭证继续写进 JSON，下次读还得再兜一遍，
    // 索性在这里清掉：搜索后端只剩一家，这几个字段已经没有含义了。
    const legacy = v.search as unknown as Record<string, unknown>;
    delete legacy['provider'];
    delete legacy['api_key'];
    delete legacy['base_url'];
    if (!Number.isFinite(v.search.max_results)) v.search.max_results = ds.max_results;
    if (!Number.isFinite(v.search.timeout_sec)) v.search.timeout_sec = ds.timeout_sec;
    if (!Number.isFinite(v.search.max_calls)) v.search.max_calls = ds.max_calls;
  }
  // 旧库没有 computer 块：整块补默认值（关着的）。升级不该悄悄把 shell 交出去。
  if (v.computer === undefined || v.computer === null || typeof v.computer !== 'object') {
    v.computer = defaultComputer();
  } else {
    // 字段级兜底在这里比别的块更要紧：timeout_sec 是 NaN 时 setTimeout 会
    // 1 毫秒就触发，表现成「每条命令都超时」；approval_timeout_sec 同理，
    // 会让审批永远来不及点。这类故障看起来像玄学，其实是脏数据。
    const dc = defaultComputer();
    const c = v.computer;
    if (typeof c.enabled !== 'boolean') c.enabled = dc.enabled;
    if (!Number.isSafeInteger(c.owner_qq) || c.owner_qq < 0) c.owner_qq = dc.owner_qq;
    if (typeof c.workdir !== 'string') c.workdir = dc.workdir;
    if (typeof c.require_approval !== 'boolean') c.require_approval = dc.require_approval;
    if (!Number.isFinite(c.timeout_sec)) c.timeout_sec = dc.timeout_sec;
    if (!Number.isFinite(c.max_calls)) c.max_calls = dc.max_calls;
    if (!Number.isFinite(c.approval_timeout_sec)) c.approval_timeout_sec = dc.approval_timeout_sec;
    if (!Array.isArray(c.allow_users)) c.allow_users = [];
    if (!Array.isArray(c.allow_groups)) c.allow_groups = [];
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
    timing: { ...v.timing },
    images: { ...v.images },
    vision: { ...v.vision },
    search: { ...v.search },
    computer: {
      ...v.computer,
      allow_users: [...v.computer.allow_users],
      allow_groups: [...v.computer.allow_groups],
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
  /** 绑定的 人格 id；0 表示跟随全局启用的人格。 */
  persona_id: number;
  /** 绑定的人格名；未绑定时为空串（前端据此显示"跟随默认"）。 */
  persona_name: string;
  /**
   * 对话对象的名字：群聊是群名，私聊是对方的昵称。
   *
   * 两个来源，谁有值用谁：普通会话是说话时记下的（sessions.name），
   * 预设行是绑定时存下的快照（session_personas.target_name）。
   * 两边都空时缺省——老会话、命名失败时都会这样，前端再拉一次
   * 群/好友列表兜底，实在没有就显示号码本身。
   */
  name?: string;
  /**
   * 尚未产生任何消息、只预置了人格的对话对象。
   *
   * sessions 里没有它的行（那张表要收到第一条消息才 touch 出来），
   * 面板得靠这个标记区分"从没说过话"和"清空过的会话"——后者虽然
   * 也是 0 条消息，但会话本身是存在的，能查看能清空。
   */
  preset?: boolean;
  /**
   * 这个会话是否有一套自己的设置（session_settings 里有行）。
   *
   * 只用于列表上标"独立"，不参与引擎判断——引擎每次自己去解析，
   * 不看这个标记（否则列表读慢一点就会影响回复行为）。
   */
  overrides?: boolean;
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

/**
 * 反解会话标识，非法返回 null。
 *
 * 只在"用户填进来的 ID"上用（面板预设人格、接口入参）。引擎自己拼的 ID
 * 不必再解一遍，那里从事件直接拿 kind/target 更可靠。
 *
 * 严格到这个程度是因为它的输出会直接变成数据库主键：放过一个
 * `group:abc`，就会留下一条永远匹配不上的行，而用户看到的反馈是"成功"。
 */
export function parseSessionId(id: string): { kind: string; targetId: number } | null {
  const i = id.indexOf(':');
  if (i <= 0) return null;
  const kind = id.slice(0, i);
  if (kind !== 'group' && kind !== 'private') return null;
  const raw = id.slice(i + 1);
  // 只收纯数字：Number(' 12 ') 和 Number('12abc') 都能过，但这里不该放过
  if (!/^\d+$/.test(raw)) return null;
  const targetId = Number(raw);
  if (!Number.isSafeInteger(targetId) || targetId <= 0) return null;
  return { kind, targetId };
}
