// 消息处理引擎：判断要不要回、组装上下文、调用模型、投递回复。
import { Manager as ContextManager } from '../ctxmgr';
import {
  LlmClient,
  contentText,
  contentTokens,
  estimateTokens,
  type ContentPart,
  type LlmConfig,
  type Message as LlmMessage,
  type Result,
  type ToolCall,
  type ToolDef,
} from '../llm/client';
import type { Logger } from '../log/logger';
import type { BotStatus, EnginePort, EngineStats } from '../panel/ports';
import { build as buildSystem, emptyVars, expand } from '../persona';
import type { Store } from '../store';
import { resolveSettings, type SessionOverrides } from '../store/overrides';
import type { Settings } from '../store/types';
import { sessionId } from '../store/types';
import { isPeak, localDay, rfc3339, ZERO_TIME } from '../util/time';
import type { Event, Segment } from '../onebot/types';
import { at, image, isGroup, isMessage, isPrivate, reply, text } from '../onebot/types';
import { ApprovalQueue } from './computer-approval';
import {
  computerAccess,
  computerPromptBlock,
  computerTools,
  isComputerTool,
  resolveWorkdir,
  runComputerTool,
  type ComputerActor,
} from './computer';
import { echoDelayMs, echoInstruction, isAwaitingAnswer, repeatsLastReply, shouldEcho } from './echo';
import { planSpeech, type SpeechPlan } from './timing';
import {
  IDLE_MIN_GAP_MS,
  alarmInstruction,
  idleInstruction,
  inQuietHours,
  planIdle,
  type IdleState,
} from './scheduler';
import type { ScheduledRow } from '../store/scheduled';
import {
  MAX_REMIND_BODY,
  REMIND_PROMPT,
  REMIND_TOOL,
  REMIND_TOOL_NAME,
  parseDueAt,
  readRemindArgs,
} from './remind';
import {
  dedupeImages,
  extractImageTags,
  imageBase64,
  imageLabel,
  listPool,
  poolPromptBlock,
  resolveImage,
  tagDirOf,
  type PoolImage,
  type PoolTag,
} from './imagepool';
import { decide, type Decision } from './filter';
import { Cooldown, Dedupe, TaskQueue } from './queue';
import {
  SEARCH_TOOL_NAME,
  WEB_SEARCH_TOOL,
  formatHits,
  searchPromptBlock,
  toolQuery,
  webSearch,
} from './search';
import { split, stripMarkdown, truncate } from './split';
import {
  VISION_HINT,
  VISION_ONLY_PROMPT,
  imageMarker,
  imageRefs,
  loadImages,
} from './vision';

/** 引擎需要的发送能力。抽成接口是为了让引擎能脱离真实连接测试。 */
export interface Sender {
  sendGroup(groupId: number, segs: Segment[], signal?: AbortSignal): Promise<number>;
  sendPrivate(userId: number, segs: Segment[], signal?: AbortSignal): Promise<number>;
  /** 拉群名；失败时抛错，由调用方决定要不要吞掉。 */
  groupInfo(groupId: number, signal?: AbortSignal): Promise<string>;
}

export interface EngineOptions {
  store: Store;
  log: Logger;
  llm?: LlmClient;
  signal?: AbortSignal;
  /** 图池目录（数据目录下的 images/）。空串或未传时图池功能整体关闭。 */
  imagesDir?: string;
  /**
   * 联网搜索用的 fetch。测试注入用；线上不传即全局 fetch。
   *
   * 之所以留这个口子而不是让测试去起一个本地 HTTP 服务：搜索是回复链路
   * 中间的一跳，用真网络跑用例既慢又不稳定，而这里要验的是"搜到了怎么用"。
   */
  searchFetch?: typeof fetch;
  /**
   * 数据目录。电脑操作的默认工作目录就是它（配置里没填 workdir 时）。
   * 不传就退到进程 cwd——容器里是 /app，那是 root 所有的目录，
   * 写文件会 EACCES，所以线上必须传。
   */
  dataDir?: string;
  /**
   * 待批准队列。引擎与面板必须共用同一个实例，否则面板看不到引擎挂起的申请。
   * 不传就自己建一个（测试里够用，线上由 main.ts 注入）。
   */
  approvals?: ApprovalQueue;
}

/**
 * 工具循环最多几轮（含第一轮）。
 *
 * 4 轮 = 初次 + 三批工具。搜索与电脑操作共用这条轮数预算，各自另有次数闸：
 * 电脑操作多一步"查一下再改"很正常，但每多一轮就是一次完整的模型请求，
 * 费用与延迟都线性涨，所以给到 4 就打住。
 */
const TOOL_MAX_ROUNDS = 4;

/**
 * 进程级每日跟进硬顶，不可配置。
 *
 * proactive.echo_daily_limit 改成按会话累计之后，总量上限就变成了
 * Σ(各会话上限)：一个把 20 个群都开成 10 条/天的配置就是 200 条主动消息/天，
 * 风控风险被一次配置放大。这道闸不上面板——正常用（几个群、几条）
 * 永远碰不到，碰到的人本来也不该那么发。
 */
const ECHO_DAILY_HARD_CAP = 100;

/**
 * 进程级每日"主动开口"硬顶（闲置唤醒 + 闹钟），同样不可配置。
 *
 * 与 ECHO_DAILY_HARD_CAP 分开计数：这是**没有对方消息触发**的发消息，
 * 风控上比"补一句"敏感一个量级。Σ(各会话上限) 可以被配置放大，
 * 这道闸不能——一个号一天主动发 100 条，基本等于在自证是机器人。
 */
const PROACTIVE_DAILY_HARD_CAP = 60;

/** 一轮 tick 最多执行几条到期的闹钟。停机积压时别一次全放出去。 */
const ALARM_BATCH = 4;

/** 闲置唤醒只看最近这么多天有过动静的会话。 */
const IDLE_LOOKBACK_MS = 7 * 24 * 3600_000;

interface Counters {
  received: number;
  replied: number;
  ignored: number;
  dropped: number;
  errors: number;
  /** Unix 秒；0 表示从未回复 */
  lastReplyAt: number;
}

/** 本次请求可以带哪些工具。由 reply() 算一次，ask/runTools 共用同一个结论。 */
interface ToolScope {
  search: boolean;
  computer: boolean;
  /** 排定时消息。与电脑操作同一道权限：能在这台机器上动手的人才配让它替自己说话。 */
  schedule: boolean;
  /** 电脑操作的触发者。权限不通过时 computer=false，这个字段也不会被用到。 */
  actor: ComputerActor;
}

/** 各类工具的次数预算。共用轮数、分开计数。 */
interface ToolBudget {
  used: { search: number; computer: number; schedule: number };
  limit: { search: number; computer: number; schedule: number };
}

/** 一个已排定、尚未执行的跟进。 */
interface PendingEcho {
  kind: string;
  target: number;
  timer: ReturnType<typeof setTimeout>;
  /**
   * 排这次跟进时机器人刚发出去的那句（含图片备注，已截断）。
   * 跟进时要把原文交给模型：「不许把上一句换个说法再说一遍」这条规则，
   * 不给它看原文是做不到的。
   */
  lastReply: string;
  /**
   * 排定的时刻。执行时用它复查"这期间用户说过话没有"——
   * 排定时取消过不代表执行时还有效，见 runEcho。
   */
  armedAt: number;
}

export class Engine implements EnginePort {
  private readonly store: Store;
  private readonly log: Logger;
  private readonly llm: LlmClient;
  private readonly ctx: ContextManager;
  private readonly imagesDir: string;
  private readonly dataDir: string;
  private readonly approvals: ApprovalQueue;
  private sender: Sender | null = null;

  private readonly dedupe = new Dedupe(5 * 60_000);
  private readonly queue = new TaskQueue(3, 3);
  private readonly cool = new Cooldown();

  // ---- 回声式跟进的状态 ----
  /** 每个会话至多挂一个待执行的跟进。 */
  private readonly pendingEcho = new Map<string, PendingEcho>();
  /**
   * 正在"迟到等待"里的会话 → 提前放行的回调。
   *
   * 迟到的回复是刻意为之（模拟人不在），但对方追了一句就必须立刻发出去：
   * 让他等满五分钟，比机械秒回更像故障。
   */
  private readonly lateWaiters = new Map<string, () => void>();
  /** 最近一次实际发出跟进的时间（毫秒），用于会话冷却。 */
  private readonly echoSentAt = new Map<string, number>();
  /**
   * 各会话今日已发跟进条数。
   *
   * 曾经是进程级单值（跨会话累计）。改成按会话，是因为日限可以按会话覆盖了：
   * 共享计数会让群 1 调大的上限吃掉私聊的额度，用户看到的是"我明明设了 20，
   * 第三条就不补了"，覆盖像是没生效。
   */
  private readonly echoCount = new Map<string, number>();
  /** 今日全进程已发总数，只服务于 ECHO_DAILY_HARD_CAP。 */
  private echoTotal = 0;
  /** 进程重启即归零，方向是保守的。 */
  private echoDay = localDay();

