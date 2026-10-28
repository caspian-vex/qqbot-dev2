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
} from '../llm/client';
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
import {
  SEARCH_TOOL_NAME,
  WEB_SEARCH_TOOL,
  formatHits,
  searchPromptBlock,
  toolQuery,
  webSearch,
} from './search';
import { split, stripMarkdown } from './split';
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
}

/**
 * 工具循环最多几轮（含第一轮）。
 *
 * 3 轮 = 初次 + 两批搜索。实际几乎用不到第三批——模型通常搜一次就够。
 * 给上限是因为每多一轮就是一次完整的模型请求，费用和延迟都线性涨。
 */
const SEARCH_MAX_ROUNDS = 3;

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
    // 会话 ID 在这里就得算出来——下面 touch 会话表用的也是它，提前算没有副作用。
    const sid = sessionId(kindOf(ev), targetOf(ev));
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
      res = await this.ask(settings, cfg, msgs);
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
      seen_images: images.length,
      first_token: `${res.firstTokenMs}ms`,
    });

    this.scheduleEcho(sid, kindOf(ev), targetOf(ev), settings);
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
  private async ask(s: Settings, cfg: LlmConfig, msgs: LlmMessage[]): Promise<Result> {
    if (!s.search.enabled) return this.llm.chat(cfg, msgs, this.opt.signal);

    // 模型写 query 时常常省掉主语（「那场比赛」），把用户原话一起交给 Search API
    // 能让它补上语境。取最后一条 user 消息：历史里的旧提问与这次搜索无关。
    const ori = lastUserText(msgs);

    // max_calls 是成本硬闸。NaN 时 Math.max(1, NaN) 还是 NaN，
    // 比较恒为假会让工具一次都不给；normalize 已经兜过一层，这里再兜一层。
    const limit = Number.isFinite(s.search.max_calls)
      ? Math.max(1, Math.floor(s.search.max_calls))
      : 2;
    let convo = msgs;
    let used = 0;
    let promptTokens = 0;
    let completionTokens = 0;
    let firstTokenMs = 0;

    const sum = (r: Result): void => {
      promptTokens += r.usage.prompt_tokens;
      completionTokens += r.usage.completion_tokens;
      if (firstTokenMs === 0) firstTokenMs = r.firstTokenMs;
    };
    // 多轮请求的用量必须累加：只记最后一轮会让面板上的 token 统计少一半，
    // 而搜索带来的 prompt 膨胀恰恰是最需要被看见的成本。
    const pack = (content: string): Result => ({
      content,
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
      firstTokenMs,
    });

    for (let round = 0; round < SEARCH_MAX_ROUNDS; round++) {
      const allowTools = used < limit;
      let res: Result;
      try {
        res = await this.llm.chat(
          cfg,
          convo,
          this.opt.signal,
          allowTools ? [WEB_SEARCH_TOOL] : undefined,
        );
      } catch (e) {
        if (round === 0 && toolsUnsupported(e)) {
          this.log.warn('当前模型不支持工具调用，本次跳过联网搜索', { err: e });
          return this.llm.chat(cfg, msgs, this.opt.signal);
        }
        throw e;
      }

      sum(res);
      const calls = res.toolCalls ?? [];
      if (!allowTools || calls.length === 0) return pack(res.content);

      const ran = await this.runTools(calls, limit - used, s, cfg, ori);
      used += ran.count;
      convo = [
        ...convo,
        // 这条 assistant 消息必须原样回填：端点是按 tool_call_id 配对结果的，
        // 少了它，后面那些 role=tool 的消息会变成"来路不明的工具结果"。
        { role: 'assistant', content: res.content, tool_calls: calls },
        ...ran.msgs,
      ];
    }

    // 轮数用尽还在要工具：不给工具再问一次，让它用已经查到的内容收尾
    const last = await this.llm.chat(cfg, convo, this.opt.signal);
    sum(last);
    return pack(last.content);
  }

  /** 执行模型请求的工具调用，每个 call_id 都必须回一条消息。 */
  private async runTools(
    calls: ToolCall[],
    remain: number,
    s: Settings,
    cfg: LlmConfig,
    ori: string,
  ): Promise<{ msgs: LlmMessage[]; count: number }> {
    const msgs: LlmMessage[] = [];
    let count = 0;

    for (const c of calls) {
      const name = c.function?.name ?? '';
      const id = c.id;
      if (name !== SEARCH_TOOL_NAME) {
        msgs.push({ role: 'tool', tool_call_id: id, name, content: `没有名为 ${name} 的工具。` });
        continue;
      }
      if (count >= remain) {
        // 超预算也要回一条：漏掉任何一个 tool_call_id，下一次请求就是 400
        msgs.push({
          role: 'tool',
          tool_call_id: id,
          name,
          content: '本次的搜索次数已用完，请直接用现有信息回答。',
        });
        continue;
      }
      const query = toolQuery(c.function?.arguments ?? '');
      if (query === '') {
        msgs.push({
          role: 'tool',
          tool_call_id: id,
          name,
          content: '搜索词为空。请给出具体的 query 再来一次。',
        });
        continue;
      }

      count++;
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
        msgs.push({ role: 'tool', tool_call_id: id, name, content: formatHits(hits) });
      } catch (e) {
        // 搜不到不等于答不了：把失败原话交给模型，它通常能老实说"没查到"
        this.log.warn('联网搜索失败', { query, err: e });
        msgs.push({
          role: 'tool',
          tool_call_id: id,
          name,
          content: `搜索失败（${(e as Error).message}）。不要编造搜索结果，直接说明没查到，或按你已知的信息回答。`,
        });
      }
    }

    return { msgs, count };
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
