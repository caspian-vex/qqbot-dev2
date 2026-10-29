// 按对话对象的设置覆盖。
//
// 全局设置仍是唯一真相，会话只持有"我自己这一套"的整组快照。
// 两者在引擎入口合成一份完整 Settings 再往下传——下游
// filter/vision/search/ctxmgr 全都只认配置对象，不关心它从哪来。
//
// 这里刻意分成两半：
//   normalizeOverrides  把外来 JSON 收敛成可信结构（缺字段用全局补全）
//   resolveSettings     把全局 + 覆盖合成生效值（纯函数，不改入参）
// 两半都不碰数据库，所以能在没有 Store 的情况下单测。

import {
  cloneSettings,
  type BotSettings,
  type ComputerSettings,
  type ContextSettings,
  type ImageSettings,
  type ProactiveSettings,
  type SearchSettings,
  type Settings,
  type VisionSettings,
} from './types';

/**
 * 「触发规则」允许按会话覆盖的字段。
 *
 * 刻意是两个 Pick 之外再排除两个，而不是整块 BotSettings：
 *   - max_concurrent 是队列级参数（引擎里只有一个 TaskQueue），
 *     按会话设没有意义——队列是进程共享的。
 *   - whitelist_groups 是部署级总闸（"这台机器只服务这几个群"），
 *     它本身就是"全局范围"的定义。会话级再写一份，要么是空操作
 *     （本会话必然已在名单内），要么等于让一个会话改写主人的封锁边界。
 *
 * blacklist_users 在：但语义是"只能追加"——见 resolveSettings 里的并集。
 */
export type SessionBotOverride = Pick<
  BotSettings,
  | 'wake_words'
  | 'passive_rate'
  | 'group_cooldown_sec'
  | 'max_segments'
  | 'seg_delay_min_ms'
  | 'seg_delay_max_ms'
  | 'quote_reply'
  | 'blacklist_users'
>;

/**
 * 「电脑操作」允许按会话覆盖的字段。
 *
 * 只有这三个进得去：能不能用、一次消息执行几次、单条命令多久超时。
 * 主人 QQ、白名单、工作目录、是否批准全部留在全局——
 * 会话能改白名单，等于被拉进来的人自己决定还能拉谁进来；
 * 会话能关批准，等于把唯一的人工环节交给触发者自己。
 */
export type SessionComputerOverride = Pick<ComputerSettings, 'enabled' | 'max_calls' | 'timeout_sec'>;

/**
 * 一个会话的覆盖。
 *
 * 组的键出现即代表"本会话单独设置"，组内必须字段全量（服务端负责补全）。
 * 存 diff 的话，打开开关后全局改一个"未被覆盖"的字段仍会影响该会话 ——
 * 那就违背了"勾上之后整组不再跟随全局"这个承诺。
 *
 * llm 与 panel 永不出现：API Key 与管理员凭据是部署级的，复制到每个会话
 * 会变成 N 份密文，轮换时得挨个点，还多出 N 个泄露面。
 */
export interface SessionOverrides {
  bot?: SessionBotOverride;
  proactive?: ProactiveSettings;
  images?: ImageSettings;
  vision?: VisionSettings;
  search?: SearchSettings;
  computer?: SessionComputerOverride;
  context?: ContextSettings;
}

/** 可覆盖的组。顺序即面板卡片顺序。 */
export const OVERRIDABLE_GROUPS = [
  'bot',
  'proactive',
  'images',
  'vision',
  'search',
  'computer',
  'context',
] as const;

export type OverridableGroup = (typeof OVERRIDABLE_GROUPS)[number];

/** 组的中文名，报错文案与审计详情共用，避免两处各写一份。 */
export const GROUP_LABELS: Record<OverridableGroup, string> = {
  bot: '触发规则',
  proactive: '主动发言',
  images: '图池',
  vision: '图片识别',
  search: '联网搜索',
  computer: '电脑操作',
  context: '上下文',
};

type FieldKind = 'bool' | 'num' | 'strList' | 'numList';

/**
 * 每组允许出现的字段名及其类型。
 *
 * 面板拿它拒白名单外的字段（传 max_concurrent 要 400 而不是静默丢弃），
 * 存储层拿它做类型护栏，测试拿它做覆盖度断言——三处共用一份，
 * 避免"类型允许但校验拒绝"这种漂移。
 */
