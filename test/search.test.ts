// 联网搜索的单元测试。
//
// 全部离线：通过注入的假 fetch 喂回去死的响应体，这里要钉住的是
// 「请求发到哪、带什么字段」，以及各种失败有没有被翻译成能看懂的中文——
// 线上真出错时，用户看到的只有那句错误文本，它要是「undefined」，排查就无从下手。
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  SEARCH_MAX_QUERY,
  formatHits,
  normalizeQuery,
  searchEndpoint,
  searchPromptBlock,
  toolQuery,
  webSearch,
  type SearchConfig,
  type SearchHit,
} from '../src/bot/search';

interface Rec {
  url: string;
  init: RequestInit;
}

/** 假 fetch：固定返回 body，并记录请求以便断言。 */
function fakeFetch(body: unknown, init: ResponseInit = {}): { fetch: typeof fetch; calls: Rec[] } {
  const calls: Rec[] = [];
  const f = (async (url: string, i: RequestInit) => {
    calls.push({ url: String(url), init: i });
    return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
      status: 200,
      ...init,
    });
  }) as unknown as typeof fetch;
  return { fetch: f, calls };
}

/** 假 fetch：直接抛网络错误。 */
const throwingFetch = (async () => {
  throw new Error('connect ECONNREFUSED');
}) as unknown as typeof fetch;

function cfg(over: Partial<SearchConfig> = {}): SearchConfig {
  return { apiKey: 'sk-test', ...over };
}

/** 取请求体，省得每处都写 as。 */
function bodyOf(r: Rec): Record<string, unknown> {
  return JSON.parse(String(r.init.body)) as Record<string, unknown>;
}

/** 造一条结果，只写关心的字段。 */
function hit(over: Partial<SearchHit> = {}): SearchHit {
  return { title: 't', url: 'https://a.test', content: 'c', date: '', site: '', ...over };
}

