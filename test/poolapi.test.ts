// 图池面板接口测试：标签增删改、上传、删除、原图预览与越权防护。
//
// 这一层是最容易出安全问题的地方（用户可控的路径 + 文件写入），
// 所以测试重点不在"能不能用"，而在"越界能不能被挡住"。
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { hashPassword } from '../src/panel/auth';
import { PanelServer } from '../src/panel/server';
import { Store } from '../src/store';

const PASSWORD = 'test-password-123';

/** 8 字节 PNG 签名就够嗅探用了，不需要真图。 */
const PNG = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.from('fake-png-body')]);

const tmpDirs: string[] = [];

const log = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  with: () => log,
};

interface Harness {
  base: string;
  cookie: string;
  csrf: string;
  imagesDir: string;
  stop: () => Promise<void>;
}

async function start(): Promise<Harness> {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-pool-'));
  tmpDirs.push(dir);

  const store = new Store(join(dir, 'qqbot.db'));
  const hash = await hashPassword(PASSWORD);
  store.settings.update((v) => {
    v.panel.admin_user = 'admin';
    v.panel.password_hash = hash;
  });

  const imagesDir = join(dir, 'images');
  mkdirSync(imagesDir, { recursive: true });

  const panel = new PanelServer({
    store,
    log: log as never,
    webDir: join(process.cwd(), 'web', 'dist'),
    imagesDir,
  });
  const port = await panel.listen('127.0.0.1:0');
  const base = `http://127.0.0.1:${port}`;

  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: PASSWORD }),
  });
  assert.equal(res.status, 200);
  const cookies = res.headers.getSetCookie();
  const pick = (n: string): string =>
    cookies.find((c) => c.startsWith(`${n}=`))?.slice(n.length + 1).split(';')[0] ?? '';

  return {
    base,
    cookie: `qqbot_session=${pick('qqbot_session')}; qqbot_csrf=${pick('qqbot_csrf')}`,
    csrf: pick('qqbot_csrf'),
    imagesDir,
    stop: async () => {
      await panel.close(500);
      store.close();
    },
  };
}

interface TagView {
  name: string;
  note: string;
  count: number;
  images: { name: string; size: number }[];
}
interface PoolView {
  dir: string;
  total: number;
  tags: TagView[];
}

