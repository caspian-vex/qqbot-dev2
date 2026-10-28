// 消息处理引擎：判断要不要回、组装上下文、调用模型、投递回复。
import { Manager as ContextManager } from '../ctxmgr';
import { LlmClient, estimateTokens, type LlmConfig, type Message as LlmMessage } from '../llm/client';
import type { Logger } from '../log/logger';
import type { BotStatus, EnginePort, EngineStats } from '../panel/ports';
import { build as buildSystem, emptyVars, expand } from '../persona';
import type { Store } from '../store';
import type { Settings } from '../store/types';
import { sessionId } from '../store/types';
import { isPeak, localDay, rfc3339, ZERO_TIME } from '../util/time';
import type { Event, Segment } from '../onebot/types';
import { at, image, isGroup, isMessage, isPrivate, reply, text } from '../onebot/types';
import { ECHO_INSTRUCTION, echoDelayMs, shouldEcho } from './echo';
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
import { split, stripMarkdown } from './split';

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
}

interface Counters {
  received: number;
  replied: number;
  ignored: number;
  dropped: number;
  errors: number;
  /** Unix 秒；0 表示从未回复 */
  lastReplyAt: number;
}

/** 一个已排定、尚未执行的跟进。 */
interface PendingEcho {
  kind: string;
  target: number;
  timer: ReturnType<typeof setTimeout>;
}

export class Engine implements EnginePort {
  private readonly store: Store;
  private readonly log: Logger;
  private readonly llm: LlmClient;
  private readonly ctx: ContextManager;
  private readonly imagesDir: string;
  private sender: Sender | null = null;

  private readonly dedupe = new Dedupe(5 * 60_000);
  private readonly queue = new TaskQueue(3, 3);
  private readonly cool = new Cooldown();

  // ---- 回声式跟进的状态 ----
  /** 每个会话至多挂一个待执行的跟进。 */
  private readonly pendingEcho = new Map<string, PendingEcho>();
  /** 最近一次实际发出跟进的时间（毫秒），用于会话冷却。 */
  private readonly echoSentAt = new Map<string, number>();
  /** 今日已发跟进条数；跨天在 rollEchoDay 里清零。进程重启即归零，方向是保守的。 */
  private echoCount = 0;
  private echoDay = localDay();

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

    // 用户有新消息，之前排的跟进立刻作废——
    // 否则会出现"对方刚开口，机器人却先补上一句刚才的茬"的错位
    this.cancelEcho(sessionKey(ev));

    let settings: Settings;
    try {
      settings = this.store.settings.get();
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
    this.queue.setConcurrency(settings.bot.max_concurrent);
    const key = sessionKey(ev);
    const accepted = this.queue.submit(key, () => this.reply(ev, settings, decision));
    if (!accepted) {
      this.counters.dropped++;
      this.log.warn('会话排队已满，丢弃本次回复', { session: key });
    }
  }

  // ---- 回复链路 ----