describe('请求形状', () => {
  it('打到 DeepSeek 官方 Search API，Bearer 认证，带 query 与 count', async () => {
    const f = fakeFetch({
      results: [
        {
          title: '标题一',
          url: 'https://a.test/1',
          snippet: '短摘要',
          summary: '长摘要',
          site_name: 'Example',
          date: '2026-06-01T00:00:00+00:00',
        },
      ],
    });
    const hits = await webSearch('今天 新闻', cfg({ fetchImpl: f.fetch }));

    assert.equal(f.calls[0]!.url, 'https://api.deepseek.com/v1/tools/search');
    assert.equal(f.calls[0]!.init.method, 'POST');
    assert.equal(
      (f.calls[0]!.init.headers as Record<string, string>)['Authorization'],
      'Bearer sk-test',
    );
    assert.equal(bodyOf(f.calls[0]!).query, '今天 新闻');
    assert.equal(bodyOf(f.calls[0]!).count, 5);
    // 正文按 token 计费且几乎用不上：只要摘要
    assert.equal(bodyOf(f.calls[0]!).need_content, false);

    assert.equal(hits.length, 1);
    assert.deepEqual(hits[0], {
      title: '标题一',
      url: 'https://a.test/1',
      // summary 是给模型读的长摘要，优先于 snippet
      content: '长摘要',
      date: '2026-06-01',
      site: 'Example',
    });
  });

  it('没有 summary 时退回 snippet', async () => {
    const f = fakeFetch({ results: [{ title: 'T', url: 'https://a.test', snippet: '短的' }] });
    const hits = await webSearch('q', cfg({ fetchImpl: f.fetch }));
    assert.equal(hits[0]!.content, '短的');
  });

  it('原问题作为 ori_question 带上去，帮助补全缺主语的查询', async () => {
    const f = fakeFetch({ results: [] });
    await webSearch('那场比赛', cfg({ oriQuestion: '昨晚皇马那场比赛谁赢了', fetchImpl: f.fetch }));
    assert.equal(bodyOf(f.calls[0]!).ori_question, '昨晚皇马那场比赛谁赢了');
  });

  it('原问题与 query 相同、或超长时不带 ori_question', async () => {
    const same = fakeFetch({ results: [] });
    await webSearch('天气', cfg({ oriQuestion: '天气', fetchImpl: same.fetch }));
    assert.equal('ori_question' in bodyOf(same.calls[0]!), false);

    // 接口限制 128 字符，超长会被截断而不是让整次搜索 400
    const long = fakeFetch({ results: [] });
    await webSearch('天气', cfg({ oriQuestion: '问'.repeat(300), fetchImpl: long.fetch }));
    assert.equal((bodyOf(long.calls[0]!).ori_question as string).length, 128);
  });

  it('query 超过接口上限时截断，别让整次请求 400', async () => {
    // 接口规定 query 1～128 个字符。模型偶尔会把整段对话当检索词塞进来，
    // 截断只是搜得糙一点，不截就是一次必失败的请求加上一句看不懂的报错。
    assert.equal(SEARCH_MAX_QUERY, 128, '这个数要跟官方文档对齐');
    const f = fakeFetch({ results: [] });
    await webSearch('长'.repeat(300), cfg({ fetchImpl: f.fetch }));
    assert.equal((bodyOf(f.calls[0]!).query as string).length, 128);
  });

  it('按 max_results 截断（也挡住不合理的超大值）', async () => {
    const many = Array.from({ length: 60 }, (_, i) => ({
      title: `t${i}`,
      url: `https://a.test/${i}`,
      snippet: 'c',
    }));
    const f = fakeFetch({ results: many });
    const hits = await webSearch('q', cfg({ maxResults: 3, fetchImpl: f.fetch }));
    assert.equal(hits.length, 3);
    assert.equal(bodyOf(f.calls[0]!).count, 3);
  });

  it('缺 Key 时直接报错，不发出注定 401 的请求', async () => {
    let called = false;
    const f = (async () => {
      called = true;
      return new Response('{}');
    }) as unknown as typeof fetch;
    await assert.rejects(
      () => webSearch('q', cfg({ apiKey: '', fetchImpl: f })),
      /未配置 DeepSeek API Key/,
    );
    assert.equal(called, false);
  });
});

describe('搜索地址派生', () => {
  it('域名、带 /v1、整条 /chat/completions、空值，都收敛到 /v1/tools/search', () => {
    assert.equal(searchEndpoint('https://api.deepseek.com'), 'https://api.deepseek.com/v1/tools/search');
    assert.equal(searchEndpoint('https://api.deepseek.com/'), 'https://api.deepseek.com/v1/tools/search');
    assert.equal(searchEndpoint('https://api.deepseek.com/v1'), 'https://api.deepseek.com/v1/tools/search');
    assert.equal(
      searchEndpoint('https://api.deepseek.com/v1/chat/completions'),
      'https://api.deepseek.com/v1/tools/search',
    );
    assert.equal(searchEndpoint(''), 'https://api.deepseek.com/v1/tools/search');
    assert.equal(searchEndpoint(undefined), 'https://api.deepseek.com/v1/tools/search');
  });

  it('走中转时拼在中转域名下，不自作主张连官方', async () => {
    const f = fakeFetch({ results: [] });
    await webSearch('q', cfg({ baseURL: 'https://relay.test/', fetchImpl: f.fetch }));
    assert.equal(f.calls[0]!.url, 'https://relay.test/v1/tools/search');
  });
});