let h: Harness;
before(async () => {
  h = await start();
});
// 顺序要紧：先停服务并关库，再删临时目录。
// 反过来的话 Windows 上 SQLite 文件还占着句柄，rmSync 会 EBUSY。
after(async () => {
  await h?.stop();
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

async function listPool(): Promise<PoolView> {
  const res = await fetch(`${h.base}/api/image-tags`, { headers: { Cookie: h.cookie } });
  assert.equal(res.status, 200);
  return (await res.json()) as PoolView;
}

async function saveTag(name: string, note: string): Promise<Response> {
  return fetch(`${h.base}/api/image-tags`, {
    method: 'PUT',
    headers: { Cookie: h.cookie, 'X-CSRF-Token': h.csrf, 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, note }),
  });
}

async function upload(tag: string, name: string, body: Buffer, type = 'image/png'): Promise<Response> {
  return fetch(
    `${h.base}/api/images/upload?tag=${encodeURIComponent(tag)}&name=${encodeURIComponent(name)}`,
    {
      method: 'POST',
      headers: { Cookie: h.cookie, 'X-CSRF-Token': h.csrf, 'Content-Type': type },
      body,
    },
  );
}

describe('图池标签接口', () => {
  it('初始是空池子', async () => {
    const pool = await listPool();
    assert.equal(pool.dir, h.imagesDir);
    assert.deepEqual(pool.tags, []);
    assert.equal(pool.total, 0);
  });

  it('新建标签会建目录并保存备注', async () => {
    const res = await saveTag('funny', '好笑的梗图');
    assert.equal(res.status, 200);
    assert.ok(existsSync(join(h.imagesDir, 'funny')), '标签目录应被创建');

    const pool = await listPool();
    assert.equal(pool.tags.length, 1);
    assert.equal(pool.tags[0]!.name, 'funny');
    assert.equal(pool.tags[0]!.note, '好笑的梗图');
    assert.equal(pool.tags[0]!.count, 0);
  });

  it('重复保存同名标签只更新备注，不报错', async () => {
    assert.equal((await saveTag('funny', '好笑的梗图与表情包')).status, 200);
    const pool = await listPool();
    assert.equal(pool.tags.filter((t) => t.name === 'funny').length, 1);
    assert.equal(pool.tags[0]!.note, '好笑的梗图与表情包');
  });

  it('非法标签名被拒绝', async () => {
    for (const bad of ['a/b', '..', 'a.b', '']) {
      assert.equal((await saveTag(bad, 'x')).status, 400, bad);
    }
  });

  it('带空格的标签名被折成下划线，而不是报错', async () => {
    assert.equal((await saveTag('好 笑', '空格换成下划线')).status, 200);
    const pool = await listPool();
    assert.ok(pool.tags.some((t) => t.name === '好_笑' && t.note === '空格换成下划线'));
  });

  it('备注过长被拒绝', async () => {
    assert.equal((await saveTag('long', 'x'.repeat(301))).status, 400);
  });

  it('改名会连目录一起改', async () => {
    await saveTag('旧名', '备注');
    const res = await fetch(`${h.base}/api/image-tags/rename`, {
      method: 'POST',
      headers: { Cookie: h.cookie, 'X-CSRF-Token': h.csrf, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: '旧名', to: '新名' }),
    });
    assert.equal(res.status, 200);
    assert.ok(existsSync(join(h.imagesDir, '新名')));
    assert.ok(!existsSync(join(h.imagesDir, '旧名')));
    const pool = await listPool();
    assert.ok(pool.tags.some((t) => t.name === '新名' && t.note === '备注'));
  });

  it('改到已存在的标签名会被拒绝', async () => {
    const res = await fetch(`${h.base}/api/image-tags/rename`, {
      method: 'POST',
      headers: { Cookie: h.cookie, 'X-CSRF-Token': h.csrf, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: '新名', to: 'funny' }),
    });
    assert.equal(res.status, 400);
  });

  it('未分类不能改名也不能删除', async () => {
    const rename = await fetch(`${h.base}/api/image-tags/rename`, {
      method: 'POST',
      headers: { Cookie: h.cookie, 'X-CSRF-Token': h.csrf, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: '未分类', to: 'x' }),
    });
    assert.equal(rename.status, 400);
    const del = await fetch(`${h.base}/api/image-tags?name=${encodeURIComponent('未分类')}`, {
      method: 'DELETE',
      headers: { Cookie: h.cookie, 'X-CSRF-Token': h.csrf },
    });
    assert.equal(del.status, 400);
  });
});

describe('图池上传与删除', () => {
  it('上传 PNG 后能在清单里看到', async () => {
    const res = await upload('funny', 'meme.png', PNG);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { tag: string; name: string };
    assert.equal(body.tag, 'funny');
    assert.equal(body.name, 'meme.png');
    assert.ok(existsSync(join(h.imagesDir, 'funny', 'meme.png')));

    const pool = await listPool();
    const t = pool.tags.find((x) => x.name === 'funny')!;
    assert.equal(t.count, 1);
    assert.equal(t.images[0]!.name, 'meme.png');
  });

  it('同名上传不覆盖，自动加序号', async () => {
    const res = await upload('funny', 'meme.png', PNG);
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { name: string }).name, 'meme-2.png');
  });

  it('伪装成图片的文件按文件头被识破', async () => {
    const res = await upload('funny', 'x.png', Buffer.from('<html><script>alert(1)</script>'));
    assert.equal(res.status, 400);
    assert.ok(!existsSync(join(h.imagesDir, 'funny', 'x.png')));
  });

  it('扩展名以文件头为准：.txt 名字的 PNG 存成 .png', async () => {
    const res = await upload('funny', '其实是图.txt', PNG);
    assert.equal(res.status, 200);
    assert.equal(((await res.json()) as { name: string }).name, '其实是图.png');
  });

  it('文件名里的危险字符被清洗掉', async () => {
    const res = await upload('funny', '../../逃逸.png', PNG);
    assert.equal(res.status, 200);
    const name = ((await res.json()) as { name: string }).name;
    assert.ok(!name.includes('/') && !name.includes('..'), name);
    assert.ok(existsSync(join(h.imagesDir, 'funny', name)), '文件必须落在 funny 目录里');
  });

  it('不指定标签时落到未分类（根目录）', async () => {
    const res = await fetch(`${h.base}/api/images/upload`, {
      method: 'POST',
      headers: { Cookie: h.cookie, 'X-CSRF-Token': h.csrf, 'Content-Type': 'image/png' },
      body: PNG,
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { tag: string; name: string };
    assert.equal(body.tag, '未分类');
    assert.ok(existsSync(join(h.imagesDir, body.name)));

    const pool = await listPool();
    assert.ok(pool.tags.some((t) => t.name === '未分类' && t.count === 1));
  });

  it('原图接口按扩展名下发 Content-Type 与字节', async () => {
    const res = await fetch(
      `${h.base}/api/images/raw?tag=funny&name=${encodeURIComponent('meme.png')}`,
      { headers: { Cookie: h.cookie } },
    );
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), PNG);
  });

  it('原图接口挡住路径穿越', async () => {
    writeFileSync(join(h.imagesDir, '..', 'secret.txt'), 'top-secret');
    const res = await fetch(
      `${h.base}/api/images/raw?tag=funny&name=${encodeURIComponent('../../../secret.txt')}`,
      { headers: { Cookie: h.cookie } },
    );
    assert.equal(res.status, 404);
    const body = await res.text();
    assert.ok(!body.includes('top-secret'));
  });

  it('删除图片后清单里就没有了', async () => {
    const del = await fetch(
      `${h.base}/api/images?tag=funny&name=${encodeURIComponent('meme-2.png')}`,
      { method: 'DELETE', headers: { Cookie: h.cookie, 'X-CSRF-Token': h.csrf } },
    );
    assert.equal(del.status, 200);
    assert.ok(!existsSync(join(h.imagesDir, 'funny', 'meme-2.png')));
    const pool = await listPool();
    assert.equal(pool.tags.find((t) => t.name === 'funny')!.count, 3);
  });

  it('删除不存在的图片返回 404', async () => {
    const res = await fetch(`${h.base}/api/images?tag=funny&name=nope.png`, {
      method: 'DELETE',
      headers: { Cookie: h.cookie, 'X-CSRF-Token': h.csrf },
    });
    assert.equal(res.status, 404);
  });

  it('非图片扩展名不能通过删除接口访问', async () => {
    const res = await fetch(`${h.base}/api/images?tag=funny&name=${encodeURIComponent('../qqbot.db')}`, {
      method: 'DELETE',
      headers: { Cookie: h.cookie, 'X-CSRF-Token': h.csrf },
    });
    assert.equal(res.status, 400);
  });
});

