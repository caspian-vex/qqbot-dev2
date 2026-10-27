// OpenAI 兼容的 Chat Completions 客户端。
//
// 默认面向 DeepSeek，但对任何 OpenAI 兼容端点都能用。
//
// 一个必须讲清楚的细节：DeepSeek 的思考模式默认是开启的。
// 机器人场景必须显式关闭——否则每条消息都要先跑一段思维链，
// 首字延迟从 1 秒级涨到 5 秒级，token 也翻几倍。
// 所以请求体里永远带 thinking.type，而不是"需要时才加"。

export interface Message {
  role: string;
  content: string;
}

/** 单次调用使用的模型配置。 */
export interface LlmConfig {
  baseURL: string;
  apiKey: string;
  model: string;
  temperature: number;
  maxTokens: number;
  thinking: boolean;
  /** 毫秒 */
  timeoutMs: number;
}

export interface Usage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface Result {
  content: string;
  usage: Usage;
  /** 首字延迟，用于验证思考模式是否真的关掉了。 */
  firstTokenMs: number;
}

interface ChatRequest {
  model: string;
  messages: Message[];
  stream: boolean;
  temperature?: number;
  max_tokens?: number;
  thinking: { type: 'enabled' | 'disabled' };
  stream_options?: { include_usage: boolean };
}

interface ChatResponse {
  choices?: {
    message?: { content?: string };
    delta?: { content?: string };
    finish_reason?: string;
  }[];
  usage?: Usage;
  error?: { message?: string; type?: string };
}

/** 标记可重试的错误（网络错误、5xx、429）。 */
class RetryableError extends Error {
  readonly retryable = true;
}

function isRetryable(e: unknown): boolean {
  return e instanceof RetryableError;
}

function emptyUsage(): Usage {
  return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
}

function buildRequest(cfg: LlmConfig, msgs: Message[], stream: boolean): ChatRequest {
  const req: ChatRequest = {
    model: cfg.model,
    messages: msgs,
    stream,
    max_tokens: cfg.maxTokens,
    thinking: { type: cfg.thinking ? 'enabled' : 'disabled' },
  };
  if (!cfg.thinking) {
    // 非思考模式下 temperature 才生效；思考模式会忽略它
    req.temperature = cfg.temperature;
  }
  if (stream) req.stream_options = { include_usage: true };
  return req;
}

/**
 * 拼出 /chat/completions 的完整地址。
 *
 * 用户可能填 https://api.deepseek.com、https://api.deepseek.com/v1，
 * 或者干脆把完整路径贴进来。三种都要能work，否则装完第一件事就是 404。
 */
export function endpoint(baseURL: string): string {
  const base = baseURL.replace(/\/+$/, '');
  if (base.endsWith('/chat/completions')) return base;
  if (base.endsWith('/v1')) return `${base}/chat/completions`;
  return `${base}/v1/chat/completions`;
}

export class LlmClient {
  /** 发起一次非流式对话，返回完整文本。 */
  async chat(cfg: LlmConfig, msgs: Message[], signal?: AbortSignal): Promise<Result> {
    return this.do(cfg, msgs, false, undefined, signal);
  }

  /** 发起流式对话，每收到一段增量就回调 onDelta。 */
  async chatStream(
    cfg: LlmConfig,
    msgs: Message[],
    onDelta: (delta: string) => void,
    signal?: AbortSignal,
  ): Promise<Result> {
    return this.do(cfg, msgs, true, onDelta, signal);
  }

  /**
   * 最多尝试 3 次（2 次重试），只对网络错误、5xx、429 重试。
   *
   * 为什么 4xx 不重试：Key 错了、模型名错了、余额不足，
   * 重试三次只会让用户多等 1.5 秒才看到同一个错误。
   */
  private async do(
    cfg: LlmConfig,
    msgs: Message[],
    stream: boolean,
    onDelta: ((d: string) => void) | undefined,
    signal?: AbortSignal,
  ): Promise<Result> {
    if (cfg.apiKey === '') throw new Error('未配置模型 API Key');
    if (cfg.model === '') throw new Error('未配置模型名称');

    const timeoutMs = cfg.timeoutMs > 0 ? cfg.timeoutMs : 60_000;

    let lastErr: unknown = new Error('未知错误');
    let backoff = 500;

    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) {
        await sleep(backoff, signal);
        if (signal?.aborted) throw new Error('已取消');
        backoff *= 2;
      }
      try {
        return await this.once(cfg, msgs, stream, onDelta, timeoutMs, signal);
      } catch (e) {
        lastErr = e;
        if (!isRetryable(e)) break;
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
  }

