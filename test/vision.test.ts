// 图片识别：取图、下载、校验、拼消息。
//
// 这一层的失败模式几乎全是"静默的"：图没取到、取到一条 html、图比上限大、
// 模型收到一个解不开的 data URL……在聊天里看起来都只是"机器人没看懂图"。
// 所以逐条钉住边界，而不是只测 happy path。
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  VISION_MAX_IMAGES,
  imageMarker,
  imageRefs,
  loadImage,
  loadImages,
  pickSource,
} from '../src/bot/vision';
import type { ContentPart } from '../src/llm/client';
import type { Event } from '../src/onebot/types';

/** 1×1 透明 PNG。文件头是真的，sniffImageExt 能认出来。 */
const PNG_B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

function ev(message: unknown): Event {
  return {
    time: 0,
    self_id: 10000,
    post_type: 'message',
    message_type: 'group',
    message_id: 1,
    user_id: 20000,
    group_id: 30000,
    message,
    raw: {},
  };
}

function fetchOf(body: Buffer | string, init: ResponseInit = {}): typeof fetch {
  return (async () => new Response(body, { status: 200, ...init })) as unknown as typeof fetch;
}

/** 取 image_url 里的 data URL；不是图片块返回空串。 */
function imageUrl(p: ContentPart | null): string {
  if (p === null) return '';
  return p.type === 'image_url' ? p.image_url.url : '';
}

describe('从消息里取图片来源', () => {
  it('数组格式：取 image 段的 url 与 file', () => {
    const refs = imageRefs(
      ev([
        { type: 'at', data: { qq: '10000' } },
        { type: 'image', data: { url: 'https://multimedia.nt.qq.com/a.jpg', file: 'abc.image' } },
        { type: 'text', data: { text: '看看这个' } },
      ]),
    );
    assert.equal(refs.length, 1);
    assert.equal(refs[0]!.url, 'https://multimedia.nt.qq.com/a.jpg');
    assert.equal(refs[0]!.file, 'abc.image');
  });

  it('CQ 码字符串格式同样能取到', () => {
    const refs = imageRefs(
      ev('你好[CQ:image,file=1.png,url=https://x.test/1.png]'),
    );
    assert.equal(refs.length, 1);
    assert.equal(refs[0]!.url, 'https://x.test/1.png');
  });

  it('没有地址的 image 段被丢弃，不产生空请求', () => {
    assert.deepEqual(imageRefs(ev([{ type: 'image', data: {} }])), []);
  });

  it('表情包（face）不算图片', () => {
    assert.deepEqual(imageRefs(ev([{ type: 'face', data: { id: '1' } }])), []);
  });
});

describe('选下载来源', () => {
  it('http 的 url 优先', () => {
    assert.equal(pickSource({ url: 'https://a/1.png', file: 'x.image' }), 'https://a/1.png');
  });

  it('没有 url 时退到 http 的 file', () => {
    assert.equal(pickSource({ url: '', file: 'https://a/1.png' }), 'https://a/1.png');
  });

  it('支持 base64:// 内联图', () => {
    assert.equal(pickSource({ url: '', file: `base64://${PNG_B64}` }), `base64://${PNG_B64}`);
  });

  it('本地路径一律不读（协议端在另一个容器，路径不存在）', () => {
    assert.equal(pickSource({ url: '', file: '/opt/napcat/cache/1.image' }), null);
    assert.equal(pickSource({ url: '', file: 'C:\\napcat\\1.image' }), null);
  });
});