describe('图池删除标签', () => {
  it('标签里还有图时不允许删标签', async () => {
    const res = await fetch(`${h.base}/api/image-tags?name=funny`, {
      method: 'DELETE',
      headers: { Cookie: h.cookie, 'X-CSRF-Token': h.csrf },
    });
    assert.equal(res.status, 400);
    assert.ok(existsSync(join(h.imagesDir, 'funny')));
  });

  it('清空后可以删掉标签', async () => {
    const pool = await listPool();
    for (const img of pool.tags.find((t) => t.name === 'funny')!.images) {
      await fetch(`${h.base}/api/images?tag=funny&name=${encodeURIComponent(img.name)}`, {
        method: 'DELETE',
        headers: { Cookie: h.cookie, 'X-CSRF-Token': h.csrf },
      });
    }
    const res = await fetch(`${h.base}/api/image-tags?name=funny`, {
      method: 'DELETE',
      headers: { Cookie: h.cookie, 'X-CSRF-Token': h.csrf },
    });
    assert.equal(res.status, 200);
    assert.ok(!existsSync(join(h.imagesDir, 'funny')));
    const after = await listPool();
    assert.ok(!after.tags.some((t) => t.name === 'funny'));
  });
});

describe('图池接口鉴权', () => {
  it('未登录读不到图池', async () => {
    const res = await fetch(`${h.base}/api/image-tags`);
    assert.equal(res.status, 401);
  });

  it('写操作缺 CSRF 头被拒绝', async () => {
    const res = await fetch(`${h.base}/api/image-tags`, {
      method: 'PUT',
      headers: { Cookie: h.cookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'x', note: '' }),
    });
    assert.equal(res.status, 403);
  });

  it('未登录也读不到原图', async () => {
    const res = await fetch(`${h.base}/api/images/raw?tag=未分类&name=whatever.png`);
    assert.equal(res.status, 401);
  });

  it('手工放进目录的图也能被列出来（不需要走面板）', async () => {
    mkdirSync(join(h.imagesDir, '手工'), { recursive: true });
    writeFileSync(join(h.imagesDir, '手工', 'a.png'), PNG);
    const pool = await listPool();
    const t = pool.tags.find((x) => x.name === '手工');
    assert.ok(t, '目录即标签');
    assert.equal(t!.images[0]!.name, 'a.png');
    assert.ok(readFileSync(join(h.imagesDir, '手工', 'a.png')).equals(PNG));
  });
});