  // ---- 主动开口（闲置唤醒 + 闹钟）的状态 ----
  /** 各会话今日主动说了几句，含闹钟。 */
  private readonly proactiveCount = new Map<string, number>();
  /** 各会话上次主动开口的时间（毫秒），用于 IDLE_MIN_GAP_MS。 */
  private readonly proactiveAt = new Map<string, number>();
  /** 今日全进程主动开口条数，只服务于 PROACTIVE_DAILY_HARD_CAP。 */
  private proactiveTotal = 0;
  private proactiveDay = localDay();
  /**
   * 各会话最近一次"有人说话"的时间。
   *
   * 用来在真正开口前复查：从排定到执行之间，对方可能已经自己接上了话，
   * 这时再补一句就是答非所问。比"再查一次最后一条消息"更准——
   * 同一秒内的两条消息靠时间戳分不出来，靠这个计数可以。
   */
  private readonly lastActivity = new Map<string, number>();
  /** tick 重入保护：上一轮还在等模型时，下一分钟的 tick 不该叠上来。 */
  private ticking = false;

  private selfId = 0;
  private botName = '';
  private readonly groupNames = new Map<number, string>();

  private readonly counters: Counters = {
    received: 0,
    replied: 0,
    ignored: 0,
    dropped: 0,
    errors: 0,
    lastReplyAt: 0,
  };

  constructor(private readonly opt: EngineOptions) {
    this.store = opt.store;
    this.log = opt.log.with({ component: 'bot' });
    this.llm = opt.llm ?? new LlmClient();
    this.ctx = new ContextManager(opt.store);
    this.imagesDir = opt.imagesDir ?? '';
    this.dataDir = opt.dataDir ?? process.cwd();
    this.approvals = opt.approvals ?? new ApprovalQueue(this.log);
    // 退出时拆掉所有未执行的跟进，别让进程死前还发一条消息
    opt.signal?.addEventListener('abort', () => this.cancelAllEchoes(), { once: true });
  }

  /** 注入协议端。允许先建引擎再建客户端，打破循环依赖。 */
  setSender(s: Sender): void {
    this.sender = s;
  }

  /** 设置机器人自身账号信息（登录后调用）。 */
  setSelf(id: number, name: string): void {
    this.selfId = id;
    this.botName = name;
  }

  getSelfId(): number {
    return this.selfId;
  }

  stats(): EngineStats {
    const c = this.counters;
    return {
      received: c.received,
      replied: c.replied,
      ignored: c.ignored,
      dropped: c.dropped,
      errors: c.errors,
      last_reply_at: c.lastReplyAt > 0 ? rfc3339(new Date(c.lastReplyAt * 1000)) : ZERO_TIME,
    };
  }

  dedupeSize(): number {
    return this.dedupe.size;
  }

  // ---- 事件入口 ----

  handleEvent(ev: Event): void {
    if (isMessage(ev)) {
      this.handleMessage(ev);
      return;
    }
    if (ev.post_type === 'meta_event' && ev.self_id !== 0) {
      this.selfId = ev.self_id;
    }
  }

  private handleMessage(ev: Event): void {
    this.counters.received++;

    // 忽略自己发的消息，否则会和自己的回复无限对话
    if (this.selfId !== 0 && (ev.user_id ?? 0) === this.selfId) {
      this.counters.ignored++;
      return;
    }

    if (this.dedupe.seenBefore(ev.message_id ?? 0)) {
      this.log.debug('重复消息，已跳过', { message_id: ev.message_id ?? 0 });
      return;
    }

    // sid 必须在这里就算出来：设置要按会话取，得先知道是哪个会话。
    // kindOf/targetOf 是纯函数，提前算没有副作用；下面 cancelEcho 本来也要它。
    const sid = sessionKey(ev);

    // 记下"这个会话刚刚有人说话"：正在排队的主动开口要据此复查
    this.lastActivity.set(sid, Date.now());

    // 用户有新消息，之前排的跟进立刻作废——
    // 否则会出现"对方刚开口，机器人却先补上一句刚才的茬"的错位
    this.cancelEcho(sid);
    // 同理：这条回复如果正在"故意迟到"，别再让他等，立刻发
    this.flushLate(sid);

    let settings: Settings;
    try {
      settings = this.resolveFor(sid);
    } catch (e) {
      this.log.error('读取设置失败', { err: e });
      this.counters.errors++;
      return;
    }

    const decision = decide(ev, settings.bot, this.selfId, this.cool);
    if (!decision.respond) {
      this.counters.ignored++;
      this.log.debug('不满足触发条件', {
        reason: decision.reason,
        group: ev.group_id ?? 0,
        user: ev.user_id ?? 0,
      });
      return;
    }

    // 同一会话串行，跨会话并发。
    // 并发上限来自设置（面板「最大并发会话」），这里每次同步一次，
    // 改完立即生效；不这么做的话那个输入框就是个摆设。
    // 注意它永远是全局值：resolveSettings 不会让会话覆盖它（队列是进程共享的）。
    this.queue.setConcurrency(settings.bot.max_concurrent);
    const accepted = this.queue.submit(sid, () => this.reply(ev, settings, decision, sid));
    if (!accepted) {
      this.counters.dropped++;
      this.log.warn('会话排队已满，丢弃本次回复', { session: sid });
    }
  }

  /**
   * 该会话实际生效的设置 = 全局 + 会话覆盖。
   *
   * 覆盖读失败按全局跑：一条手改坏的记录不该让机器人从此在这个群里失语。
   * 全局设置读失败则照旧上抛，由调用方计数——那是真故障，掩盖它更糟。
   */
  private resolveFor(sid: string): Settings {
    const global = this.store.settings.get();
    let ov: SessionOverrides | null = null;
    try {
      ov = this.store.sessionSettings.get(sid);
    } catch (e) {
      this.log.warn('读取会话设置失败，按全局设置处理', { session: sid, err: e });
    }
    return resolveSettings(global, ov);
  }

  // ---- 回复链路 ----