export const OVERRIDE_FIELDS: Record<OverridableGroup, Record<string, FieldKind>> = {
  bot: {
    wake_words: 'strList',
    passive_rate: 'num',
    group_cooldown_sec: 'num',
    max_segments: 'num',
    seg_delay_min_ms: 'num',
    seg_delay_max_ms: 'num',
    quote_reply: 'bool',
    blacklist_users: 'numList',
  },
  proactive: {
    echo_enabled: 'bool',
    echo_rate: 'num',
    echo_min_sec: 'num',
    echo_max_sec: 'num',
    echo_cooldown_min: 'num',
    echo_daily_limit: 'num',
    idle_after_min: 'num',
    idle_rate: 'num',
    proactive_daily_limit: 'num',
    quiet_start_hour: 'num',
    quiet_end_hour: 'num',
  },
  images: { enabled: 'bool', max_per_reply: 'num' },
  vision: { enabled: 'bool', max_images: 'num' },
  search: { enabled: 'bool', max_results: 'num', timeout_sec: 'num', max_calls: 'num' },
  computer: { enabled: 'bool', max_calls: 'num', timeout_sec: 'num' },
  context: { max_turns: 'num', token_budget: 'num' },
};

/** 每组允许的字段名清单（顺序稳定，供报错文案与界面对齐）。 */
export function overrideKeys(g: OverridableGroup): string[] {
  return Object.keys(OVERRIDE_FIELDS[g]);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** QQ 号：正整数。与面板 isQQList 同一条判据。 */
function isQQ(n: unknown): boolean {
  return typeof n === 'number' && Number.isSafeInteger(n) && n > 0;
}

/** 从整块 BotSettings 里挑出可覆盖的那部分。 */
export function pickBot(b: BotSettings): SessionBotOverride {
  return {
    wake_words: [...b.wake_words],
    passive_rate: b.passive_rate,
    group_cooldown_sec: b.group_cooldown_sec,
    max_segments: b.max_segments,
    seg_delay_min_ms: b.seg_delay_min_ms,
    seg_delay_max_ms: b.seg_delay_max_ms,
    quote_reply: b.quote_reply,
    blacklist_users: [...b.blacklist_users],
  };
}

/** 按组从全局设置里取基线。 */
export function groupBase(g: OverridableGroup, global: Settings): Record<string, unknown> {
  switch (g) {
    case 'bot':
      return { ...pickBot(global.bot) };
    case 'proactive':
      return { ...global.proactive };
    case 'images':
      return { ...global.images };
    case 'vision':
      return { ...global.vision };
    case 'search':
      return { ...global.search };
    case 'computer':
      // 挑三个字段而不是整块摊开：owner_qq / workdir / 两个名单 / 审批策略
      // 都是部署级边界，一旦被写进会话快照，之后改全局也带不动这个会话了。
      return {
        enabled: global.computer.enabled,
        max_calls: global.computer.max_calls,
        timeout_sec: global.computer.timeout_sec,
      };
    case 'context':
      return { ...global.context };
  }
}

/** 单个字段的值是否符合它的类型约定。 */
export function matchKind(kind: FieldKind, v: unknown): boolean {
  switch (kind) {
    case 'bool':
      return typeof v === 'boolean';
    case 'num':
      return typeof v === 'number' && Number.isFinite(v);
    case 'strList':
      return Array.isArray(v) && v.every((x) => typeof x === 'string');
    case 'numList':
      return Array.isArray(v) && v.every(isQQ);
  }
}

/**
 * 找出第一个类型不对的字段名，全部合规返回 ''。
 *
 * 面板用它把"类型不符"变成 400：这一层必须显式报错，不能像
 * coerceGroup 那样默默丢组——用户改了半天的数字，存进去却整组没生效，
 * 而界面显示"已保存"，这种失败比报错难查得多。
 */
export function badFieldOf(g: OverridableGroup, raw: Record<string, unknown>): string {
  for (const [key, kind] of Object.entries(OVERRIDE_FIELDS[g])) {
    if (!Object.hasOwn(raw, key)) continue;
    if (!matchKind(kind, raw[key])) return key;
  }
  return '';
}

/**
 * 把一组的原始 JSON 合并到基线上，返回字段全量的组；类型不符返回 null。
 *
 * 返回 null 而不是"尽力而为"：这一层是最后的护栏，脏数据宁可不生效
 * （回落全局），也不要把 undefined/NaN 送进引擎——那会让一个群彻底哑掉，
 * 而面板上看不出任何异常。面板在更前面用 400 挡住了绝大多数情况。
 */
function coerceGroup(
  g: OverridableGroup,
  raw: Record<string, unknown>,
  base: Record<string, unknown>,
): Record<string, unknown> | null {
  const fields = OVERRIDE_FIELDS[g];
  const out: Record<string, unknown> = { ...base };

  for (const [key, kind] of Object.entries(fields)) {
    if (!Object.hasOwn(raw, key)) continue; // 缺字段：沿用基线（服务端补成全量）
    const v = raw[key];
    if (!matchKind(kind, v)) return null;
    // 数组必须显式复制：直接引用外来的数组，调用方改一下就把库里那份也改了。
    out[key] = Array.isArray(v) ? [...v] : v;
  }
  return out;
}

/**
 * 把库里的 / 接口来的原始 JSON 收敛成可信的 SessionOverrides。
 *
 * 只保留白名单里的组；组内缺的字段从全局补齐。未知组、类型不符的组
 * 整组丢弃——调用方（面板）在此之前已经用 400 拒过一轮，走到这里的
 * 要么是面板自己的输出，要么是手改过的库。
 */
export function normalizeOverrides(raw: unknown, global: Settings): SessionOverrides {
  const out: SessionOverrides = {};
  if (!isPlainObject(raw)) return out;

  for (const g of OVERRIDABLE_GROUPS) {
    const body = raw[g];
    if (!isPlainObject(body)) continue;
    const merged = coerceGroup(g, body, groupBase(g, global));
    if (merged === null) continue;
    // 这里只能逐个赋值：TS 无法把 Record<string, unknown> 分配到一个
    // 有具体字段的联合成员上，{...} 展开也会丢掉类型。
    switch (g) {
      case 'bot':
        out.bot = merged as unknown as SessionBotOverride;
        break;
      case 'proactive':
        out.proactive = merged as unknown as ProactiveSettings;
        break;
      case 'images':
        out.images = merged as unknown as ImageSettings;
        break;
      case 'vision':
        out.vision = merged as unknown as VisionSettings;
        break;
      case 'search':
        out.search = merged as unknown as SearchSettings;
        break;
      case 'computer':
        out.computer = merged as unknown as SessionComputerOverride;
        break;
      case 'context':
        out.context = merged as unknown as ContextSettings;
        break;
    }
  }
  return out;
}

/** 覆盖里出现了哪些组（顺序按 OVERRIDABLE_GROUPS，便于日志与界面稳定）。 */
export function overriddenGroups(ov: SessionOverrides | null): OverridableGroup[] {
  if (!ov) return [];
  return OVERRIDABLE_GROUPS.filter((g) => ov[g] !== undefined);
}

/** 是否没有任何覆盖（等价于"全部跟随全局"）。 */
export function isEmptyOverrides(ov: SessionOverrides | null): boolean {
  return overriddenGroups(ov).length === 0;
}

/** 只取可覆盖的组，供面板回显"全局当前值"（不含 Key 与面板凭据）。 */
export function pickGroups(global: Settings): Record<OverridableGroup, unknown> {
  return {
    bot: pickBot(global.bot),
    proactive: { ...global.proactive },
    images: { ...global.images },
    vision: { ...global.vision },
    search: { ...global.search },
    computer: {
      enabled: global.computer.enabled,
      max_calls: global.computer.max_calls,
      timeout_sec: global.computer.timeout_sec,
    },
    context: { ...global.context },
  };
}

/** 保序去重。 */
function uniqNumbers(xs: number[]): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  for (const x of xs) {
    if (seen.has(x)) continue;
    seen.add(x);
    out.push(x);
  }
  return out;
}

