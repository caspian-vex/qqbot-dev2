// 图池测试：文件列举、标记解析、白名单匹配、提示词块，以及引擎端到端发图。
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
  dedupeKeepOrder,
  extractImageTags,
  imagePromptBlock,
  imageUri,
  listImages,
  pickImage,
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

// ---- 文件列举 ----

describe('图池列举', () => {
  it('只列图片扩展名，忽略其它文件与子目录，按名称排序', () => {
    const dir = tempDir();
    writeFileSync(join(dir, '乙.png'), 'x');
    writeFileSync(join(dir, '甲.JPG'), 'x');
    writeFileSync(join(dir, '说明.txt'), 'x');
    writeFileSync(join(dir, '无扩展名'), 'x');
    mkdirSync(join(dir, '子目录'));
    writeFileSync(join(dir, '子目录', '藏起来的.png'), 'x');
    assert.deepEqual(listImages(dir), ['甲.JPG', '乙.png']);
  });

  it('目录不存在时返回空数组而不是抛错', () => {
    assert.deepEqual(listImages(join(tempDir(), '不存在')), []);
  });

  it('目录为空串时直接返回空数组', () => {
    assert.deepEqual(listImages(''), []);
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

// ---- 其它纯函数 ----

describe('图池辅助函数', () => {
  it('file:// URI 与 pathToFileURL 一致（Windows 盘符不拼错）', () => {
    const dir = join(tempDir(), 'images');
    assert.equal(imageUri(dir, '猫.png'), `file:///${dir.replace(/\\/g, '/')}/%E7%8C%AB.png`);
  });

  it('提示词块包含清单、上限与覆盖格式约束的说明', () => {
    const block = imagePromptBlock(['a.png', 'b.png'], 1);
    assert.ok(block.includes('a.png'));
    assert.ok(block.includes('b.png'));
    assert.ok(block.includes('[图:文件名]'));
    assert.ok(block.includes('最多输出 1 个'));
  });

  it('提示词块超长清单截断', () => {
    const many = Array.from({ length: 50 }, (_, i) => `f${i}.png`);
    const block = imagePromptBlock(many, 1);
    assert.ok(block.includes('还有 10 张'));
    assert.ok(!block.includes('f49.png'));
  });

  it('去重保序', () => {
    assert.deepEqual(dedupeKeepOrder(['b', 'a', 'b', 'c', 'a']), ['b', 'a', 'c']);
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
