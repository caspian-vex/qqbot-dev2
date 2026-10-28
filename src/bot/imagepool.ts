// 图池：给模型一个"可以发图"的选择权，并让人类在面板里管理它。
//
// 磁盘布局（一个标签 = 一个子目录）：
//
//   data/images/
//   ├── funny/        ← 标签 funny
//   │   ├── 1.jpg
//   │   └── 2.png
//   ├── 可爱/
//   └── 散图.png      ← 老版本平铺在根目录的图，归入「未分类」
//
// 为什么用目录而不是数据库记图片：图池的原始承诺是"往文件夹丢图就能用"。
// 目录即标签意味着用户拷图、删图、建子目录全都即时生效，没有同步动作；
// 数据库里只存标签的备注（那是盘上没地方放、又要给模型看的东西）。
//
// 引擎每次回复时把「标签 + 备注 + 示例文件名」注入系统提示，模型想发图就写
// [图:标签]（随机一张）或 [图:标签/文件名]（指定一张）。解析端只认池子里
// 真实存在的文件，越界一律丢弃——模型会编造名字，也可能拼出 ../。
//
// 纯函数尽量不碰文件系统：只有 listPool / poolFilePath 会读盘，且失败时
// 静默降级（图池读不了不该挡住聊天）。

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';

/** 允许进图池的扩展名。名单之外的文件一律视为不存在。 */
export const IMAGE_EXTS = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp']);

/** 扩展名 → 响应头。面板预览按这个下发 Content-Type。 */
export const IMAGE_MIME: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

/** 平铺在 images/ 根目录的老图归到这个虚拟标签，用户不用手工搬家。 */
export const UNTAGGED = '未分类';

/** 标签名允许的字符：中文、字母、数字、下划线、连字符。要能直接当目录名。 */
const TAG_RE = /^[\p{Script=Han}A-Za-z0-9_-]{1,24}$/u;

/** 提示词里最多列多少个标签，以及每个标签最多列几个文件名。 */
export const MAX_TAGS_LISTED = 12;
export const MAX_FILES_PER_TAG = 5;

/** 一张图在图池里的身份。tag 是目录名，name 是文件名。 */
export interface PoolImage {
  tag: string;
  name: string;
  size: number;
  mtime: number;
}

/** 一个标签及其图片。 */
export interface PoolTag {
  name: string;
  note: string;
  images: PoolImage[];
}

/** 标签名是否可用作目录名。 */
export function isValidTagName(v: string): boolean {
  return TAG_RE.test(v);
}

/**
 * 规范化用户输入的标签名：去首尾空白、把连续空白折成下划线。
 *
 * 不做小写化——中文标签没有大小写，英文标签用户可能就想写 Funny。
 * 大小写不敏感的比较放在 findTag 里，输入和展示都保留用户的写法。
 */
export function normalizeTagName(raw: string): string {
  return raw.trim().replace(/\s+/g, '_');
}

/** 标签对应的目录。未分类直接用图池根目录。 */
export function tagDirOf(baseDir: string, tag: string): string {
  return tag === UNTAGGED || tag === '' ? baseDir : join(baseDir, tag);
}

/**
 * 列出图池：磁盘上的标签目录 + 库里登记但还没建目录的空标签。
 *
 * notes 来自数据库（标签名 → 备注）。目录存在但没有备注的标签也会列出来，
 * 这样用户手工建的文件夹在面板里可见、能补备注。
 */