  private async reply(ev: Event, settings: Settings, d: Decision): Promise<void> {
    const userText = d.text.trim();

    if (userText === '') {
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

    let personaPrompt: string;
    try {
      personaPrompt = this.store.personas.active().system_prompt;
    } catch (e) {
      this.log.error('读取人格失败', { err: e });
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

    const sid = sessionId(kindOf(ev), targetOf(ev));
    try {
      this.store.sessions.touch(sid, kindOf(ev), targetOf(ev));
    } catch {
      // 会话表写入失败不该挡住回复
    }

    let msgs: LlmMessage[];
    try {
      msgs = this.ctx.build(sid, settings.context, system, userText);
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

    let res;
    try {
      res = await this.llm.chat(cfg, msgs, this.opt.signal);
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
      for (const m of msgs) promptTokens += estimateTokens(m.content);
    }
    let completionTokens = res.usage.completion_tokens;
    if (completionTokens === 0) completionTokens = estimateTokens(recordText);

    this.ctx.record(sid, 'user', userText, estimateTokens(userText));
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

    try {
      if (segs.length > 0) await this.sendText(ev, segs, settings);
      // 图片跟在文字后面：先说话再甩图，符合真人"配图"的节奏
      if (picked.length > 0) await this.sendImages(ev, picked);
    } catch (e) {
      this.log.error('发送回复失败', { err: e });
      this.counters.errors++;
      return;
    }

    this.counters.replied++;
    this.counters.lastReplyAt = Math.floor(Date.now() / 1000);
    this.log.info('已回复', {
      group: ev.group_id ?? 0,
      user: ev.user_id ?? 0,
      segments: segs.length,
      images: picked.length,
      first_token: `${res.firstTokenMs}ms`,
    });

    this.scheduleEcho(sid, kindOf(ev), targetOf(ev), settings);
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

  /** 回复成功后按概率排一个延迟跟进。 */
  private scheduleEcho(sid: string, kind: string, target: number, s: Settings): void {
    this.rollEchoDay();
    const cdMs = Math.max(0, s.proactive.echo_cooldown_min) * 60_000;
    const last = this.echoSentAt.get(sid) ?? 0;
    const ok = shouldEcho(s.proactive, {
      sentToday: this.echoCount,
      cooldownOk: cdMs === 0 || last === 0 || Date.now() - last >= cdMs,
    });
    if (!ok) return;

    // 同一会话同时只挂一个跟进；重排时先拆旧的
    this.cancelEcho(sid);
    const delay = echoDelayMs(s.proactive);
    const timer = setTimeout(() => this.fireEcho(sid), delay);
    this.pendingEcho.set(sid, { kind, target, timer });
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
      settings = this.store.settings.get();
    } catch {
      return;
    }
    const p = settings.proactive;
    // 从排定到执行可能隔了很久，硬闸执行时再验一遍（设置可能已被关掉或调小）
    this.rollEchoDay();
    const cdMs = Math.max(0, p.echo_cooldown_min) * 60_000;
    const last = this.echoSentAt.get(sid) ?? 0;
    if (!p.echo_enabled) return;
    if (p.echo_daily_limit <= 0 || this.echoCount >= p.echo_daily_limit) return;
    if (cdMs > 0 && last !== 0 && Date.now() - last < cdMs) return;

    let personaPrompt: string;
    try {
      personaPrompt = this.store.personas.active().system_prompt;
    } catch (e) {
      this.log.warn('跟进读取人格失败', { err: e });
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
      // 指令以 user 角色进请求但从不落库；真正发出的内容事后补记为 assistant
      const msgs = this.ctx.build(sid, settings.context, system, ECHO_INSTRUCTION);
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

      const segs = split(echoText, { maxSegments: 2, maxRunes: 80 });
      if (segs.length === 0) return;

      await this.sendTo(entry.kind, entry.target, segs, settings);

      this.ctx.record(sid, 'assistant', echoText, estimateTokens(echoText));
      this.echoSentAt.set(sid, Date.now());
      this.echoCount++;
      this.log.info('已跟进', { session: sid, segments: segs.length });
    } catch (e) {
      // 跟进是锦上添花：失败不重试、不兜底、不记 error
      this.log.debug('跟进失败，放弃', { session: sid, err: e });
    }
  }

  /**
   * 无事件发送：跟进没有原始消息可引用，也不 @，直接说话。
   * 段间延迟与回复链路共用 seg_delay_*，两处节奏保持一致。
   */
  private async sendTo(kind: string, target: number, segs: string[], s: Settings): Promise<void> {
    const sender = this.sender;
    if (!sender) throw new Error('协议端未连接');
    for (let i = 0; i < segs.length; i++) {
      const parts: Segment[] = [text(segs[i]!)];
      if (kind === 'group') await sender.sendGroup(target, parts, this.opt.signal);
      else await sender.sendPrivate(target, parts, this.opt.signal);
      if (i < segs.length - 1) {
        const min = Math.max(0, s.bot.seg_delay_min_ms);
        const max = Math.max(min, s.bot.seg_delay_max_ms);
        await sleep(min + Math.floor(Math.random() * (max - min)), this.opt.signal);
      }
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
      this.echoCount = 0;
    }
  }

  /** 当前挂起的跟进数（诊断与测试用）。 */
  pendingEchoCount(): number {
    return this.pendingEcho.size;
  }

  /**
   * 按段发送文本，第一段附带引用或 @。
   *
   * 段之间留随机间隔（区间读设置），模拟真人打字的节奏；最后一段不等待。
   * 引用还是 @ 由 bot.quote_reply 决定：关掉引用的用户往往嫌引用框占地方，
   * 这时退化成 @，否则群里一句话飘出来没人知道在回谁。
   */
  private async sendText(ev: Event, segs: string[], s: Settings): Promise<number> {
    const sender = this.sender;
    if (!sender) throw new Error('协议端未连接');
    if (segs.length === 0) return 0;

    const min = Math.max(0, s.bot.seg_delay_min_ms);
    const max = Math.max(min, s.bot.seg_delay_max_ms);

    let lastId = 0;
    for (let i = 0; i < segs.length; i++) {
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

      // 最后一段不等待
      if (i < segs.length - 1) {
        await sleep(min + Math.floor(Math.random() * (max - min)), this.opt.signal);
      }
    }
    return lastId;
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

/** 本地时间 "YYYY-MM-DD HH:mm"，对应 Go 的 Format("2006-01-02 15:04")。 */
function formatLocalMinute(d: Date): string {
  const p = (n: number): string => (n < 10 ? `0${n}` : String(n));
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}`
  );
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
