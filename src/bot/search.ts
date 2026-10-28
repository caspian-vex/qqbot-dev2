// 联网搜索：把「查一下」变成模型可以调用的一次外部请求。
//
// 为什么用 function calling 而不是关键词猜谜：
// 猜「这句话要不要搜」只有两种结局——猜宽了，聊一句「今天好累」也去查新闻，
// 回答全是念稿子；猜窄了，问「昨天那场球谁赢了」又不查，开始编。
// 把判断交给模型，代价是模型侧要支持工具调用；不支持时引擎会退回普通对话，
// 不引入新的失败面。
//
// 搜索源只有一家：DeepSeek 官方 Search API（POST /v1/tools/search）。
// 它和模型共用同一个 API Key，不需要用户再申请一份凭证、也不用在面板上选源。
// 顺带说清楚一个容易踩的坑：Responses API 里的内置 web_search 工具只有
// deepseek-v4-pro 会执行，deepseek-flash 传了会被服务端静默忽略——
// 「模型自带联网」在 flash 上是不成立的，必须显式调这个 Search API。
import type { ToolDef } from '../llm/client';

/** 工具名。模型按这个名字调用，引擎按这个名字识别。 */
export const SEARCH_TOOL_NAME = 'web_search';

/** 一次搜索取几条结果的上限（再多的摘要也塞不进上下文预算）。 */
export const SEARCH_MAX_RESULTS = 10;

/**
 * 搜索词长度上限。
 *
 * 128 是接口的硬限制（1～128 个 Unicode 字符），不是我们自己定的预算：
 * 超一个字整次请求就是 400，而错误文本会作为工具结果回给模型，
 * 用户看到的是"搜不到"而不是"你 query 写太长了"。
 * 模型偶尔会把整段对话塞进 query，所以必须在这里截断。
 */
export const SEARCH_MAX_QUERY = 128;

/** 拼给模型的搜索结果总长度上限，按字符算。 */
export const SEARCH_MAX_CHARS = 4000;

/** 单条摘要的截断长度。 */
const SNIPPET_MAX = 400;

/** 没配接口地址时用的官方域名。 */
const DEFAULT_BASE = 'https://api.deepseek.com';

/** 一条搜索结果。 */
export interface SearchHit {
  title: string;
  url: string;
  content: string;
  /** 发布时间（RFC 3339 或已截断的日期）。空串表示站点没给。 */
  date: string;
  /** 站点名，给模型判断来源用。 */
  site: string;
}

/** 一次搜索的运行参数。 */
export interface SearchConfig {
  /** DeepSeek API Key，与模型用的是同一把。 */
  apiKey: string;
  /** 模型接口地址，用来派生搜索地址；留空走官方。 */
  baseURL?: string;
  maxResults?: number;
  timeoutMs?: number;
  /**
   * 触发这次搜索的原始提问。
   *
   * Search API 拿它改善查询理解：模型常把 query 写成「那场比赛」这种缺主语的短句，
   * 单看 query 搜不出来，带上原问题就能补上语境。
   */
  oriQuestion?: string;
  signal?: AbortSignal;
  /** 测试注入用；线上就是全局 fetch。 */
  fetchImpl?: typeof fetch;
}