  private async once(
    cfg: LlmConfig,
    msgs: Message[],
    stream: boolean,
    onDelta: ((d: string) => void) | undefined,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Result> {
    const timeout = AbortSignal.timeout(timeoutMs);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${cfg.apiKey}`,
    };
    if (stream) headers['Accept'] = 'text/event-stream';

    const start = Date.now();
    let resp: Response;
    try {
      resp = await fetch(endpoint(cfg.baseURL), {
        method: 'POST',
        headers,
        body: JSON.stringify(buildRequest(cfg, msgs, stream)),
        signal: combined,
      });
    } catch (e) {
      throw new RetryableError(`请求模型失败: ${(e as Error).message}`);
    }

    if (resp.status !== 200) {
      const raw = (await resp.text().catch(() => '')).slice(0, 4096);
      let msg = raw.trim();
      try {
        const parsed = JSON.parse(raw) as ChatResponse;
        if (parsed.error?.message) msg = parsed.error.message;
      } catch {
        // 非 JSON 错误体，保留原文
      }
      const err = `模型返回 HTTP ${resp.status}: ${msg}`;
      if (resp.status >= 500 || resp.status === 429) throw new RetryableError(err);
      throw new Error(err);
    }

    if (!stream) {
      let out: ChatResponse;
      try {
        out = (await resp.json()) as ChatResponse;
      } catch (e) {
        throw new RetryableError(`解析响应失败: ${(e as Error).message}`);
      }
      const content = out.choices?.[0]?.message?.content ?? '';
      if (out.choices === undefined || out.choices.length === 0) {
        throw new Error('模型返回空结果');
      }
      return {
        content,
        usage: out.usage ?? emptyUsage(),
        firstTokenMs: Date.now() - start,
      };
    }

    return readSSE(resp, start, onDelta);
  }
}

/** 解析 Server-Sent Events 流。 */
async function readSSE(
  resp: Response,
  start: number,
  onDelta: ((d: string) => void) | undefined,
): Promise<Result> {
  if (!resp.body) throw new Error('模型返回空结果');

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let content = '';
  let firstTokenMs = 0;
  let usage = emptyUsage();

  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });

      // SSE 以空行分帧；这里按行处理即可，因为 data 行本身不含换行
      let idx: number;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (line === '' || line.startsWith(':')) continue;
        if (!line.startsWith('data:')) continue;

        const payload = line.slice(5).trim();
        if (payload === '[DONE]') return finish();

        let chunk: ChatResponse;
        try {
          chunk = JSON.parse(payload) as ChatResponse;
        } catch {
          continue; // 单块解析失败不致命
        }
        if (chunk.error?.message) throw new Error(`模型返回错误: ${chunk.error.message}`);
        if (chunk.usage) usage = chunk.usage;

        const delta = chunk.choices?.[0]?.delta?.content ?? '';
        if (delta === '') continue;
        if (firstTokenMs === 0) firstTokenMs = Date.now() - start;
        content += delta;
        onDelta?.(delta);
      }
    }
  } finally {
    reader.cancel().catch(() => {
      /* 已经结束的流，取消失败无所谓 */
    });
  }
  return finish();

  function finish(): Result {
    if (content === '') throw new Error('模型返回空结果');
    return { content, usage, firstTokenMs };
  }
}

/**
 * 粗略估算 token 数。
 *
 * 不引 tiktoken 之类的分词器：体积大、多语言支持参差，
 * 而这里只需要"宁保守勿超限"的预算判断。
 * 中日韩字符约 0.7 token/字，其余约 0.25 token/字符。
 */
export function estimateTokens(s: string): number {
  if (s === '') return 0;
  let f = 0;
  for (const ch of s) {
    f += isCJK(ch.codePointAt(0) ?? 0) ? 0.7 : 0.25;
  }
  let n = Math.floor(f);
  if (f - n > 0) n++;
  return n < 1 ? 1 : n;
}

function isCJK(r: number): boolean {
  return (
    (r >= 0x4e00 && r <= 0x9fff) || // CJK 统一表意文字
    (r >= 0x3400 && r <= 0x4dbf) || // 扩展 A
    (r >= 0x3000 && r <= 0x303f) || // CJK 标点
    (r >= 0xff00 && r <= 0xffef) || // 全角字符
    (r >= 0x3040 && r <= 0x30ff) || // 日文假名
    (r >= 0xac00 && r <= 0xd7af) // 韩文
  );
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve) => {
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
