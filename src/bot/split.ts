// 回复文本的分段与清理。

export interface SplitOptions {
  /**
   * 单条回复最多切成几段，超出部分合并到最后一段并截断。
   *
   * 这个上限是防刷屏的关键：模型偶尔会输出长篇大论，
   * 一次发十条消息比不发更糟。
   */
  maxSegments: number;
  /** 单段的字符上限。 */
  maxRunes: number;
}

export function defaultSplit(): SplitOptions {
  return { maxSegments: 4, maxRunes: 120 };
}

/** 句子结束符。中英文都覆盖，因为模型可能中英混排。 */
const SENTENCE_ENDERS = new Set(['。', '！', '？', '!', '?', '…', '\n']);

/**
 * 把模型输出切成若干段，尽量在句子边界断开。
 *
 * 为什么不在逗号处断：QQ 消息是独立气泡，在逗号处断开会读起来很别扭，
 * 像被人硬生生截断。整句发送才像人在说话。
 */
export function split(text: string, opt: SplitOptions = defaultSplit()): string[] {
  const maxSegments = opt.maxSegments > 0 ? opt.maxSegments : 4;
  const maxRunes = opt.maxRunes > 0 ? opt.maxRunes : 120;

  const trimmed = text.trim();
  if (trimmed === '') return [];

  // 先按句末标点切成句子，保留标点与原有空白。
  // 注意这里不能 trim 后再拼接，否则 "Hello! How" 会变成 "Hello!How"，
  // 英文里就成了病句。
  const sentences: string[] = [];
  let cur = '';
  for (const r of trimmed) {
    cur += r;
    if (SENTENCE_ENDERS.has(r)) {
      if (cur.trim() !== '') sentences.push(cur);
      cur = '';
    }
  }
  if (cur.trim() !== '') sentences.push(cur);

  // 把句子合并成不超过 maxRunes 的段。
  //
  // 长度必须按"拼好之后的整段"来算：句子是带原始空白的（上一段刻意保留了
  // "Hello! How" 里的空格），拿 s.trim() 的长度累加而把未 trim 的 s 塞进
  // 缓冲区，两者不同源，段长会随空白量线性漂出去。
  const segs: string[] = [];
  let buf = '';
  for (const s of sentences) {
    const cand = buf + s;
    if (buf !== '' && [...cand.trim()].length > maxRunes) {
      segs.push(buf.trim());
      buf = s;
    } else {
      buf = cand;
    }
  }
  if (buf.trim() !== '') segs.push(buf.trim());

  if (segs.length === 0) return [];

  // 超出段数上限：把后面的合并进最后一段并截断
  let out = segs;
  if (out.length > maxSegments) {
    const head = out.slice(0, maxSegments - 1);
    const tail = out.slice(maxSegments - 1).join('');
    head.push(truncate(tail, maxRunes));
    out = head;
  }

  // 过滤空段
  return out.filter((s) => s.trim() !== '');
}

/** 按字符数截断，并补省略号。 */
export function truncate(s: string, max: number): string {
  const r = [...s];
  if (r.length <= max) return s;
  if (max <= 1) return r.slice(0, max).join('');
  return `${r.slice(0, max - 1).join('')}…`;
}

/**
 * 兜底清理模型可能漏出的 Markdown 记号。
 *
 * 即使系统提示里明确要求纯文本，模型仍有概率输出 ** 或 #。
 * 这里做一层防御，保证发到 QQ 的文字是干净的。
 */
export function stripMarkdown(s: string): string {
  if (s === '') return s;

  // 成对/内联的记号可以整段删掉：它们不承载语义，只影响观感。
  const rules: [string, string][] = [
    ['**', ''],
    ['__', ''],
    ['```', ''],
    ['`', ''],
  ];
  let out = s;
  for (const [from, to] of rules) out = out.split(from).join(to);

  // 列表符号与标题井号只能删「行首」那一个。
  //
  // 原来把它们也丢进 split().join() 里做全文替换，'5 - 3 = 2' 会变成
  // '53 = 2'，'2 * 3 = 6' 会变成 '23 = 6'，而这段清理对**每一条回复**生效
  // （engine.reply），用户和模型都不会察觉内容被改了。
  out = out.replace(/^[ \t]*(?:[-*]|#{1,6}) /gm, '');

  // 折叠多余空行
  while (out.includes('\n\n\n')) out = out.split('\n\n\n').join('\n\n');
  return out.trim();
}