  private async reply(ev: Event, settings: Settings, d: Decision, sid: string): Promise<void> {
    const rawText = d.text.trim();

    // 先把图取回来。任何一张读不到都只是"少一张"，不能升级成整条回复失败；
    // 开关关着时不发请求，连一字节都不下载（见 VisionSettings 的说明）。
    const refs = imageRefs(ev);
    const images: ContentPart[] = settings.vision.enabled
      ? await loadImages(refs, {
          maxImages: settings.vision.max_images,
          signal: this.opt.signal,
        })
      : [];
    if (settings.vision.enabled && images.length < refs.length) {
      this.log.debug('部分图片未进入本条消息', { refs: refs.length, kept: images.length });
    }

    if (rawText === '' && images.length === 0) {
      // 用户确实发了图，只是一张都没读出来（超限、下载失败、不是真图）。
      // 直说比"在的，怎么了？"诚实——后者会让人以为机器人根本没收到图。
      if (refs.length > 0 && settings.vision.enabled) {
        try {
          await this.sendText(ev, ['这张图我没加载出来，再发一次？'], settings);
          this.counters.replied++;
          this.counters.lastReplyAt = Math.floor(Date.now() / 1000);
        } catch {
          // 兜底回复失败就算了，不值得记一条 error
        }
        return;
      }
      // 只 @ 了机器人、或者只发了唤醒词，没带正文。
      // 这种情况给个简短回应即可，没必要为一句"在吗"去调模型。
      if (d.direct) {
        try {
          await this.sendText(ev, ['在的，怎么了？'], settings);
          this.counters.replied++;
          this.counters.lastReplyAt = Math.floor(Date.now() / 1000);
        } catch {
          // 兜底回复失败就算了，不值得记一条 error
        }
        return;
      }
      this.log.debug('消息没有可读文本，跳过');
      this.counters.ignored++;
      return;
    }

    // 只发图没打字：给模型一句说明它才知道该看图。
    // 这句只进请求——历史里记的是"用户带了图"，不能把系统的口吻写进用户台词。
    const askText = rawText === '' ? VISION_ONLY_PROMPT : rawText;
    const historyText = images.length === 0 ? rawText : `${rawText}${imageMarker(images.length)}`;

    let personaPrompt: string;
    // 人格按会话取，不是全局单例：同一个人在不同群里可以是不同角色。
    // sid 由调用方传入（handleMessage 里已经算过）：两处各算一次会变成
    // "读的是 A 的设置、写的是 B 的历史"，而且将来改 targetOf 必漏一个。
    try {
      personaPrompt = this.store.personas.forSession(sid).system_prompt;
    } catch (e) {
      this.log.error('读取人格失败', { err: e, session: sid });
      this.counters.errors++;
      return;
    }

    const vars = {
      ...emptyVars(),
      time: formatLocalMinute(new Date()),
      botName: this.botName,
      nickname: displayOf(ev),
      groupName: await this.groupName(ev.group_id ?? 0),
    };
    let system = buildSystem(expand(personaPrompt, vars), vars);

    // 图池开着且池里有图时，把「标签 + 备注 + 示例文件」告诉模型，
    // 让它自己决定配不配图、配哪一类。池子为空就不注入：
    // 给一个空清单只会诱导模型编造文件名。
    if (settings.images.enabled && this.imagesDir !== '') {
      const pool = this.loadPool();
      if (pool.some((t) => t.images.length > 0)) {
        system += `\n${poolPromptBlock(pool, Math.max(1, settings.images.max_per_reply))}`;
      }
    }

    // 带图才提这一句：纯文字对话里塞图片规则，只会让模型以为
    // 自己刚才收到了图，开始描述一张不存在的画面。
    if (images.length > 0) system += `\n${VISION_HINT}`;

    // 搜索规则只在开着时注入：关掉还告诉模型"你可以搜"，
    // 它会在回复里编出"我查了一下"，用户直接被误导。
    if (settings.search.enabled) system += `\n${searchPromptBlock(settings.search.max_calls)}`;

    // 电脑操作：权限只算这一次，prompt 与工具声明都用它。两处各算一遍，
    // 迟早会漂移成"说明书里说能执行命令、tools 却没下发"。
    const actor: ComputerActor = {
      sid,
      kind: kindOf(ev),
      target: targetOf(ev),
      user: ev.user_id ?? 0,
      role: ev.sender?.role ?? '',
    };
    const computer = computerAccess(settings.computer, actor);
    if (computer.allowed) {
      system += `\n${computerPromptBlock(settings.computer, resolveWorkdir(settings.computer, this.dataDir))}`;
      // 排闹钟与电脑操作同一道权限，说明也一起给：只在能排的时候告诉模型能排
      system += `\n${REMIND_PROMPT}`;
    } else if (settings.computer.enabled) {
      // 开关开着但不适用于这个人/这个群：不注入说明、不下发工具，
      // 模型就不会承诺"我帮你看一下"，用户也不会白等一次超时。
      this.log.debug('电脑操作不适用于本会话', { session: sid, reason: computer.reason });
    }

    try {
      // 名字只用于面板显示，拿不到就回空串（touch 不会因此擦掉旧值）。
      // 群名在算 vars 时已经拉过一次，这里直接用缓存里的结果，不多发请求。
      this.store.sessions.touch(sid, kindOf(ev), targetOf(ev), targetNameOf(ev, vars.groupName));
    } catch {
      // 会话表写入失败不该挡住回复
    }

    let msgs: LlmMessage[];
    try {
      msgs = this.ctx.build(sid, settings.context, system, askText, images);
    } catch (e) {
      this.log.error('组装上下文失败', { err: e });
      this.counters.errors++;
      return;
    }

    const cfg: LlmConfig = {
      baseURL: settings.llm.base_url,
      apiKey: settings.llm.api_key,
      model: settings.llm.model,
      temperature: settings.llm.temperature,
      maxTokens: settings.llm.max_tokens,
      thinking: settings.llm.thinking,
      timeoutMs: settings.llm.timeout_sec * 1000,
    };

    let res: Result;
    try {
      res = await this.ask(settings, cfg, msgs, {
        search: settings.search.enabled,
        computer: computer.allowed,
        // 排闹钟与电脑操作同级：两者都是"这个号可以替你做点事"，
        // 分成两套权限表只会让面板多一处会配错的开关。
        schedule: computer.allowed,
        actor,
      });
    } catch (e) {
      this.log.error('调用模型失败', { err: e });
      this.counters.errors++;
      await this.sendFallback(ev, settings);
      return;
    }

    const stripped = stripMarkdown(res.content);
    const { text: bodyText, tags } = extractImageTags(stripped);

    // 选图：模型点名的标签/文件名逐一在池子里对号，越界的直接丢。
    // 池子关着时也照剥不误——标记是给引擎的内部协议，
    // 绝不能原样出现在聊天里。
    let picked: PoolImage[] = [];
    if (settings.images.enabled && this.imagesDir !== '' && tags.length > 0) {
      const pool = this.loadPool();
      picked = dedupeImages(
        tags.map((t) => resolveImage(t, pool)).filter((f): f is PoolImage => f !== null),
      ).slice(0, Math.max(1, settings.images.max_per_reply));
    }

    const replyText = bodyText;
    if (replyText === '' && picked.length === 0) {
      this.log.warn('模型返回空文本');
      this.counters.errors++;
      return;
    }

    // 先落库再发送：即便发送失败，上下文也是连贯的。
    // 发过图要补记成一句备注，否则下一轮模型不知道自己发过什么。
    const recordText =
      picked.length === 0
        ? replyText
        : `${replyText}\n（发了${picked.length === 1 ? '一张' : `${picked.length} 张`}图：${picked
            .map(imageLabel)
            .join('、')}）`;

    let promptTokens = res.usage.prompt_tokens;
    if (promptTokens === 0) {
      for (const m of msgs) promptTokens += contentTokens(m.content);
    }
    let completionTokens = res.usage.completion_tokens;
    if (completionTokens === 0) completionTokens = estimateTokens(recordText);

    // 历史只记文字 + 图张数：旧图不会重发，把它们的 token 记进历史会让
    // 后续每一轮的预算估算都偏小，白白裁掉真正有用的对话。
    this.ctx.record(sid, 'user', historyText, estimateTokens(historyText));
    this.ctx.record(sid, 'assistant', recordText, completionTokens);
    try {
      this.store.usage.record(settings.llm.model, promptTokens, completionTokens, isPeak());
    } catch (e) {
      this.log.warn('记录用量失败', { err: e });
    }

    const segs = split(replyText, {
      maxSegments: settings.bot.max_segments,
      maxRunes: 120,
    });

    // 节奏在这里排定：多长、分几段、要不要迟到。晚到这一步才排，
    // 是因为它依赖真实的分段结果——按"模型说了多少字"算打字时间，
    // 不能按"模型原样输出了多少字"算，stripMarkdown 与分图标记都会变短。
    const plan = this.pace(segs, settings);
    if (plan && plan.lateMs > 0) {
      this.log.debug('这条晚点回', { session: sid, late_ms: plan.lateMs });
      await this.waitLate(sid, plan.lateMs);
    }

    try {
      if (segs.length > 0) await this.sendText(ev, segs, settings, plan);
      // 图片跟在文字后面：先说话再甩图，符合真人"配图"的节奏
      if (picked.length > 0) await this.sendImages(ev, picked);
    } catch (e) {
      this.log.error('发送回复失败', { err: e });
      this.counters.errors++;
      return;
    }

    this.counters.replied++;
    this.counters.lastReplyAt = Math.floor(Date.now() / 1000);
    // 这句话已经把问题抛给对方了没有？跟着日志一起带上，部署后 grep echo_skip
    // 就能量出"有多少条回复因为已在等回答而没排出跟进"。只算这一次，
    // scheduleEcho 直接用结果，不重复判。
    const awaiting = isAwaitingAnswer(replyText);
    this.log.info('已回复', {
      group: ev.group_id ?? 0,
      user: ev.user_id ?? 0,
      segments: segs.length,
      images: picked.length,
      seen_images: images.length,
      first_token: `${res.firstTokenMs}ms`,
      ...(awaiting ? { echo_skip: 'awaiting' } : {}),
    });

    // quoteText 给它看的是实际发出去的口径（含"发了 1 张图"的备注）：
    // 纯发图时 replyText 是空串，只有 recordText 有内容——
    // 只给空串，模型会以为自己刚才什么都没说。
    this.scheduleEcho(sid, kindOf(ev), targetOf(ev), settings, awaiting, truncate(recordText, 200));
  }

