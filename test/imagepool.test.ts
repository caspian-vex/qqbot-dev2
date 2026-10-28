// 图池测试：标签列举、标记解析、白名单匹配、提示词块，以及引擎端到端发图。
//
// 端到端用例用一个会说"我要发图"的假模型 + 会记账的假协议端，
// 验证三件最怕出错的事：图真的发出去了、[图:xx] 标记没漏进聊天、
// 关掉开关后标记被剥干净。
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  UNTAGGED,
  dedupeImages,
  dedupeKeepOrder,
  extractImageTags,
  imageLabel,
  imageUri,
  isValidTagName,
  listPool,
  normalizeTagName,
  pickImage,
  poolFilePath,
  poolPromptBlock,
  resolveImage,
  sanitizeStem,
  sniffImageExt,
  uniqueName,
  type PoolTag,
} from '../src/bot';
import { Engine } from '../src/bot/engine';
import type { LlmClient } from '../src/llm/client';
import type { Event, Segment } from '../src/onebot/types';
import { Store } from '../src/store';
import { defaultSettings } from '../src/store/types';

const tmpDirs: string[] = [];
const stores: Store[] = [];
after(() => {
  // Windows 上 SQLite 文件被占用时删不掉：先关库再删目录
  for (const s of stores) s.close();
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-img-'));
  tmpDirs.push(dir);
  return dir;
}

/** 造一个图池：tags 里每项是「标签目录 → 文件名列表」，root 是散图。 */
function makePool(tags: Record<string, string[]>, root: string[] = []): string {
  const dir = tempDir();
  for (const [tag, files] of Object.entries(tags)) {
    mkdirSync(join(dir, tag), { recursive: true });
    for (const f of files) writeFileSync(join(dir, tag, f), 'fake-image-bytes');
  }
  for (const f of root) writeFileSync(join(dir, f), 'fake-image-bytes');
  return dir;
}

const tagOf = (pool: PoolTag[], name: string): PoolTag | undefined => pool.find((t) => t.name === name);

// ---- 标签列举 ----

describe('图池列举', () => {
  it('一个子目录就是一个标签，根目录的散图归入未分类', () => {
    const dir = makePool({ funny: ['1.png', '2.jpg'], 可爱: ['猫.webp'] }, ['散图.png']);
    const pool = listPool(dir);
    // 真实标签按名称排序，未分类固定排在最后
    assert.deepEqual(
      pool.map((t) => t.name),
      ['可爱', 'funny', UNTAGGED],
    );
    assert.equal(tagOf(pool, 'funny')?.images.length, 2);
    assert.equal(tagOf(pool, UNTAGGED)?.images[0]?.name, '散图.png');
    assert.equal(tagOf(pool, '可爱')?.images[0]?.name, '猫.webp');
  });

  it('非图片文件不算图片，标签里的子目录也不算', () => {
    const dir = makePool({ funny: ['1.png', '说明.txt'] });
    mkdirSync(join(dir, 'funny', '更深一层'));
    assert.deepEqual(
      tagOf(listPool(dir), 'funny')?.images.map((i) => i.name),
      ['1.png'],
    );
  });

  it('备注从库里带出来，没有备注的标签也照样列出', () => {
    const dir = makePool({ funny: ['1.png'], 手工建的: ['2.png'] });
    const notes = new Map([['funny', '好笑的梗图']]);
    const pool = listPool(dir, notes);
    assert.equal(tagOf(pool, 'funny')?.note, '好笑的梗图');
    assert.equal(tagOf(pool, '手工建的')?.note, '');
  });

  it('库里登记了但盘上还没建目录的标签也会出现（备注不会丢）', () => {
    const dir = makePool({});
    const pool = listPool(dir, new Map([['空标签', '还没传图']]));
    assert.equal(pool.length, 1);
    assert.equal(pool[0]?.name, '空标签');
    assert.deepEqual(pool[0]?.images, []);
  });

  it('名字不合规的目录不认，避免把奇怪的路径带进提示词', () => {
    const dir = makePool({});
    mkdirSync(join(dir, '带 空格'));
    mkdirSync(join(dir, 'a.b'));
    assert.deepEqual(listPool(dir), []);
  });

  it('目录不存在时返回空数组而不是抛错', () => {
    assert.deepEqual(listPool(join(tempDir(), '不存在')), []);
  });

  it('目录为空串时直接返回空数组', () => {
    assert.deepEqual(listPool(''), []);
  });
});

describe('标签名', () => {
  it('允许中文、字母、数字、下划线、连字符', () => {
    for (const n of ['funny', '可爱', 'cat_1', 'a-b', '猫2']) assert.ok(isValidTagName(n), n);
  });

  it('拒绝路径分隔符、空格、点、超长与空串', () => {
    for (const n of ['', 'a/b', 'a\\b', '带 空格', '..', 'a.b', 'x'.repeat(25)]) {
      assert.ok(!isValidTagName(n), n);
    }
  });

  it('规范化把空白折成下划线并去首尾空白', () => {
    assert.equal(normalizeTagName('  funny  '), 'funny');
    assert.equal(normalizeTagName('好 笑'), '好_笑');
  });
});

// ---- 标记解析 ----

describe('发图标记解析', () => {
  it('剥掉半角标记并返回文件名', () => {
    const r = extractImageTags('看这只猫\n[图:猫.png]');
    assert.equal(r.text, '看这只猫');
    assert.deepEqual(r.tags, ['猫.png']);
  });

  it('兼容全角括号与全角冒号', () => {
    const r = extractImageTags('来了【图：狗.jpg】');
    assert.equal(r.text, '来了');
    assert.deepEqual(r.tags, ['狗.jpg']);
  });

  it('没有标记时原样返回', () => {
    const r = extractImageTags('普通回复');
    assert.equal(r.text, '普通回复');
    assert.deepEqual(r.tags, []);
  });

  it('一条回复里的多个标记全部抽出', () => {
    const r = extractImageTags('[图:a.png]中间的话[图:b.png]');
    assert.equal(r.text, '中间的话');
    assert.deepEqual(r.tags, ['a.png', 'b.png']);
  });

  it('标记里不会匹配到换行后面的内容', () => {
    const r = extractImageTags('正文 [图:a.png]\n下一行不是标记');
    assert.ok(r.text.startsWith('正文'), `前半句保留: ${r.text}`);
    assert.ok(r.text.endsWith('下一行不是标记'), `后半句保留: ${r.text}`);
    assert.ok(!r.text.includes('[图:'));
    assert.deepEqual(r.tags, ['a.png']);
  });
});

// ---- 白名单匹配 ----

describe('图片挑选', () => {
  const files = ['猫.png', 'Dog.JPG', '风景 01.webp'];

  it('全名精确命中', () => {
    assert.equal(pickImage('猫.png', files), '猫.png');
  });

  it('忽略大小写命中', () => {
    assert.equal(pickImage('dog.jpg', files), 'Dog.JPG');
  });

  it('模型忘了写扩展名时按主名匹配', () => {
    assert.equal(pickImage('风景 01', files), '风景 01.webp');
  });

  it('对不上就返回 null，绝不做模糊匹配', () => {
    assert.equal(pickImage('猫2.png', files), null);
    assert.equal(pickImage('', files), null);
    assert.equal(pickImage('../etc/passwd', files), null);
  });
});

// ---- 标签/文件解析 ----

describe('按标签选图', () => {
  const dir = makePool({ funny: ['1.png', '2.png'], 可爱: ['猫.webp'] }, ['散图.png']);
  const pool = listPool(dir);

  it('只写标签名时从该标签里随机取一张', () => {
    const got = resolveImage('funny', pool, () => 0);
    assert.equal(got?.tag, 'funny');
    assert.equal(got?.name, '1.png');
    assert.equal(resolveImage('funny', pool, () => 0.99)?.name, '2.png');
  });

  it('标签名大小写不敏感', () => {
    assert.equal(resolveImage('FUNNY', pool, () => 0)?.tag, 'funny');
  });

  it('标签/文件名 指定具体一张', () => {
    assert.equal(resolveImage('funny/2.png', pool)?.name, '2.png');
    assert.equal(resolveImage('funny/2', pool)?.name, '2.png');
    assert.equal(resolveImage('可爱/猫', pool)?.name, '猫.webp');
  });

  it('只写文件名时全池找（兼容老写法）', () => {
    const got = resolveImage('猫.webp', pool);
    assert.equal(got?.tag, '可爱');
    assert.equal(got?.name, '猫.webp');
  });

  it('散图用未分类标签也能点名', () => {
    assert.equal(resolveImage(UNTAGGED, pool)?.name, '散图.png');
  });

  it('标签不存在、文件不存在、标签为空都返回 null', () => {
    assert.equal(resolveImage('不存在', pool), null);
    assert.equal(resolveImage('funny/9.png', pool), null);
    assert.equal(resolveImage('', pool), null);
    assert.equal(resolveImage('../etc/passwd', pool), null);
    assert.equal(resolveImage('空标签', listPool(dir, new Map([['空标签', 'x']]))), null);
  });

  it('图片在提示词里的写法：未分类不带前缀', () => {
    const root = resolveImage('散图.png', pool);
    assert.ok(root);
    assert.equal(imageLabel(root), '散图.png');
    assert.equal(imageLabel({ tag: 'funny', name: '1.png', size: 0, mtime: 0 }), 'funny/1.png');
  });
});

// ---- 路径安全 ----

describe('池内路径', () => {
  const dir = makePool({ funny: ['1.png'] }, ['散图.png']);

  it('正常组合落在标签目录里', () => {
    assert.equal(poolFilePath(dir, 'funny', '1.png'), join(dir, 'funny', '1.png'));
    assert.equal(poolFilePath(dir, UNTAGGED, '散图.png'), join(dir, '散图.png'));
  });

  it('穿越与非法扩展名一律 null', () => {
    assert.equal(poolFilePath(dir, 'funny', '../../qqbot.db'), null);
    assert.equal(poolFilePath(dir, '..', '1.png'), null);
    assert.equal(poolFilePath(dir, 'funny', '1.exe'), null);
    assert.equal(poolFilePath(dir, 'a/b', '1.png'), null);
    assert.equal(poolFilePath('', 'funny', '1.png'), null);
  });
});

// ---- 提示词块 ----

describe('提示词块', () => {
  it('列出标签、备注与示例文件名，并说明两种标记写法', () => {
    const dir = makePool({ funny: ['1.png', '2.png'] });
    const block = poolPromptBlock(listPool(dir, new Map([['funny', '好笑的梗图']])), 1);
    assert.ok(block.includes('funny（好笑的梗图）'));
    assert.ok(block.includes('1.png'));
    assert.ok(block.includes('[图:标签]'));
    assert.ok(block.includes('[图:标签/文件名]'));
    assert.ok(block.includes('最多输出 1 个'));
  });

  it('没有备注的标签标注为无备注', () => {
    const dir = makePool({ funny: ['1.png'] });
    assert.ok(poolPromptBlock(listPool(dir), 1).includes('funny（（无备注）'));
  });

  it('空标签不进提示词，池子为空时只剩空行', () => {
    const dir = makePool({});
    assert.ok(!poolPromptBlock(listPool(dir, new Map([['空标签', 'x']])), 1).includes('空标签'));
  });

  it('标签太多时截断并说明还有多少', () => {
    const tags: PoolTag[] = Array.from({ length: 15 }, (_, i) => ({
      name: `t${i}`,
      note: '',
      images: [{ tag: `t${i}`, name: 'a.png', size: 1, mtime: 0 }],
    }));
    const block = poolPromptBlock(tags, 1);
    assert.ok(block.includes('t11'));
    assert.ok(!block.includes('t12'));
    assert.ok(block.includes('还有 3 个标签'));
  });

  it('单个标签的文件太多时只列前几个', () => {
    const dir = makePool({ funny: ['1.png', '2.png', '3.png', '4.png', '5.png', '6.png'] });
    const block = poolPromptBlock(listPool(dir), 1);
    assert.ok(block.includes('5.png'));
    assert.ok(!block.includes('6.png'));
    assert.ok(block.includes('等 6 张'));
  });
});

// ---- 上传辅助 ----

describe('上传辅助', () => {
  it('按文件头识别扩展名', () => {
    assert.equal(sniffImageExt(Buffer.from([0xff, 0xd8, 0xff, 0x00])), '.jpg');
    assert.equal(sniffImageExt(Buffer.from('89504e470d0a1a0a', 'hex')), '.png');
    assert.equal(sniffImageExt(Buffer.from('GIF89a......', 'latin1')), '.gif');
    assert.equal(sniffImageExt(Buffer.from('RIFF....WEBPVP8 ', 'latin1')), '.webp');
    assert.equal(sniffImageExt(Buffer.from('BM........', 'latin1')), '.bmp');
  });

  it('伪装成图片的其它文件认不出来', () => {
    assert.equal(sniffImageExt(Buffer.from('<html><body>hi</body></html>')), null);
    assert.equal(sniffImageExt(Buffer.from('')), null);
  });

  it('文件名去掉危险字符，空名退回 img', () => {
    assert.equal(sanitizeStem('猫 图(1).png'), '猫 图(1)');
    assert.equal(sanitizeStem('../../etc/passwd'), 'etc_passwd');
    assert.equal(sanitizeStem('.gitignore'), 'gitignore');
    assert.equal(sanitizeStem(''), 'img');
  });

  it('重名时追加序号', () => {
    assert.equal(uniqueName('a', '.png', new Set()), 'a.png');
    assert.equal(uniqueName('a', '.png', new Set(['a.png'])), 'a-2.png');
    assert.equal(uniqueName('a', '.png', new Set(['a.png', 'a-2.png'])), 'a-3.png');
  });
});

// ---- 其它纯函数 ----

describe('图池辅助函数', () => {
  it('file:// URI 与 pathToFileURL 一致（Windows 盘符不拼错）', () => {
    const dir = join(tempDir(), 'images');
    assert.equal(imageUri(dir, '猫.png'), `file:///${dir.replace(/\\/g, '/')}/%E7%8C%AB.png`);
  });

  it('去重保序', () => {
    assert.deepEqual(dedupeKeepOrder(['b', 'a', 'b', 'c', 'a']), ['b', 'a', 'c']);
    assert.deepEqual(
      dedupeImages([
        { tag: 'a', name: '1.png', size: 0, mtime: 0 },
        { tag: 'b', name: '1.png', size: 0, mtime: 0 },
        { tag: 'a', name: '1.png', size: 0, mtime: 0 },
      ]).map((i) => `${i.tag}/${i.name}`),
      ['a/1.png', 'b/1.png'],
    );
  });
});

// ---- 引擎端到端 ----

interface SentCall {
  target: number;
  segs: Segment[];
}

function fakeLlm(replyText: string): LlmClient {
  return {
    chat: async () => ({
      content: replyText,
      usage: { prompt_tokens: 10, completion_tokens: 5 },
      firstTokenMs: 1,
    }),
  } as unknown as LlmClient;
}

function privateEv(text: string): Event {
  return {
    time: 0,
    self_id: 10000,
    post_type: 'message',
    message_type: 'private',
    message_id: 1,
    user_id: 20000,
    group_id: 0,
    message: [{ type: 'text', data: { text } }],
    raw: {},
  };
}

interface Harness {
  engine: Engine;
  sent: SentCall[];
  imagesDir: string;
  store: Store;
  sid: string;
}

function setup(replyText: string, imagesEnabled: boolean, poolFile?: string): Harness {
  const home = tempDir();
  const store = new Store(join(home, 'qqbot.db'));
  stores.push(store);
  const s = defaultSettings();
  s.images.enabled = imagesEnabled;
  store.settings.save(s);

  const imagesDir = join(home, 'images');
  mkdirSync(imagesDir, { recursive: true });
  if (poolFile) writeFileSync(join(imagesDir, poolFile), 'fake-image-bytes');

  const sent: SentCall[] = [];
  const engine = new Engine({
    store,
    log: { with: () => ({ debug: () => {}, info: () => {}, warn: () => {}, error: () => {} }) } as never,
    llm: fakeLlm(replyText),
    imagesDir,
  });
  engine.setSelf(10000, '小Q');
  engine.setSender({
    sendGroup: async (id, segs) => {
      sent.push({ target: id, segs });
      return 1;
    },
    sendPrivate: async (id, segs) => {
      sent.push({ target: id, segs });
      return 2;
    },
    groupInfo: async () => '测试群',
  });
  return { engine, sent, imagesDir, store, sid: 'private:20000' };
}

/** 等队列把回复跑完：引擎内部是异步任务队列，只能轮询。 */
async function waitSent(h: Harness, atLeast = 1): Promise<void> {
  for (let i = 0; i < 100 && h.sent.length < atLeast; i++) {
    await new Promise((r) => setTimeout(r, 30));
  }
  await new Promise((r) => setTimeout(r, 30));
}

describe('引擎发图链路', () => {
  it('模型带发图标记且池内有同名文件：文字与图片都发出，标记不漏进聊天', async () => {
    const h = setup('看这只猫\n[图:猫.png]', true, '猫.png');

    h.engine.handleEvent(privateEv('来张猫图'));
    await waitSent(h);

    assert.equal(h.sent.length, 2, '文字一条、图片一条');
    const textSegs = h.sent[0]!.segs;
    assert.equal(textSegs[0]!.type, 'text');
    assert.ok(!JSON.stringify(textSegs).includes('[图:'), '标记绝不能出现在消息里');
    const imgCall = h.sent[1]!;
    assert.equal(imgCall.segs.length, 1);
    assert.equal(imgCall.segs[0]!.type, 'image');
    assert.ok(String(imgCall.segs[0]!.data['file']).startsWith('file://'), '图片用 file:// URI 发送');

    const history = h.store.sessions.recent(h.sid, 5);
    const last = history[history.length - 1]!;
    assert.ok(last.content.includes('发了一张图：猫.png'), '历史里要补记发图备注');
  });

  it('模型只点标签名：从该标签目录里挑一张发出去', async () => {
    const h = setup('哈哈这个太好笑了\n[图:funny]', true);
    mkdirSync(join(h.imagesDir, 'funny'), { recursive: true });
    writeFileSync(join(h.imagesDir, 'funny', 'meme.png'), 'fake-image-bytes');
    h.store.imageTags.save('funny', '好笑的梗图');

    h.engine.handleEvent(privateEv('哈哈哈笑死'));
    await waitSent(h, 2);

    assert.equal(h.sent.length, 2, '文字一条、图片一条');
    const file = String(h.sent[1]!.segs[0]!.data['file']);
    assert.ok(file.includes('funny'), `应指向 funny 目录：${file}`);
    assert.ok(file.endsWith('meme.png'), file);

    const history = h.store.sessions.recent(h.sid, 5);
    const last = history[history.length - 1]!;
    assert.ok(last.content.includes('funny/meme.png'), '历史里要能看出是从哪个标签发的');
  });

  it('开关关闭时标记被剥掉，只发文字不发图', async () => {
    const h = setup('看这只猫[图:猫.png]', false, '猫.png');

    h.engine.handleEvent(privateEv('来张猫图'));
    await waitSent(h);

    assert.equal(h.sent.length, 1, '只发文字');
    const joined = h.sent[0]!.segs.map((x) => x.data['text']).join('');
    assert.ok(joined.includes('看这只猫'));
    assert.ok(!joined.includes('[图:'));
  });

  it('池里没有模型点名的文件：不发图也不报错', async () => {
    const h = setup('看这只猫[图:不存在的.png]', true, '猫.png');

    h.engine.handleEvent(privateEv('来张猫图'));
    await waitSent(h);

    assert.equal(h.sent.length, 1, '只发文字');
    assert.ok(!JSON.stringify(h.sent[0]!.segs).includes('image'));
  });

  it('模型只发图不说话：单独一条图片消息', async () => {
    const h = setup('[图:猫.png]', true, '猫.png');

    h.engine.handleEvent(privateEv('来张猫图'));
    await waitSent(h);

    assert.equal(h.sent.length, 1);
    assert.equal(h.sent[0]!.segs[0]!.type, 'image');
  });
});