describe('失败处理', () => {
  it('非 2xx 优先抽 error.message，别把整段 JSON 糊给模型', async () => {
    const f = fakeFetch(
      '{"error":{"message":"Insufficient Balance","type":"invalid_request_error","param":null}}',
      { status: 402 },
    );
    await assert.rejects(() => webSearch('q', cfg({ fetchImpl: f.fetch })), /HTTP 402.*Insufficient Balance/);
  });

  it('错误体不是 JSON 时退回原文片段', async () => {
    const f = fakeFetch('Bad Gateway', { status: 502 });
    await assert.rejects(() => webSearch('q', cfg({ fetchImpl: f.fetch })), /HTTP 502.*Bad Gateway/);
  });

  it('返回 html 时说人话', async () => {
    const f = fakeFetch('<!DOCTYPE html><html>...');
    await assert.rejects(() => webSearch('q', cfg({ fetchImpl: f.fetch })), /不是 JSON/);
  });

  it('网络错误翻译成中文', async () => {
    await assert.rejects(
      () => webSearch('q', cfg({ fetchImpl: throwingFetch })),
      /搜索请求失败.*ECONNREFUSED/,
    );
  });

  it('空搜索词在发请求前就挡掉', async () => {
    let called = false;
    const f = (async () => {
      called = true;
      return new Response('{}');
    }) as unknown as typeof fetch;
    await assert.rejects(() => webSearch('   ', cfg({ fetchImpl: f })), /搜索词为空/);
    assert.equal(called, false);
  });

  it('没有结果时返回空数组而不是报错', async () => {
    const f = fakeFetch({ results: [] });
    assert.deepEqual(await webSearch('q', cfg({ fetchImpl: f.fetch })), []);
  });

  it('丢弃既没链接也没内容的空壳结果', async () => {
    const f = fakeFetch({
      results: [{ title: '空壳' }, { title: '正常', url: 'https://a.test', snippet: '内容' }],
    });
    const hits = await webSearch('q', cfg({ fetchImpl: f.fetch }));
    assert.equal(hits.length, 1);
    assert.equal(hits[0]!.title, '正常');
  });
});

describe('结果格式化', () => {
  it('带序号、链接、站点与日期；没有结果时说清楚', () => {
    assert.equal(formatHits([]), '（没有搜到相关结果）');

    const s = formatHits([
      hit({ title: '标题', url: 'https://a.test', content: '摘要', site: 'Example', date: '2026-06-01' }),
      hit({ title: '', url: 'https://b.test', content: '摘要二' }),
    ]);
    assert.ok(s.includes('[1] 标题（Example · 2026-06-01）'), '站点和日期要一起给出');
    assert.ok(s.includes('https://a.test'));
    assert.ok(s.includes('[2] （无标题）'), '缺标题要有占位，不能出现空行');
  });

  it('超长摘要被截断，总长度受控但第一条永远保留', () => {
    const long = 'x'.repeat(380);
    const many = Array.from({ length: 30 }, (_, i) =>
      hit({ title: `标题${i + 1}`, url: `https://a.test/${i}`, content: long }),
    );
    const s = formatHits(many);
    assert.ok(s.length <= 4000 + 200, `总长度应被裁到合理范围，实际 ${s.length}`);
    assert.ok(s.includes('[1] 标题1'));
    assert.ok(!s.includes('[30]'), '超预算的后续结果整条丢弃，不要截半个');
  });
});

describe('查询词与提示词', () => {
  it('normalizeQuery 压空白并截断', () => {
    assert.equal(normalizeQuery('  今天\n\n 天气   '), '今天 天气');
    assert.equal(normalizeQuery('长'.repeat(500)).length, SEARCH_MAX_QUERY);
  });

  it('toolQuery：标准 JSON、裸文本、坏 JSON', () => {
    assert.equal(toolQuery('{"query":"北京 天气"}'), '北京 天气');
    assert.equal(toolQuery('今天天气'), '今天天气', '裸文本当检索词比报错划算');
    assert.equal(toolQuery('{"query":123}'), '');
    assert.equal(toolQuery('{坏掉的'), '');
    assert.equal(toolQuery('   '), '');
  });

  it('searchPromptBlock 带上次数上限', () => {
    const s = searchPromptBlock(3);
    assert.ok(s.includes('最多查 3 次'));
    assert.ok(searchPromptBlock(0).includes('最多查 1 次'), '非法值收敛到 1，不写 0 次');
  });
});