  /**
   * 问模型，必要时让它先联网查一轮。
   *
   * 开关关着时就是一个普通的 chat 调用——请求形状与加这个功能之前完全一样，
   * 不带 tools 字段，老端点不会因为多出来的字段挂掉。
   *
   * 开着时走工具循环：
   *   请求(带 tools) → 模型要调 web_search → 我们执行 → 把结果作为 role=tool
   *   消息塞回去 → 再请求一次 → 直到它给出文本或轮数用尽。
   *
   * 三类降级都必须有，否则这个功能会变成"回复不可用"的新原因：
   *   1. 端点不支持 function calling → 退回不带工具的普通请求
   *   2. 搜索源报错/超时 → 错误文本作为工具结果给它，由它自己决定怎么说
   *   3. 轮数或次数用尽 → 不再给工具，逼它用已有信息作答
   */
  private async ask(s: Settings, cfg: LlmConfig, msgs: LlmMessage[], scope: ToolScope): Promise<Result> {
    const tools: ToolDef[] = [];
    if (scope.search) tools.push(WEB_SEARCH_TOOL);
    if (scope.computer) tools.push(...computerTools());
    if (scope.schedule) tools.push(REMIND_TOOL);
    // 一个工具都没开：请求形状与加工具之前逐字一致。少带两个字段，也就少
    // 一类"某个中转不认 tools 却又不报错"的兼容问题。
    if (tools.length === 0) return this.llm.chat(cfg, msgs, this.opt.signal);

    // 模型写 query 时常常省掉主语（「那场比赛」），把用户原话一起交给 Search API
    // 能让它补上语境。取最后一条 user 消息：历史里的旧提问与这次搜索无关。
    const ori = lastUserText(msgs);

    // max_calls 是成本硬闸。NaN 时 Math.max(1, NaN) 还是 NaN，
    // 比较恒为假会让工具一次都不给；normalize 已经兜过一层，这里再兜一层。
    const limit = {
      search: intOr(s.search.max_calls, 2),
      computer: intOr(s.computer.max_calls, 1),
      // 一条消息里排一个闹钟就够了。给多了，一次"提醒我三件事"就会排成三个
      // 各自到点的消息，而用户其实只想收到一句。
      schedule: 1,
    };
    const budget: ToolBudget = { used: { search: 0, computer: 0, schedule: 0 }, limit };
    // 两类工具共用这条轮数预算，但次数各算各的：搜索贵在请求费，
    // 命令贵在它要一个真人点批准，混成一个计数器会让其中一类莫名少用。
    //
    // 只算"这次真的下发了的"那几类的余量：把没下发的组的额度也算进来，
    // 搜索用完之后 left() 仍然 > 0，工具就会一直被带上，
    // 模型就会一遍遍请求搜索、每次只收到一句"次数已用完"。
    const left = (): number =>
      (scope.search ? limit.search - budget.used.search : 0) +
      (scope.computer ? limit.computer - budget.used.computer : 0) +
      (scope.schedule ? limit.schedule - budget.used.schedule : 0);

    let convo = msgs;
    let promptTokens = 0;
    let completionTokens = 0;
    let firstTokenMs = 0;

    const sum = (r: Result): void => {
      promptTokens += r.usage.prompt_tokens;
      completionTokens += r.usage.completion_tokens;
      if (firstTokenMs === 0) firstTokenMs = r.firstTokenMs;
    };
    // 多轮请求的用量必须累加：只记最后一轮会让面板上的 token 统计少一半，
    // 而工具带来的 prompt 膨胀恰恰是最需要被看见的成本。
    const pack = (content: string): Result => ({
      content,
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
      firstTokenMs,
    });

    for (let round = 0; round < TOOL_MAX_ROUNDS; round++) {
      const allowTools = left() > 0;
      let res: Result;
      try {
        res = await this.llm.chat(cfg, convo, this.opt.signal, allowTools ? tools : undefined);
      } catch (e) {
        if (round === 0 && toolsUnsupported(e)) {
          this.log.warn('当前模型不支持工具调用，本次按普通对话回答', { err: e });
          return this.llm.chat(cfg, msgs, this.opt.signal);
        }
        throw e;
      }

      sum(res);
      const calls = res.toolCalls ?? [];
      if (!allowTools || calls.length === 0) return pack(res.content);

      const ran = await this.runTools(calls, budget, scope, s, cfg, ori);
      convo = [
        ...convo,
        // 这条 assistant 消息必须原样回填：端点是按 tool_call_id 配对结果的，
        // 少了它，后面那些 role=tool 的消息会变成"来路不明的工具结果"。
        { role: 'assistant', content: res.content, tool_calls: calls },
        ...ran,
      ];
    }

    // 轮数用尽还在要工具：不给工具再问一次，让它用已经拿到的内容收尾
    const last = await this.llm.chat(cfg, convo, this.opt.signal);
    sum(last);
    return pack(last.content);
  }

  /** 执行模型请求的工具调用，每个 call_id 都必须回一条消息。 */
  private async runTools(
    calls: ToolCall[],
    budget: ToolBudget,
    scope: ToolScope,
    s: Settings,
    cfg: LlmConfig,
    ori: string,
  ): Promise<LlmMessage[]> {
    const msgs: LlmMessage[] = [];
    const say = (id: string, name: string, content: string): void => {
      msgs.push({ role: 'tool', tool_call_id: id, name, content });
    };

    for (const c of calls) {
      const name = c.function?.name ?? '';
      const id = c.id;
      const args = c.function?.arguments ?? '';

      if (name === SEARCH_TOOL_NAME) {
        if (budget.used.search >= budget.limit.search) {
          // 超预算也要回一条：漏掉任何一个 tool_call_id，下一次请求就是 400
          say(id, name, '本次的搜索次数已用完，请直接用现有信息回答。');
          continue;
        }
        const query = toolQuery(args);
        if (query === '') {
          say(id, name, '搜索词为空。请给出具体的 query 再来一次。');
          continue;
        }
        budget.used.search++;
        try {
          const hits = await webSearch(query, {
            // 搜索走 DeepSeek 官方 Search API，与模型共用同一把 Key、同一个域名：
            // 面板上少一份配置，也就少一处会配错的地方。
            apiKey: cfg.apiKey,
            baseURL: cfg.baseURL,
            maxResults: s.search.max_results,
            timeoutMs: s.search.timeout_sec * 1000,
            oriQuestion: ori,
            signal: this.opt.signal,
            fetchImpl: this.opt.searchFetch,
          });
          this.log.info('已联网搜索', { query, hits: hits.length });
          say(id, name, formatHits(hits));
        } catch (e) {
          // 搜不到不等于答不了：把失败原话交给模型，它通常能老实说"没查到"
          this.log.warn('联网搜索失败', { query, err: e });
          say(
            id,
            name,
            `搜索失败（${(e as Error).message}）。不要编造搜索结果，直接说明没查到，或按你已知的信息回答。`,
          );
        }
        continue;
      }

      if (isComputerTool(name)) {
        // 权限在 reply() 里已经算过一次：这里的判断防的是"模型自己编了个工具名"
        // 或者历史里残留了上一轮的调用——那种情况下不执行，也不登记批准。
        if (!scope.computer) {
          say(id, name, '这个会话没有电脑操作权限。');
          continue;
        }
        if (budget.used.computer >= budget.limit.computer) {
          say(id, name, '本次的电脑操作次数已用完，请直接用现有信息回答。');
          continue;
        }
        budget.used.computer++;
        const text = await runComputerTool(name, args, {
          settings: s.computer,
          actor: scope.actor,
          cwd: resolveWorkdir(s.computer, this.dataDir),
          approvals: this.approvals,
          log: this.log,
          audit: (action, detail) => this.audit(action, detail),
          signal: this.opt.signal,
        });
        say(id, name, text);
        continue;
      }

      if (name === REMIND_TOOL_NAME) {
        // 权限与电脑操作同源：没有那个权限就不可能走到这里
        if (!scope.schedule) {
          say(id, name, '这个会话没有安排定时消息的权限。');
          continue;
        }
        if (budget.used.schedule >= budget.limit.schedule) {
          say(id, name, '这次消息里已经安排过一条了，需要另排请让用户下一条再说。');
          continue;
        }
        budget.used.schedule++;
        say(id, name, this.runRemind(args, scope.actor));
        continue;
      }

      say(id, name, `没有名为 ${name} 的工具。`);
    }

    return msgs;
  }

