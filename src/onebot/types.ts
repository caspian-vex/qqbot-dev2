// OneBot v11 事件与消息段的类型定义。
//
// 只声明框架真正用到的字段；其余保留在 raw 里备用。
// 协议端可能配成 array 或 string（CQ 码）两种消息格式，两种都要能吃。
/** 消息发送者。 */
export interface Sender {
  user_id: number;
  nickname: string;
  card: string;
  role: string;
}

/** 一条消息段。 */
export interface Segment {
  type: string;
  data: Record<string, unknown>;
}

/** OneBot v11 上报事件的超集。 */
export interface Event {
  time: number;
  self_id: number;
  post_type: string;

  // message 类事件
  message_type?: string;
  sub_type?: string;
  message_id?: number;
  user_id?: number;
  group_id?: number;
  raw_message?: string;
  message?: unknown;
  font?: number;
  sender?: Sender;

  // meta_event 类事件
  meta_event_type?: string;
  interval?: number;
  status?: Record<string, unknown>;

  // notice 类事件
  notice_type?: string;
  operator_id?: number;

  /** 原始报文，未声明的字段都在这里。 */
  raw: Record<string, unknown>;
}

/** 群名片优先、昵称兜底、最后退到 QQ 号。 */
export function displayName(s: Sender | undefined): string {
  if (!s) return '';
  if (s.card !== '') return s.card;
  if (s.nickname !== '') return s.nickname;
  return String(s.user_id);
}

export function isGroup(e: Event): boolean {
  return e.post_type === 'message' && e.message_type === 'group';
}

export function isPrivate(e: Event): boolean {
  return e.post_type === 'message' && e.message_type === 'private';
}

export function isMessage(e: Event): boolean {
  return e.post_type === 'message';
}

export function isHeartbeat(e: Event): boolean {
  return e.post_type === 'meta_event' && e.meta_event_type === 'heartbeat';
}

/**
 * 把消息解析成消息段。
 *
 * 协议端配成 array 还是 string 由用户决定，这里两种都兼容：
 * 以 '[' 开头当数组，否则当 CQ 码字符串。
 */
export function segments(e: Event): Segment[] {
  const m = e.message;
  if (m === undefined || m === null) return [];
  if (Array.isArray(m)) return m as Segment[];
  if (typeof m === 'string') {
    const t = m.trim();
    if (t === '' || t === 'null') return [];
    if (t.startsWith('[')) {
      try {
        const parsed = JSON.parse(t) as unknown;
        return Array.isArray(parsed) ? (parsed as Segment[]) : [];
      } catch {
        return parseCQ(t);
      }
    }
    return parseCQ(m);
  }
  return [];
}

/**
 * 抽取消息中的纯文本，@ 与图片等非文本段会被忽略。
 *
 * 解析成功但没有任何文本段时返回空串，绝不回退到 raw_message：
 * NapCat 的 raw_message 是 CQ 码，一条纯 @ 的消息回退后会变成
 * "[CQ:at,qq=123456]"，于是模型会认真回答这句"用户说的话"。
 */
export function plainText(e: Event): string {
  // message 缺失时直接当"没有文本"，不再回退 raw_message：那段是 CQ 码原文，
  // 一旦回退，模型就会拿到 "[CQ:at,qq=123456]" 这种字符串并认真作答。
  // 与上面注释里的承诺保持一致。
  if (e.message === undefined || e.message === null) return '';
  const segs = segments(e);
  let out = '';
  for (const s of segs) {
    if (s.type !== 'text') continue;
    const t = s.data['text'];
    if (typeof t === 'string') out += t;
  }
  return out.trim();
}

/** 消息里 @ 到的 QQ 号列表（忽略 @全体）。 */
export function atTargets(e: Event): number[] {
  const out: number[] = [];
  for (const s of segments(e)) {
    if (s.type !== 'at') continue;
    const v = s.data['qq'];
    if (typeof v === 'string') {
      if (v === 'all') continue;
      const n = Number.parseInt(v, 10);
      if (!Number.isNaN(n)) out.push(n);
    } else if (typeof v === 'number') {
      out.push(Math.trunc(v));
    }
  }
  return out;
}

export function mentions(e: Event, qq: number): boolean {
  return atTargets(e).includes(qq);
}

export function hasImage(e: Event): boolean {
  return segments(e).some((s) => s.type === 'image');
}

// ---- CQ 码 ----

const CQ_UNESCAPE: [RegExp, string][] = [
  [/&#91;/g, '['],
  [/&#93;/g, ']'],
  [/&#44;/g, ','],
  [/&amp;/g, '&'],
];

function unescapeCQ(s: string): string {
  let out = s;
  for (const [re, to] of CQ_UNESCAPE) out = out.replace(re, to);
  return out;
}

/**
 * 解析 CQ 码字符串。
 *
 * 只处理框架需要的子集：text / at / image / face / reply。
 * 注意 &amp; 必须最后替换，否则 "&amp;#91;" 会被二次解码成 "["。
 * 这里用的是逐条 replace，顺序即上面的数组顺序，所以要把 &amp; 放最后。
 */
export function parseCQ(s: string): Segment[] {
  const out: Segment[] = [];
  let rest = s;

  while (rest.length > 0) {
    const idx = rest.indexOf('[CQ:');
    if (idx < 0) {
      if (rest !== '') out.push(text(unescapeCQ(rest)));
      break;
    }
    if (idx > 0) out.push(text(unescapeCQ(rest.slice(0, idx))));

    const end = rest.indexOf(']', idx);
    if (end < 0) {
      // 没有闭合括号：剩下的整段当纯文本，别把消息吞掉
      out.push(text(rest.slice(idx)));
      break;
    }
    out.push(parseCQBody(rest.slice(idx + 4, end)));
    rest = rest.slice(end + 1);
  }
  return out;
}

function parseCQBody(body: string): Segment {
  const comma = body.indexOf(',');
  const type = comma < 0 ? body : body.slice(0, comma);
  const rest = comma < 0 ? '' : body.slice(comma + 1);

  const data: Record<string, unknown> = {};
  for (const kv of rest.split(',')) {
    if (kv === '') continue;
    const eq = kv.indexOf('=');
    if (eq < 0) continue;
    data[kv.slice(0, eq)] = unescapeCQ(kv.slice(eq + 1));
  }
  return { type, data };
}

// ---- 构造 ----

export function text(s: string): Segment {
  return { type: 'text', data: { text: s } };
}

export function at(qq: number): Segment {
  return { type: 'at', data: { qq: String(qq) } };
}

export function reply(messageId: number): Segment {
  return { type: 'reply', data: { id: String(messageId) } };
}

export function image(file: string): Segment {
  return { type: 'image', data: { file } };
}

/** 把纯文本包成单段消息。 */
export function textSegments(s: string): Segment[] {
  return [text(s)];
}