export function listPool(baseDir: string, notes: Map<string, string> = new Map()): PoolTag[] {
  if (baseDir === '') return [];

  const tags = new Map<string, PoolTag>();
  let entries: { name: string; dir: boolean }[] = [];
  try {
    entries = readdirSync(baseDir, { withFileTypes: true }).map((d) => ({
      name: d.name,
      dir: d.isDirectory(),
    }));
  } catch {
    // 目录不存在：仍然把库里登记的标签列出来，面板才能显示"空池子"
    entries = [];
  }

  const rootImages: PoolImage[] = [];
  for (const e of entries) {
    if (e.dir) {
      // 未分类是虚拟标签（散图就放在根目录），同名的真实目录不参与，
      // 否则面板里会出现两个「未分类」，而它们的增删路径又不是同一个。
      if (e.name === UNTAGGED) continue;
      if (!isValidTagName(e.name)) continue; // 名字不合规的目录不认，避免混进奇怪的路径
      tags.set(e.name, { name: e.name, note: notes.get(e.name) ?? '', images: readImages(baseDir, e.name) });
    } else if (IMAGE_EXTS.has(extname(e.name).toLowerCase())) {
      const st = statOf(join(baseDir, e.name));
      if (st) rootImages.push({ tag: UNTAGGED, name: e.name, size: st.size, mtime: st.mtimeMs });
    }
  }

  // 库里登记但盘上还没建目录的标签：备注要保住，否则用户刚写完备注就"消失"了
  for (const [name, note] of notes) {
    if (name === UNTAGGED) continue;
    if (!isValidTagName(name) || tags.has(name)) continue;
    tags.set(name, { name, note, images: [] });
  }

  const out = [...tags.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
  if (rootImages.length > 0) {
    rootImages.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
    out.push({ name: UNTAGGED, note: notes.get(UNTAGGED) ?? '', images: rootImages });
  }
  return out;
}

/** 读一个标签目录下的图片。读不到就当空目录，图池坏了不该抛错。 */
function readImages(baseDir: string, tag: string): PoolImage[] {
  let names: string[];
  try {
    names = readdirSync(tagDirOf(baseDir, tag));
  } catch {
    return [];
  }
  const out: PoolImage[] = [];
  for (const name of names) {
    if (!IMAGE_EXTS.has(extname(name).toLowerCase())) continue;
    const st = statOf(join(tagDirOf(baseDir, tag), name));
    if (st === null) continue; // 列目录与 stat 之间被删了：跳过这张
    out.push({ tag, name, size: st.size, mtime: st.mtimeMs });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
}

function statOf(p: string): { size: number; mtimeMs: number } | null {
  try {
    const st = statSync(p);
    return st.isFile() ? { size: st.size, mtimeMs: st.mtimeMs } : null;
  } catch {
    return null;
  }
}

/**
 * 拼一个池内文件的绝对路径，越界返回 null。
 *
 * 面板的预览/删除/上传都从这里取路径：标签名与文件名都要过白名单，
 * 任何一个不合规就整条请求作废，绝不做"清洗后继续用"。
 */
export function poolFilePath(baseDir: string, tag: string, name: string): string | null {
  if (baseDir === '') return null;
  if (tag !== UNTAGGED && !isValidTagName(tag)) return null;
  if (name === '' || name === '.' || name === '..') return null;
  if (/[/\\\u0000-\u001f]/.test(name)) return null;
  if (!IMAGE_EXTS.has(extname(name).toLowerCase())) return null;
  return join(tagDirOf(baseDir, tag), name);
}

/**
 * 从模型回复里抽出所有发图标记，并把它们从正文里剥掉。
 *
 * 同时认半角 [图:xxx] 与全角【图：xxx】——模型在中文语境里
 * 经常自作主张换成全角括号，解析端兼容比在提示词里反复强调更可靠。
 * 未解析成功（池子关着、文件不存在）时标记也一并剥掉：
 * 宁可少发一张图，也不能把 "[图:xx]" 这串符号当聊天内容发出去。
 */
export function extractImageTags(text: string): { text: string; tags: string[] } {
  const tags: string[] = [];
  const body = text.replace(/[【[]\s*图\s*[:：]\s*([^\]】]{1,120}?)\s*[】\]]/g, (_m, name: string) => {
    tags.push(name.trim());
    return '';
  });
  return { text: body.trim(), tags };
}

/**
 * 把模型点名的文件匹配到图池里的真实文件名。
 *
 * 三级匹配：全名精确 → 忽略大小写 → 按去掉扩展名的主名匹配
 * （模型经常只写"风景 01"不写后缀）。全部落空返回 null——
 * 拒绝模糊匹配（比如前缀相似就当命中），否则"猫1.jpg"会被
 * 错发成"猫12.jpg"，这种错发比不发更糟。
 */
export function pickImage(requested: string, files: string[]): string | null {
  const want = requested.trim();
  if (want === '') return null;
  if (files.includes(want)) return want;
  const lower = want.toLowerCase();
  const stemOf = (f: string): string => f.toLowerCase().replace(/\.[a-z0-9]+$/, '');
  return (
    files.find((f) => {
      const fl = f.toLowerCase();
      return fl === lower || stemOf(fl) === lower || stemOf(fl) === stemOf(lower);
    }) ?? null
  );
}

/** 按名字找标签，大小写不敏感。 */
function findTag(tags: PoolTag[], name: string): PoolTag | null {
  const want = name.trim();
  if (want === '') return null;
  const exact = tags.find((t) => t.name === want);
  if (exact) return exact;
  const lower = want.toLowerCase();
  return tags.find((t) => t.name.toLowerCase() === lower) ?? null;
}

/**
 * 解析一个发图标记，返回要发的图。
 *
 * 三种写法：
 *   [图:funny]          → 该标签里随机一张（模型只需要判断"该发哪一类"）
 *   [图:funny/1.jpg]    → 指定某一张
 *   [图:1.jpg]          → 全池按文件名找（老写法，兼容）
 *
 * 标签不存在、图片不存在、标签是空的，一律返回 null。
 * rng 注入是为了让测试能固定随机结果。
 */
export function resolveImage(
  request: string,
  tags: PoolTag[],
  rng: () => number = Math.random,
): PoolImage | null {
  const want = request.trim().replace(/^[「『"'\s]+|[」』"'\s]+$/g, '');
  if (want === '') return null;

  const cut = Math.max(want.lastIndexOf('/'), want.lastIndexOf('\\'));
  if (cut >= 0) {
    const tag = findTag(tags, want.slice(0, cut));
    if (!tag) return null;
    const name = pickImage(want.slice(cut + 1), tag.images.map((i) => i.name));
    return name === null ? null : (tag.images.find((i) => i.name === name) ?? null);
  }

  const byTag = findTag(tags, want);
  if (byTag) {
    if (byTag.images.length === 0) return null;
    // rng 理论上落在 [0,1)，夹一下防止实现异常时越界
    const idx = Math.min(byTag.images.length - 1, Math.floor(rng() * byTag.images.length));
    return byTag.images[Math.max(0, idx)] ?? null;
  }

  for (const t of tags) {
    const name = pickImage(want, t.images.map((i) => i.name));
    if (name !== null) return t.images.find((i) => i.name === name) ?? null;
  }
  return null;
}

/** 图片在提示词与聊天记录里的写法：未分类不带前缀，避免记录里出现多余目录名。 */
export function imageLabel(img: PoolImage): string {
  return img.tag === UNTAGGED ? img.name : `${img.tag}/${img.name}`;
}

/**
 * 单张图的最大字节数。
 *
 * 超过就不发：一来 QQ 自己的图片上限就在 20MB 上下，二来 base64 会把体积
 * 放大 1/3，在 1 核 2G 的机器上读一张 10MB 的图会明显卡一下。
 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

/**
 * 把池内图片读成 OneBot 的 base64 段数据（`base64://...`）。
 *
 * 为什么不发 file:// 路径：qqbot 与协议端是两个容器，图池目录只挂在
 * qqbot 这一侧，协议端拿到的绝对路径在它自己的文件系统里根本不存在，
 * 于是"发图"会静默失败（只在协议端日志里留一条读文件失败）。
 * base64 是 OneBot v11 明确支持的形态，与两边怎么挂载无关；
 * 本地开发（同一文件系统）也照样能用。
 *
 * 读不到、超限都返回 null：少发一张图，绝不能把聊天搞挂。
 */
export function imageBase64(dir: string, name: string): string | null {
  if (dir === '' || name === '') return null;
  const full = join(dir, name);
  try {
    const st = statSync(full);
    if (!st.isFile() || st.size <= 0 || st.size > MAX_IMAGE_BYTES) return null;
    return `base64://${readFileSync(full).toString('base64')}`;
  } catch {
    return null;
  }
}

/**
 * 注入系统提示的图池说明块。
 *
 * 标签的备注是这段提示的核心：模型靠备注判断"此刻该发哪一类图"，
 * 所以备注要原样给出，只截断过长的。放在格式约束之后拼接，
 * 并显式压一句"不要提图池"——FORMAT_RULES 里有"不要输出占位符"，
 * 不显式压一句的话模型会认死理不发图。
 *
 * 只在池子非空时调用，空池子不浪费提示词预算。
 */
export function poolPromptBlock(tags: PoolTag[], maxPerReply: number): string {
  const usable = tags.filter((t) => t.images.length > 0);
  const listed = usable.slice(0, MAX_TAGS_LISTED);

  const lines = listed.map((t) => {
    const note = t.note.trim() === '' ? '（无备注）' : t.note.trim().replace(/\s+/g, ' ');
    const sample = t.images.slice(0, MAX_FILES_PER_TAG).map((i) => i.name).join('、');
    const more = t.images.length > MAX_FILES_PER_TAG ? ` 等 ${t.images.length} 张` : '';
    return `- ${t.name}（${note}）：${sample}${more}`;
  });

  const rest = usable.length - listed.length;
  if (rest > 0) lines.push(`- （还有 ${rest} 个标签未列出）`);

  return [
    '',
    '图池：',
    '- 你有一个按标签分类的图池，括号里是这个标签的图片说明，用它判断此刻适合发哪一类：',
    ...lines,
    '- 想发图就在回复的最末尾单独一行写 [图:标签]（从该标签里随机发一张），想指定某张就写 [图:标签/文件名]',
    `- 每条回复最多输出 ${maxPerReply} 个图标记；没有合适的就不发，不要提图池本身，也不要解释这个规则`,
  ].join('\n');
}

/** 去重且保序。同一张图点两次名只发一张。 */
export function dedupeKeepOrder(items: string[]): string[] {
  return [...new Set(items)];
}

/** 按 标签/文件名 去重且保序。 */
export function dedupeImages(items: PoolImage[]): PoolImage[] {
  const seen = new Set<string>();
  const out: PoolImage[] = [];
  for (const it of items) {
    const k = `${it.tag}/${it.name}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(it);
  }
  return out;
}

/**
 * 按文件头判断图片类型，返回应使用的扩展名；认不出返回 null。
 *
 * 上传时只信文件头，不信 Content-Type 与用户给的文件名：
 * 把 .html 改名成 .png 传上来，如果照单全收，面板就会把它当图片发出去
 * （虽然 CSP 与 nosniff 挡住了执行，但发到 QQ 上依然是一张坏图）。
 */
export function sniffImageExt(b: Buffer): string | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return '.jpg';
  if (
    b.length >= 8 &&
    b[0] === 0x89 &&
    b[1] === 0x50 &&
    b[2] === 0x4e &&
    b[3] === 0x47 &&
    b[4] === 0x0d &&
    b[5] === 0x0a &&
    b[6] === 0x1a &&
    b[7] === 0x0a
  ) {
    return '.png';
  }
  if (b.length >= 6) {
    const head = b.subarray(0, 6).toString('latin1');
    if (head === 'GIF87a' || head === 'GIF89a') return '.gif';
  }
  if (
    b.length >= 12 &&
    b.subarray(0, 4).toString('latin1') === 'RIFF' &&
    b.subarray(8, 12).toString('latin1') === 'WEBP'
  ) {
    return '.webp';
  }
  if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4d) return '.bmp';
  return null;
}

/**
 * 把用户上传时带的文件名收成一个安全的词干。
 *
 * 只保留中英文、数字、空格、下划线、连字符、括号，其余折成下划线；
 * 空结果退回 "img"。扩展名不在这里处理——上传端按文件头嗅探决定。
 */
export function sanitizeStem(raw: string): string {
  const base = raw.replace(/\.[A-Za-z0-9]{1,8}$/, '');
  const cleaned = base
    .replace(/[/\\\u0000-\u001f]/g, '_')
    .replace(/[^\p{Script=Han}A-Za-z0-9 _\-()（）]/gu, '_')
    .replace(/\s+/g, ' ')
    .replace(/^[_\s.]+|[_\s.]+$/g, '')
    .slice(0, 60)
    .trim();
  return cleaned === '' ? 'img' : cleaned;
}

/** 在已有文件名里找一个不冲突的名字：a.png → a-2.png → a-3.png。 */
export function uniqueName(stem: string, ext: string, existing: Set<string>): string {
  let name = `${stem}${ext}`;
  for (let i = 2; existing.has(name) && i < 1000; i++) {
    name = `${stem}-${i}${ext}`;
  }
  return name;
}