  /**
   * 写一条审计。审计失败不影响主流程——记不下来这件事本身，
   * 不该让用户的问题也回答不了。
   */
  private audit(action: string, detail: string): void {
    try {
      this.store.audit.record(action, detail, '');
    } catch {
      // 故意忽略
    }
  }

  /**
   * 处理 schedule_message：排一条、或撤掉已有的。
   *
   * 这里**不走审批**：它没有副作用，只往库里加一行，而且到点发的时候
   * 还要再过日限。为一句"八点叫我"让用户去面板点批准，这功能就没人用了。
   *
   * 永不抛错：返回值会作为工具结果回灌给模型，让它自己决定怎么跟用户说。
   */
  private runRemind(rawArgs: string, actor: ComputerActor): string {
    const a = readRemindArgs(rawArgs);

    if (a.cancel) {
      let n = 0;
      try {
        n = this.store.scheduled.cancelSession(actor.sid);
      } catch (e) {
        return `取消失败（${(e as Error).message}）。`;
      }
      if (n > 0) this.audit('schedule.cancel', `session=${actor.sid} count=${n}`);
      return n > 0 ? `已取消 ${n} 条还没发出的定时消息。` : '这个会话当前没有待发的定时消息。';
    }

    const now = new Date();
    const when = parseDueAt(a.at, a.after, now);
    if ('error' in when) return `没有排上（${when.error}）。`;

    const body = a.text.slice(0, MAX_REMIND_BODY).trim();
    try {
      const id = this.store.scheduled.add({
        session_id: actor.sid,
        kind: actor.kind,
        target_id: actor.target,
        due_at: Math.floor(when.dueAt / 1000),
        body,
        source: 'tool',
      });
      const at = formatLocalMinute(new Date(when.dueAt));
      this.audit('schedule.add', `id=${id} at=${at} body=${body.slice(0, 80)}`);
      this.log.info('已排定定时消息', { session: actor.sid, id, at });
      return body === ''
        ? `已排定：${at} 由你自己组织一句话发出去。到点会自己发，不需要用户再说话。`
        : `已排定：${at} 主动说「${body}」。到点会自己发，不需要用户再说话。`;
    } catch (e) {
      return `没有排上（${(e as Error).message}）。`;
    }
  }

  /** 模型调用失败时给一句兜底回复，避免用户干等。 */
  private async sendFallback(ev: Event, settings: Settings): Promise<void> {
    // 兜底也失败就不再重试，避免在故障时放大流量
    try {
      await this.sendText(ev, ['我这会儿有点卡住了，稍后再试试？'], settings);
    } catch {
      // 故意忽略
    }
  }

  // ---- 回声式跟进 ----
  //
  // 主动消息里风险最低的一种：对话刚发生、对方明确在聊，
  // 隔一小会儿补一句相关的话。所以把它做成第一个落地的主动功能。

  /**
   * 回复成功后按概率排一个延迟跟进。
   *
   * awaiting 是这次回复有没有在问对方问题，由 reply() 算好传进来（同一个值
   * 还要写进"已回复"日志的 echo_skip 字段），不在这里重复解析。
   */
  private scheduleEcho(
    sid: string,
    kind: string,
    target: number,
    s: Settings,
    awaiting: boolean,
    quoteText: string,
  ): void {
    this.rollEchoDay();
    // 已经在等对方回答，就别再补一句：球在对方手里，隔 40 秒又追问一遍，
    // 在对方看来就是"同一个消息回了两遍"。线上 2026-10-29 的
    // 「跑顺点了没」→「调过画质之后有没有好点呀」就是这么来的。
    // 放在掷骰子之前，与 shouldEcho 注释里"概率最后掷"的约定一致，
    // 也让日志能区分"被这条拦下"和"没中概率"。
    if (awaiting) {
      this.log.debug('跟进跳过：上一条在等回答', { session: sid });
      return;
    }
    // 排定时就判一次硬顶：省得白挂一个几分钟后才被丢掉的定时器。
    // 权威判断在执行时（见 runEcho）。
    if (this.echoTotal >= ECHO_DAILY_HARD_CAP) return;
    const cdMs = Math.max(0, s.proactive.echo_cooldown_min) * 60_000;
    const last = this.echoSentAt.get(sid) ?? 0;
    const ok = shouldEcho(s.proactive, {
      sentToday: this.echoCount.get(sid) ?? 0,
      cooldownOk: cdMs === 0 || last === 0 || Date.now() - last >= cdMs,
    });
    if (!ok) return;

    // 同一会话同时只挂一个跟进；重排时先拆旧的
    this.cancelEcho(sid);
    const delay = echoDelayMs(s.proactive);
    const timer = setTimeout(() => this.fireEcho(sid), delay);
    this.pendingEcho.set(sid, { kind, target, timer, lastReply: quoteText, armedAt: Date.now() });
    this.log.debug('已排跟进', { session: sid, delay_ms: delay });
  }

  /** 延迟到期：把跟进投进与会话回复相同的队列，保证写历史不与真回复交叉。 */
  private fireEcho(sid: string): void {
    const entry = this.pendingEcho.get(sid);
    if (!entry) return;
    const accepted = this.queue.submit(sid, () => this.runEcho(sid, entry));
    if (!accepted) {
      this.pendingEcho.delete(sid);
      this.log.debug('跟进排队已满，丢弃', { session: sid });
    }
  }

  private async runEcho(sid: string, entry: PendingEcho): Promise<void> {
    // 排队期间用户又说了话（cancelEcho 已删条目）或跟进被重排 → 放弃
    if (this.pendingEcho.get(sid) !== entry) return;
    this.pendingEcho.delete(sid);

    let settings: Settings;
    try {
      // 必须用执行时的会话设置复查：从排定到执行可能隔了几分钟，
      // 期间用户完全可能在面板上把某个群的主动发言关掉。
      settings = this.resolveFor(sid);
    } catch {
      return;
    }
    const p = settings.proactive;
    // 从排定到执行可能隔了很久，硬闸执行时再验一遍（设置可能已被关掉或调小）
    this.rollEchoDay();
    const cdMs = Math.max(0, p.echo_cooldown_min) * 60_000;
    const last = this.echoSentAt.get(sid) ?? 0;
    if (!p.echo_enabled) return;
    if (this.echoTotal >= ECHO_DAILY_HARD_CAP) return;
    if (p.echo_daily_limit <= 0 || (this.echoCount.get(sid) ?? 0) >= p.echo_daily_limit) return;
    if (cdMs > 0 && last !== 0 && Date.now() - last < cdMs) return;

    let personaPrompt: string;
    try {
      // 跟进同样按会话取人格：群里刚用傲娇人格说完话，
      // 三分钟后跟进一句正经的，人设会当场崩掉。
      personaPrompt = this.store.personas.forSession(sid).system_prompt;
    } catch (e) {
      this.log.warn('跟进读取人格失败', { err: e, session: sid });
      return;
    }

    try {
      const vars = {
        ...emptyVars(),
        time: formatLocalMinute(new Date()),
        botName: this.botName,
        groupName: entry.kind === 'group' ? await this.groupName(entry.target) : '',
        nickname: '',
      };
      const system = buildSystem(expand(personaPrompt, vars), vars);
      // 指令以 user 角色进请求但从不落库；真正发出的内容事后补记为 assistant。
      // 把上一条原文一起交给它：跟进时上下文里没有新输入，不给它看自己刚说过什么，
      // 它唯一能做的就是把那句换个说法再问一遍。
      const msgs = this.ctx.build(sid, settings.context, system, echoInstruction(entry.lastReply));
      const cfg: LlmConfig = {
        baseURL: settings.llm.base_url,
        apiKey: settings.llm.api_key,
        model: settings.llm.model,
        temperature: settings.llm.temperature,
        maxTokens: settings.llm.max_tokens,
        thinking: settings.llm.thinking,
        timeoutMs: settings.llm.timeout_sec * 1000,
      };
      const res = await this.llm.chat(cfg, msgs, this.opt.signal);
      // 跟进不配图（图池清单只注入正常回复），但模型可能照着历史里的
      // 格式自己编一个 [图:xx]——那串符号绝不能原样发到聊天里。
      const echoText = extractImageTags(stripMarkdown(res.content)).text;

      // 空输出是模型行使"闭嘴权"，正常放弃而不是错误
      if (echoText === '') {
        this.log.debug('跟进没有想说的，放弃', { session: sid });
        return;
      }

      // 字面复读也要拦：模型弱一点就会把上一句原样吐回来，发出去就是
      // 同一句话说了两遍。（语义级的重复它拦不住，那道防线在指令与时机闸门上。）
      if (repeatsLastReply(echoText, entry.lastReply)) {
        this.log.info('跟进与上一条重复，丢弃', { session: sid });
        return;
      }

      // 从排定到执行之间用户可能已经说话了：定时器到点时正好在排队，
      // 或者跟进请求这几秒里对方发了新消息——判据是 lastActivity 晚于排定时刻。
      // 这种跟进已经过期，发出去就是"对着上一句答了两遍"。cancelEcho 挡不住：
      // 条目在 runEcho 开头就被删了，新消息进来时已经没东西可取消。
      if ((this.lastActivity.get(sid) ?? 0) > entry.armedAt) {
        this.log.debug('跟进已过期，放弃', { session: sid });
        return;
      }

      const segs = split(echoText, { maxSegments: 2, maxRunes: 80 });
      if (segs.length === 0) return;

      await this.sendTo(entry.kind, entry.target, segs, settings);

      this.ctx.record(sid, 'assistant', echoText, estimateTokens(echoText));
      this.echoSentAt.set(sid, Date.now());
      this.echoCount.set(sid, (this.echoCount.get(sid) ?? 0) + 1);
      this.echoTotal++;
      this.log.info('已跟进', { session: sid, segments: segs.length });
    } catch (e) {
      // 跟进是锦上添花：失败不重试、不兜底、不记 error
      this.log.debug('跟进失败，放弃', { session: sid, err: e });
    }
  }