/** 交给模型的工具声明。描述写细一点，模型才分得清"该搜"和"不该搜"。 */
export const WEB_SEARCH_TOOL: ToolDef = {
  type: 'function',
  function: {
    name: SEARCH_TOOL_NAME,
    description:
      '在互联网上检索实时信息。适用于：新闻、价格行情、比分赛果、天气、股票、' +
      '最近发生的事件、你不确定的具体事实（人名、日期、数字、版本号）。' +
      '不要用于：日常闲聊、情绪回应、观点表达、写作与翻译、纯推理问题。',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description:
            '检索词，像在搜索框里输入的那样简短具体，例如「2026 诺贝尔文学奖 得主」。' +
            '支持搜索语法：site: 限定站点、after:/before: 限定日期、lang: 限定语言、' +
            '"..." 精确匹配。只在用户明确要求「最新的」「今年的」或指定站点时才加限定，' +
            '否则不要加——限定越多，召回越少。',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
};

/**
 * 从模型接口地址派生搜索地址。
 *
 * 面板允许填域名、带 /v1、甚至整条 /chat/completions，三种都收敛到
 * `<base>/v1/tools/search`。走中转时同样拼在中转域名下——中转若没代理这个接口会
 * 返回 404，错误会作为工具结果回给模型，不会把回复搞挂。
 */
export function searchEndpoint(baseURL: string | undefined): string {
  let base = (baseURL ?? '').trim().replace(/\/+$/, '');
  if (base === '') base = DEFAULT_BASE;
  if (base.endsWith('/chat/completions')) {
    base = base.slice(0, -'/chat/completions'.length).replace(/\/+$/, '');
  }
  if (base.endsWith('/v1')) return `${base}/tools/search`;
  return `${base}/v1/tools/search`;
}

/**
 * 注入系统提示的一段说明。
 *
 * 只说三件事：什么时候用、什么时候别用、最多用几次。
 * 不写"你必须搜索"——那会让模型在每句话后面都挂一条来源，聊天变得像客服。
 */
export function searchPromptBlock(maxCalls: number): string {
  const n = Math.max(1, maxCalls);
  return [
    '你可以调用 web_search 工具联网查询实时信息。',
    '- 需要查：新闻、价格、比分、天气、股价、最近发生的事，以及你不确定的具体事实。',
    '- 不要查：闲聊、情绪回应、观点、写作、翻译、纯推理——直接回答就好。',
    `- 一条消息最多查 ${n} 次；搜索结果与问题无关就忽略，不要拿它硬凑答案。`,
    '- 用到搜索结果时，顺口提一句出处（说域名就够），别把长链接贴满屏幕。',
  ].join('\n');
}

/** 搜索词归一：压缩空白、去首尾、截断。空串表示这次调用不合法。 */
export function normalizeQuery(q: string): string {
  return q.replace(/\s+/g, ' ').trim().slice(0, SEARCH_MAX_QUERY);
}

/**
 * 解析工具调用里的参数。
 *
 * 绝大多数端点给的是 `{"query":"..."}`。也有模型直接甩一句裸文本，
 * 这时把它当检索词用比报错更划算——用户要的是答案，不是格式合规。
 */
export function toolQuery(args: string): string {
  const raw = args.trim();
  if (raw === '') return '';
  try {
    const o = JSON.parse(raw) as { query?: unknown };
    if (typeof o.query === 'string') return normalizeQuery(o.query);
    return '';
  } catch {
    return raw.startsWith('{') ? '' : normalizeQuery(raw);
  }
}

/**
 * 执行一次搜索，返回归一后的结果。
 *
 * 失败一律抛错：调用方（引擎）会把错误文本作为工具结果回给模型，
 * 让它"知道搜失败了然后自己拿主意"，而不是整条回复失败。
 */
export async function webSearch(query: string, cfg: SearchConfig): Promise<SearchHit[]> {
  const q = normalizeQuery(query);
  if (q === '') throw new Error('搜索词为空');
  if (cfg.apiKey.trim() === '') throw new Error('未配置 DeepSeek API Key');

  const max = clampInt(cfg.maxResults, 1, SEARCH_MAX_RESULTS, 5);
  const body: Record<string, unknown> = { query: q, count: max, need_content: false };
  // 原问题只在长度合规时带：超过 128 字接口会直接 400，
  // 而为了一个可选的提示字段把整次搜索搞失败不值得。
  const ori = normalizeQuery(cfg.oriQuestion ?? '');
  if (ori !== '' && ori !== q) body['ori_question'] = ori;

  const raw = await requestJSON(cfg, searchEndpoint(cfg.baseURL), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey.trim()}`,
    },
    body: JSON.stringify(body),
  });

  const root = obj(raw);
  return hitsOf(root['results']).slice(0, max);
}

/**
 * 把结果拼成给模型看的文本。
 *
 * 带序号、站点和日期：模型引用时可以用「[2]」这种短记号，
 * 而我们不需要让它复述整段摘要——上下文预算比搜索结果值钱。
 * 日期尤其重要：没有日期，模型分不清「今年」是哪一年。
 */
export function formatHits(hits: SearchHit[], maxChars = SEARCH_MAX_CHARS): string {
  if (hits.length === 0) return '（没有搜到相关结果）';
  const blocks: string[] = [];
  let used = 0;
  for (let i = 0; i < hits.length; i++) {
    const h = hits[i]!;
    const meta = [h.site, h.date].filter((x) => x !== '').join(' · ');
    const head = `[${i + 1}] ${h.title === '' ? '（无标题）' : h.title}${meta === '' ? '' : `（${meta}）`}`;
    const block = `${head}\n${h.url}\n${clip(h.content, SNIPPET_MAX)}`;
    // 第一条永远保留：否则摘要过长时会把整个结果集裁成空
    if (blocks.length > 0 && used + block.length > maxChars) break;
    blocks.push(block);
    used += block.length + 2;
  }
  return `以下是网页搜索结果（可能过时或与问题无关，自行判断）：\n\n${blocks.join('\n\n')}`;
}

// ---- 底层 ----

/** 发请求并解析 JSON；所有失败都翻译成能给人看的中文错误。 */
async function requestJSON(cfg: SearchConfig, url: string, init: RequestInit): Promise<unknown> {
  const fetcher = cfg.fetchImpl ?? fetch;
  const timeoutMs = cfg.timeoutMs !== undefined && cfg.timeoutMs > 0 ? cfg.timeoutMs : 8000;
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = cfg.signal ? AbortSignal.any([cfg.signal, timeout]) : timeout;

  let resp: Response;
  try {
    resp = await fetcher(url, { ...init, signal });
  } catch (e) {
    // 超时、DNS、TLS、被取消都在这里。区分不了也不必区分：
    // 对模型来说都是"这次没查到"。
    throw new Error(`搜索请求失败：${(e as Error).message}`);
  }

  const raw = await resp.text().catch(() => '');
  if (!resp.ok) {
    throw new Error(`搜索接口返回 HTTP ${resp.status}：${apiError(raw)}`);
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new Error('搜索接口返回的不是 JSON（接口地址可能指向了不支持的中转）');
  }
}

/**
 * 从错误响应里挖出可读的一句话。
 *
 * DeepSeek 用 OpenAI 兼容的错误体：`{"error":{"message":"..."}}`。
 * 直接塞原始 JSON 给模型看也能用，但 401/402 这类"该去充值了"的信息
 * 被埋在花括号里，人看不懂。
 */
function apiError(raw: string): string {
  try {
    const e = obj(obj(JSON.parse(raw))['error']);
    const msg = str(e['message']);
    if (msg !== '') return clip(msg, 160);
  } catch {
    // 不是 JSON 就走下面的原文截断
  }
  return clip(raw.trim(), 160) || '（无响应体）';
}

/** 把 Search API 的 results 映射成 SearchHit，丢掉没有链接也没有内容的空壳。 */
function hitsOf(v: unknown): SearchHit[] {
  if (!Array.isArray(v)) return [];
  const out: SearchHit[] = [];
  for (const item of v) {
    if (typeof item !== 'object' || item === null) continue;
    const o = item as Record<string, unknown>;
    // summary 是给模型读的长摘要（600-800 字），snippet 是给界面看的短摘要。
    // 前者信息密度高得多，但有站点只给后者，所以按优先级取。
    const content = str(o['summary']) || str(o['snippet']);
    const url = str(o['url']);
    if (url === '' && content === '') continue;
    out.push({
      title: str(o['title']),
      url,
      content,
      date: normalizeDate(str(o['date'])),
      site: str(o['site_name']),
    });
  }
  return out;
}

/** 日期压到 `YYYY-MM-DD`：模型只需要年月日，时分秒是噪音。 */
function normalizeDate(s: string): string {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(s);
  return m ? m[1]! : s;
}

function obj(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function clampInt(v: number | undefined, min: number, max: number, fallback = min): number {
  const n = v === undefined || !Number.isFinite(v) ? fallback : Math.floor(v);
  return Math.min(max, Math.max(min, n));
}

function clip(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n)}…`;
}