describe('下载一张图', () => {
  it('base64:// 直接解码成 data URL', async () => {
    const part = await loadImage({ url: '', file: `base64://${PNG_B64}` });
    assert.ok(part);
    assert.equal(part!.type, 'image_url');
    assert.ok(imageUrl(part).startsWith('data:image/png;base64,'));
  });

  it('http 下载后按文件头定类型，不信 Content-Type', async () => {
    const part = await loadImage(
      { url: 'https://x.test/1.jpg', file: '' },
      {
        // 协议端经常给 octet-stream；还有人把 png 存成 .jpg
        fetchImpl: fetchOf(Buffer.from(PNG_B64, 'base64'), {
          headers: { 'content-type': 'application/octet-stream' },
        }),
      },
    );
    assert.ok(part);
    assert.ok(imageUrl(part).startsWith('data:image/png;base64,'));
  });

  it('不是图片（改名的 html）被丢弃', async () => {
    const part = await loadImage(
      { url: 'https://x.test/1.png', file: '' },
      { fetchImpl: fetchOf('<html>404</html>', { headers: { 'content-type': 'image/png' } }) },
    );
    assert.equal(part, null);
  });

  it('超过上限的图被丢弃', async () => {
    const big = Buffer.concat([Buffer.from(PNG_B64, 'base64'), Buffer.alloc(2048)]);
    const part = await loadImage(
      { url: 'https://x.test/1.png', file: '' },
      { fetchImpl: fetchOf(big), maxBytes: 1024 },
    );
    assert.equal(part, null, '超限图不能进消息');
  });

  it('Content-Length 超限时不读响应体', async () => {
    const part = await loadImage(
      { url: 'https://x.test/1.png', file: '' },
      {
        maxBytes: 1024,
        fetchImpl: fetchOf(Buffer.from(PNG_B64, 'base64'), {
          headers: { 'content-length': '999999' },
        }),
      },
    );
    assert.equal(part, null);
  });

  it('HTTP 非 2xx 返回 null 而不是抛错', async () => {
    const part = await loadImage(
      { url: 'https://x.test/1.png', file: '' },
      { fetchImpl: fetchOf('nf', { status: 404 }) },
    );
    assert.equal(part, null);
  });

  it('网络错误返回 null（一张图不该拖垮整条回复）', async () => {
    const boom = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const part = await loadImage({ url: 'https://x.test/1.png', file: '' }, { fetchImpl: boom });
    assert.equal(part, null);
  });
});

describe('一次取多条', () => {
  it('按上限截断，多出来的图不下载', async () => {
    let calls = 0;
    const refs = Array.from({ length: 6 }, (_, i) => ({ url: `https://x.test/${i}.png`, file: '' }));
    const parts = await loadImages(refs, {
      maxImages: 2,
      fetchImpl: (async () => {
        calls++;
        return new Response(Buffer.from(PNG_B64, 'base64'));
      }) as unknown as typeof fetch,
    });
    assert.equal(parts.length, 2);
    assert.equal(calls, 2, '上限之外的图不该产生请求');
  });

  it('同一条消息里的重复图只取一次', async () => {
    let calls = 0;
    const refs = [
      { url: 'https://x.test/1.png', file: '' },
      { url: 'https://x.test/1.png', file: '' },
    ];
    const parts = await loadImages(refs, {
      fetchImpl: (async () => {
        calls++;
        return new Response(Buffer.from(PNG_B64, 'base64'));
      }) as unknown as typeof fetch,
    });
    assert.equal(parts.length, 1);
    assert.equal(calls, 1);
  });

  it('全部失败时返回空数组（调用方据此降级成纯文字）', async () => {
    const parts = await loadImages([{ url: 'https://x.test/1.png', file: '' }], {
      fetchImpl: (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch,
    });
    assert.deepEqual(parts, []);
  });

  it('总量超限时按顺序保留，不整条放弃', async () => {
    const refs = [
      { url: 'https://x.test/1.png', file: '' },
      { url: 'https://x.test/2.png', file: '' },
    ];
    const parts = await loadImages(refs, {
      maxTotalBytes: 100,
      fetchImpl: (async () => new Response(Buffer.from(PNG_B64, 'base64'))) as unknown as typeof fetch,
    });
    assert.equal(parts.length, 1, '第二张会把请求体撑爆，应被丢掉而不是两张都发');
  });

  it('上限被夹到 1..VISION_MAX_IMAGES', async () => {
    const refs = Array.from({ length: 10 }, (_, i) => ({
      url: '',
      file: `base64://${PNG_B64}#${i}`,
    }));
    // 每个 base64 尾部多一个 #i，解码后仍以 PNG 头开头（多出的字节只是尾巴）
    const parts = await loadImages(refs, { maxImages: 99 });
    assert.equal(parts.length, VISION_MAX_IMAGES);
  });
});

describe('历史标记', () => {
  it('记的是张数', () => {
    assert.equal(imageMarker(1), '（附图 1 张）');
    assert.equal(imageMarker(3), '（附图 3 张）');
  });
});