  /**
   * 无事件发送：跟进与主动开口都没有原始消息可引用，也不 @，直接说话。
   *
   * 节奏与回复链路共用同一套 plan：主动说一句和回一句，在对方看来
   * 应该是一样的打字速度，否则"这个号在某些时候打字特别快"本身就是破绽。
   */
  private async sendTo(
    kind: string,
    target: number,
    segs: string[],
    s: Settings,
    plan?: SpeechPlan,
  ): Promise<void> {
    const sender = this.sender;
    if (!sender) throw new Error('协议端未连接');

    const min = Math.max(0, s.bot.seg_delay_min_ms);
    const max = Math.max(min, s.bot.seg_delay_max_ms);

    for (let i = 0; i < segs.length; i++) {
      if (i === 0) {
        if (plan) await sleep(plan.leadMs, this.opt.signal);
      } else {
        const wait = plan
          ? (plan.gapsMs[i] ?? 0)
          : min + Math.floor(Math.random() * (max - min));
        await sleep(wait, this.opt.signal);
      }

      const parts: Segment[] = [text(segs[i]!)];
      if (kind === 'group') await sender.sendGroup(target, parts, this.opt.signal);
      else await sender.sendPrivate(target, parts, this.opt.signal);
    }
  }

  private cancelEcho(sid: string): void {
    const p = this.pendingEcho.get(sid);
    if (!p) return;
    clearTimeout(p.timer);
    this.pendingEcho.delete(sid);
  }

  private cancelAllEchoes(): void {
    for (const sid of [...this.pendingEcho.keys()]) this.cancelEcho(sid);
  }

  /** 跨天清零跟进计数。 */
  private rollEchoDay(): void {
    const day = localDay();
    if (day !== this.echoDay) {
      this.echoDay = day;
      // 两个都要清：漏掉 Map 会让用过的群从此不再跟进（计数永远停在昨天的值），
      // 而日志里只看得到 shouldEcho=false，完全看不出原因。
      this.echoCount.clear();
      this.echoTotal = 0;
    }
  }

  /** 当前挂起的跟进数（诊断与测试用）。 */
  pendingEchoCount(): number {
    return this.pendingEcho.size;
  }

  // ---- 时钟驱动：闹钟与闲置唤醒 ----
  //
  // 上面那一整套都是"收到消息"驱动的。这一节是唯一由**时间**驱动的入口：
  // main.ts 每分钟调一次 tick()，它做两件事——把库里到期的闹钟发出去，
  // 再看看有没有该由机器人主动开口的会话。

  /**
   * 一轮调度，默认每分钟一次。
   *
   * 重入保护不是洁癖：一轮里可能要问模型（闲置唤醒），1 核机器上
   * 一次请求两秒起，赶上模型慢的时候会有好几轮 tick 叠在一起，
   * 结果是同一个人被连问三句"你刚才说的那个事怎么样了"。
   */
  async tick(now: number = Date.now()): Promise<void> {
    if (this.ticking) {
      this.log.debug('上一轮调度还没结束，跳过本轮');
      return;
    }
    this.ticking = true;
    try {
      await this.fireAlarms(now);
      this.maybeIdle(now);
    } catch (e) {
      // 调度是后台动作：一轮失败不该让进程退出，下一分钟再来
      this.log.warn('调度轮询失败', { err: e });
    } finally {
      this.ticking = false;
    }
  }

  /** 当前待发的定时消息条数（诊断与面板用）。 */
  pendingScheduledCount(): number {
    try {
      return this.store.scheduled.countPending();
    } catch {
      return 0;
    }
  }

  /**
   * 发出库里到期的闹钟。
   *
   * 先标 done 再发，是刻意选的"至多一次"：进程在两步之间挂掉时宁可漏一条，
   * 也不要重启后把同一条再说一遍——机器人重复自己比沉默更像故障。
   */
  private async fireAlarms(now: number): Promise<void> {
    const sec = Math.floor(now / 1000);
    const expired = this.store.scheduled.expireStale(sec);
    if (expired > 0) this.log.warn('有定时消息过期未发，已放弃', { count: expired });

    const due = this.store.scheduled.due(sec, ALARM_BATCH);
    for (const row of due) {
      this.store.scheduled.markDone(row.id, sec);
      // 进会话队列：与正常回复串行，历史顺序才不会错乱
      const accepted = this.queue.submit(row.session_id, () => this.runAlarm(row, now));
      if (!accepted) {
        this.log.warn('会话排队已满，定时消息被丢弃', { session: row.session_id, id: row.id });
      }
    }
  }

  /**
   * 执行一条到期消息。body 非空就直接发原话，否则让模型自己组织一句。
   *
   * 注意这里**不看免打扰**：免打扰管的是"机器人自己想说话"，
   * 而这条是用户明确让它到点提醒的事——晚上十点设的闹钟被静默掉，
   * 用户只会认为这个功能坏了。概率同理，也不再掷骰子。
   */
  private async runAlarm(row: ScheduledRow, now: number): Promise<void> {
    const sid = row.session_id;
    let settings: Settings;
    try {
      settings = this.resolveFor(sid);
    } catch (e) {
      this.log.warn('定时消息读取设置失败', { session: sid, err: e });
      return;
    }

    this.rollProactiveDay();
    const limit = settings.proactive.proactive_daily_limit;
    if (limit <= 0 || (this.proactiveCount.get(sid) ?? 0) >= limit) {
      this.log.info('本会话主动发言额度用尽，定时消息取消', { session: sid, id: row.id });
      return;
    }
    if (this.proactiveTotal >= PROACTIVE_DAILY_HARD_CAP) {
      this.log.warn('进程级主动消息额度用尽，定时消息取消', { session: sid, id: row.id });
      return;
    }

    try {
      const minutesLate = Math.max(0, Math.floor((now - row.due_at * 1000) / 60_000));
      const body = row.body.trim();
      const talk =
        body === ''
          ? await this.composeTalk(sid, row.kind, row.target_id, alarmInstruction(minutesLate), settings)
          : body;
      if (talk === '') {
        this.log.debug('定时消息没有内容可说，放弃', { session: sid, id: row.id });
        return;
      }

      const segs = split(talk, { maxSegments: 2, maxRunes: 80 });
      if (segs.length === 0) return;

      // 节奏照旧，但不含"迟到"——它本身已经到点了
      const plan = this.pace(segs, settings);
      await this.sendTo(row.kind, row.target_id, segs, settings, plan);

      this.ctx.record(sid, 'assistant', talk, estimateTokens(talk));
      this.bumpProactive(sid);
      try {
        this.store.sessions.touch(sid, row.kind, row.target_id, '');
      } catch {
        // 会话表写失败不该影响已经发出去的消息
      }
      this.log.info('已发定时消息', { session: sid, id: row.id, segments: segs.length });
    } catch (e) {
      // 闹钟失败不重试：下一次 tick 不该再捞到它（已经标 done 了）
      this.log.warn('定时消息发送失败', { session: sid, id: row.id, err: e });
    }
  }