/**
 * 合成"该会话实际生效的设置"。
 *
 * 第一行就 cloneSettings：SettingsRepo.get() 虽然已经 clone 过，但这个
 * 函数是公开的纯函数，任何调用方都可能把缓存对象递进来。一旦就地改写，
 * 一次会话的覆盖会永久污染进程缓存——面板上会看到别的群也换了规则，
 * 重启才恢复。这种 bug 极难复现，所以宁可信不过调用方。
 */
export function resolveSettings(global: Settings, ov: SessionOverrides | null): Settings {
  const out = cloneSettings(global);
  if (!ov) return out;

  const b = ov.bot;
  if (b) {
    out.bot = {
      // 先摊全局：max_concurrent 与 whitelist_groups 必须保持全局值，
      // 引擎的 setConcurrency 与 filter 的白名单判断读的是这两个。
      ...out.bot,
      wake_words: [...b.wake_words],
      passive_rate: b.passive_rate,
      group_cooldown_sec: b.group_cooldown_sec,
      max_segments: b.max_segments,
      seg_delay_min_ms: b.seg_delay_min_ms,
      seg_delay_max_ms: b.seg_delay_max_ms,
      quote_reply: b.quote_reply,
      // 黑名单只能收紧：并集，全局在前。全局名单里的人无论会话里写什么
      // 都命中 includes，所以"会话删掉全局黑名单里的人"在语义上不可能发生
      // ——想放宽只能去全局页删，那是主人级操作。
      blacklist_users: uniqNumbers([...out.bot.blacklist_users, ...b.blacklist_users]),
    };
  }
  if (ov.proactive) out.proactive = { ...ov.proactive };
  if (ov.images) out.images = { ...ov.images };
  if (ov.vision) out.vision = { ...ov.vision };
  if (ov.search) out.search = { ...ov.search };
  if (ov.computer) {
    // 先摊全局再盖三个可覆盖字段：主人、名单、工作目录、审批策略必须
    // 始终来自全局，否则「这个群单独设置过」会连带把白名单冻结成旧值。
    out.computer = {
      ...out.computer,
      enabled: ov.computer.enabled,
      max_calls: ov.computer.max_calls,
      timeout_sec: ov.computer.timeout_sec,
    };
  }
  if (ov.context) out.context = { ...ov.context };
  return out;
}