  /**
   * 看看有没有该主动开口的会话。
   *
   * 严格的成本顺序：先用本地规则（免打扰、上限、闲置时长）把候选压到
   * 最多一个，再决定要不要为此花一次模型请求。1 核 2G 上给所有会话
   * 每十分钟问一次模型是不可能的。
   */
  private maybeIdle(now: number): void {
    this.rollProactiveDay();
    if (this.proactiveTotal >= PROACTIVE_DAILY_HARD_CAP) return;

    const states = this.collectIdleStates(now);
    if (states.length === 0) return;

    const d = planIdle(states, {
      now,
      globalLeft: PROACTIVE_DAILY_HARD_CAP - this.proactiveTotal,
    });
    if (!d.state) {
      this.log.debug('本轮不主动开口', { reason: d.note, candidates: states.length });
      return;
    }

    const st = d.state;
    let settings: Settings;
    try {
      settings = this.resolveFor(st.sid);
    } catch {
      return;
    }

    const accepted = this.queue.submit(st.sid, () => this.runIdle(st, d.satForMin, settings));
    if (!accepted) this.log.debug('会话排队已满，放弃本次主动开口', { session: st.sid });
  }

  /** 收集候选会话。只读库，不做任何判断以外的副作用。 */
  private collectIdleStates(now: number): IdleState[] {
    const out: IdleState[] = [];
    let sessions;
    try {
      sessions = this.store.sessions.list(200);
    } catch (e) {
      this.log.warn('读取会话列表失败', { err: e });
      return out;
    }

    for (const s of sessions) {
      // 群聊不主动开口：见 scheduler.ts 里的说明
      if (s.kind !== 'private' || s.messages <= 0) continue;
      if (s.updated_at.getTime() < now - IDLE_LOOKBACK_MS) continue;

      let pro;
      try {
        pro = this.resolveFor(s.id).proactive;
      } catch {
        continue;
      }
      if (pro.idle_after_min <= 0 || pro.proactive_daily_limit <= 0) continue;
      // 免打扰按会话自己的窗口算，不是全局那一份
      if (inQuietHours(new Date(now), pro.quiet_start_hour, pro.quiet_end_hour)) continue;

      let last;
      try {
        last = this.store.sessions.recent(s.id, 1)[0];
      } catch {
        continue;
      }
      if (!last) continue;

      out.push({
        sid: s.id,
        kind: 'private',
        target: s.target_id,
        lastRole: last.role,
        lastAt: last.created_at.getTime(),
        spokeToday: this.proactiveCount.get(s.id) ?? 0,
        lastSpokeAt: this.proactiveAt.get(s.id) ?? 0,
        // 门槛与概率都用本会话合成后的值：全局关着、会话单独开着也能生效
        holdMs: Math.max(0, pro.idle_after_min) * 60_000,
        rate: pro.idle_rate,
        dailyLimit: pro.proactive_daily_limit,
      });
    }
    return out;
  }

  /** 真的去说那句主动的话。 */
  private async runIdle(st: IdleState, satForMin: number, settings: Settings): Promise<void> {
    // 从排定到执行之间对方可能已经自己接上了话：只要这个会话有过新消息就放弃。
    // 比"再看一眼最后一条是谁说的"更准——回复链自己也会写历史。
    const act = this.lastActivity.get(st.sid) ?? 0;
    if (act > st.lastAt) {
      this.log.debug('对方已经接着说上了，放弃主动开口', { session: st.sid });
      return;
    }

    let last;
    try {
      last = this.store.sessions.recent(st.sid, 1)[0];
    } catch {
      return;
    }
    if (!last || last.role !== 'user') return;

    try {
      const talk = await this.composeTalk(
        st.sid,
        st.kind,
        st.target,
        idleInstruction(satForMin, last.content, st.spokeToday, st.dailyLimit),
        settings,
      );
      // 空输出是模型行使"闭嘴权"，这是主动发言里最重要的一条通路
      if (talk === '') {
        this.log.debug('没有想说的，放弃主动开口', { session: st.sid });
        return;
      }

      const segs = split(talk, { maxSegments: 2, maxRunes: 80 });
      if (segs.length === 0) return;

      const plan = this.pace(segs, settings);
      await this.sendTo(st.kind, st.target, segs, settings, plan);

      this.ctx.record(st.sid, 'assistant', talk, estimateTokens(talk));
      this.bumpProactive(st.sid);
      try {
        this.store.sessions.touch(st.sid, st.kind, st.target, '');
      } catch {
        // 同上
      }
      this.log.info('已主动开口', { session: st.sid, sat_min: satForMin, segments: segs.length });
    } catch (e) {
      // 与跟进同一哲学：锦上添花的功能，失败不重试、不兜底
      this.log.debug('主动开口失败，放弃', { session: st.sid, err: e });
    }
  }

  /**
   * 组装一次"无事件"的发言：读人格、算上下文、问模型，返回要发的话。
   *
   * 不带任何工具：主动开口时去搜新闻、去执行命令都很出戏，
   * 而且会额外花钱。真需要动手的场景一定有人先说话。
   */
  private async composeTalk(
    sid: string,
    kind: string,
    target: number,
    instruction: string,
    settings: Settings,
  ): Promise<string> {
    const personaPrompt = this.store.personas.forSession(sid).system_prompt;
    const vars = {
      ...emptyVars(),
      time: formatLocalMinute(new Date()),
      botName: this.botName,
      groupName: kind === 'group' ? await this.groupName(target) : '',
      nickname: '',
    };
    const system = buildSystem(expand(personaPrompt, vars), vars);
    const msgs = this.ctx.build(sid, settings.context, system, instruction);
    const cfg: LlmConfig = {
      baseURL: settings.llm.base_url,
      apiKey: settings.llm.api_key,
      model: settings.llm.model,
      temperature: settings.llm.temperature,
      maxTokens: settings.llm.max_tokens,
      thinking: settings.llm.thinking,
      timeoutMs: settings.llm.timeout_sec * 1000,
    };
    const res = await this.llm.chat(cfg, msgs, this.opt.signal);
    // 主动消息也花 token：不记会让用量页少算，用户对不上账时很难解释
    try {
      this.store.usage.record(
        settings.llm.model,
        res.usage.prompt_tokens,
        res.usage.completion_tokens,
        isPeak(),
      );
    } catch {
      // 记用量失败不影响发送
    }
    return extractImageTags(stripMarkdown(res.content)).text;
  }

  /** 记一次主动发言（计数 + 最近时间 + 进程总数）。 */
  private bumpProactive(sid: string): void {
    this.proactiveCount.set(sid, (this.proactiveCount.get(sid) ?? 0) + 1);
    this.proactiveAt.set(sid, Date.now());
    this.proactiveTotal++;
  }

  /** 跨天清零主动发言计数。 */
  private rollProactiveDay(): void {
    const day = localDay();
    if (day === this.proactiveDay) return;
    this.proactiveDay = day;
    this.proactiveCount.clear();
    // proactiveAt 不清：它是"两小时内别再说"的依据，跨零点照样成立
    this.proactiveTotal = 0;
  }

  /**
   * 排一次发言的节奏；节奏开关关着时返回 undefined。
   *
   * 必须显式判断开关，而不是靠"plan 全是 0"：plan 为 undefined 时
   * sendText 会退回旧的段间固定抖动，而一个全 0 的 plan 会把它彻底关掉。
   * 后者意味着"关掉拟人节奏"反而让消息发得更快、更机械，与承诺相反。
   */
  private pace(segs: string[], s: Settings): SpeechPlan | undefined {
    return s.timing.enabled ? planSpeech(segs, s.timing) : undefined;
  }

  /**
   * 按段发送文本，第一段附带引用或 @。
   *
   * 节奏来自 plan（拟人节奏）：第一段之前是"看到→想→打出来"的停顿，
   * 段与段之间是"回车、接着打"的耗时。plan 缺席时退回旧的固定抖动
   * （seg_delay_*）——关掉 timing 的用户行为与升级前逐字一致。
   *
   * 引用还是 @ 由 bot.quote_reply 决定：关掉引用的用户往往嫌引用框占地方，
   * 这时退化成 @，否则群里一句话飘出来没人知道在回谁。
   */
  private async sendText(
    ev: Event,
    segs: string[],
    s: Settings,
    plan?: SpeechPlan,
  ): Promise<number> {
    const sender = this.sender;
    if (!sender) throw new Error('协议端未连接');
    if (segs.length === 0) return 0;

    const min = Math.max(0, s.bot.seg_delay_min_ms);
    const max = Math.max(min, s.bot.seg_delay_max_ms);

    let lastId = 0;
    for (let i = 0; i < segs.length; i++) {
      // 注意顺序：先等再说。旧实现是"说完等、等完说下一句"，
      // 两者总时长一样，但先等才能表达"第一段之前也要停一下"。
      if (i === 0) {
        if (plan) await sleep(plan.leadMs, this.opt.signal);
      } else {
        const wait = plan
          ? (plan.gapsMs[i] ?? 0)
          : min + Math.floor(Math.random() * (max - min));
        await sleep(wait, this.opt.signal);
      }

      const parts: Segment[] = [];

      // 只有第一段带引用/@，后续段保持干净
      if (i === 0 && isGroup(ev)) {
        const mid = ev.message_id ?? 0;
        if (s.bot.quote_reply && mid !== 0) parts.push(reply(mid));
        else parts.push(at(ev.user_id ?? 0), text(' '));
      }
      parts.push(text(segs[i]!));

      const id = isGroup(ev)
        ? await sender.sendGroup(ev.group_id ?? 0, parts, this.opt.signal)
        : await sender.sendPrivate(ev.user_id ?? 0, parts, this.opt.signal);
      lastId = id;
    }
    return lastId;
  }

  /**
   * 故意晚点回：等到 ms 毫秒，或等到有新消息为止。
   *
   * 放在会话队列里是刻意的——同一会话本来串行，这条没发出去就不该
   * 开始处理下一条，否则会出现"先答后问"。而 flushLate 由 handleMessage
   * 直接调用（在队列之外），所以对方一追话就能立刻脱身。
   */
  private waitLate(sid: string, ms: number): Promise<void> {
    if (ms <= 0) return Promise.resolve();
    const signal = this.opt.signal;
    if (signal?.aborted) return Promise.resolve();

    return new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        this.lateWaiters.delete(sid);
        // 正常走完必须摘掉监听：一个长跑进程里积几百个 abort 监听会被 Node 警告
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      this.lateWaiters.set(sid, done);
      signal?.addEventListener('abort', done, { once: true });
    });
  }

  /** 对方又开口了：别再让他等，立刻把手上这条发出去。 */
  private flushLate(sid: string): void {
    this.lateWaiters.get(sid)?.();
  }

  /**
   * 发送图池里的图片：一条消息带全部 image 段，跟在文字后面。
   *
   * 图片来自 resolveImage 的白名单匹配（标签与文件名都校验过）。
   * 段数据用 base64:// 而不是本地路径——协议端是另一个容器，
   * 图池目录在它那边不存在（见 imagepool.imageBase64 的说明）。
   * 一张都读不出来就干脆不发，别让协议端收到空消息。
   */
  private async sendImages(ev: Event, imgs: PoolImage[]): Promise<void> {
    const sender = this.sender;
    if (!sender) throw new Error('协议端未连接');
    if (imgs.length === 0 || this.imagesDir === '') return;

    const parts: Segment[] = [];
    for (const i of imgs) {
      const data = imageBase64(tagDirOf(this.imagesDir, i.tag), i.name);
      if (data === null) {
        this.log.warn('图池里的图片读取失败或超出大小上限，已跳过', {
          tag: i.tag,
          name: i.name,
        });
        continue;
      }
      parts.push(image(data));
    }
    if (parts.length === 0) return;

    if (isGroup(ev)) await sender.sendGroup(ev.group_id ?? 0, parts, this.opt.signal);
    else await sender.sendPrivate(ev.user_id ?? 0, parts, this.opt.signal);
  }

  /**
   * 读一次图池（磁盘 + 标签备注）。
   *
   * 不缓存：用户在面板里刚传完图，下一句就该能发出去。
   * 池子规模是几十到几百张，一次 readdir + stat 的开销可以忽略。
   * 备注读失败只影响提示词质量，不该让整条回复失败。
   */
  private loadPool(): PoolTag[] {
    if (this.imagesDir === '') return [];
    let notes = new Map<string, string>();
    try {
      notes = this.store.imageTags.notes();
    } catch (e) {
      this.log.warn('读取图池标签备注失败', { err: e });
    }
    return listPool(this.imagesDir, notes);
  }

  /**
   * 懒加载群名，带进程内缓存。
   *
   * 群名只用于给模型一点上下文，取不到也不影响主链路，
   * 所以失败时缓存空串，避免每条消息都去问一次。
   */
  private async groupName(groupId: number): Promise<string> {
    if (groupId === 0) return '';
    const cached = this.groupNames.get(groupId);
    if (cached !== undefined) return cached;

    const sender = this.sender;
    if (!sender) return '';

    let name = '';
    try {
      name = await sender.groupInfo(groupId, AbortSignal.timeout(3000));
    } catch {
      name = '';
    }
    this.groupNames.set(groupId, name);
    return name;
  }
}

// ---- 工具 ----

function kindOf(ev: Event): string {
  return isGroup(ev) ? 'group' : 'private';
}

function targetOf(ev: Event): number {
  return isGroup(ev) ? (ev.group_id ?? 0) : (ev.user_id ?? 0);
}

function sessionKey(ev: Event): string {
  return sessionId(kindOf(ev), targetOf(ev));
}

/** 群名片优先、昵称兜底、最后退到 QQ 号。 */
function displayOf(ev: Event): string {
  const s = ev.sender;
  if (!s) return String(ev.user_id ?? 0);
  if (s.card !== '') return s.card;
  if (s.nickname !== '') return s.nickname;
  return String(s.user_id);
}

/**
 * 会话表里记的「对话对象名字」，只供面板显示。
 *
 * 群聊取群名（调用方传进来的是已经拉过的那次结果）；私聊取对方的
 * 名片 / 昵称。注意这里跟 displayOf 的区别：拿不到名字时回空串，
 * 不能退到 QQ 号——那会让面板显示「2083882365」再加一行「private:2083882365」，
 * 同一个号码出现两遍，还不如干脆只显示 ID。
 */
function targetNameOf(ev: Event, groupName: string): string {
  if (isGroup(ev)) return groupName;
  const s = ev.sender;
  if (!s) return '';
  return s.card !== '' ? s.card : s.nickname;
}

/** 本地时间 "YYYY-MM-DD HH:mm"，对应 Go 的 Format("2006-01-02 15:04")。 */
function formatLocalMinute(d: Date): string {
  const p = (n: number): string => (n < 10 ? `0${n}` : String(n));
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}`
  );
}

/**
 * 取最后一条 user 消息的纯文本。
 *
 * 用作 Search API 的 ori_question：查询理解靠它补主语。带图的消息里
 * 图片块直接跳过——搜索接口只认文本，塞 data URL 进去既没用又超长。
 */
/** 取一个有限的正整数，坏值退回默认值（NaN 会让工具循环空转）。 */
function intOr(v: number, fallback: number): number {
  return Number.isFinite(v) ? Math.max(1, Math.floor(v)) : fallback;
}

function lastUserText(msgs: LlmMessage[]): string {
  for (let i = msgs.length - 1; i >= 0; i--) {
    const m = msgs[i]!;
    if (m.role !== 'user') continue;
    const t = contentText(m.content).trim();
    if (t !== '') return t;
  }
  return '';
}

/**
 * 判断错误是不是"端点不认 tools 字段"。
 *
 * 各家措辞不一样（unknown field `tools` / function calling is not supported /
 * tools is not supported），但都是 400 段位加文本里带 tool 或 function。
 * 只在这个特征上降级：换成余额不足、模型名写错这类 400，重试一次毫无意义，
 * 还会把真正的错误信息掩盖成一次多余请求。
 */
function toolsUnsupported(e: unknown): boolean {
  const msg = e instanceof Error ? e.message : String(e);
  if (!/HTTP 4\d\d/.test(msg)) return false;
  return /tool|function/i.test(msg);
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const t = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(t);
        resolve();
      },
      { once: true },
    );
  });
}

/** 供面板使用的只读视图：把引擎的 status 需求与客户端对齐。 */
export type { BotStatus };
export { isPrivate };
