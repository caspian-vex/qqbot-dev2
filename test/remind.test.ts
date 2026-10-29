// 定时消息工具：时间换算 + 引擎链路。
//
// 时间换算是这里唯一"错了还很难发现"的部分：模型给的是 "08:00"，
// 算成明天还是今天、跨没跨零点，结果都只体现在"提醒晚了一天"上。
// 所以纯函数的边界钉得比平时密。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  Engine,
  MAX_REMIND_MINUTES,
  REMIND_TOOL_NAME,
  parseDueAt,
  readRemindArgs,
  type Sender,
} from '../src/bot';
import type { LlmClient, Message as LlmMessage, Result, ToolDef } from '../src/llm/client';
import { Logger } from '../src/log/logger';
import type { Event } from '../src/onebot/types';
import { Store } from '../src/store';

const tmpDirs: string[] = [];
after(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

/** 固定"现在"：2026-10-29 13:00 本地时间，星期几无所谓。 */
function now(): Date {
  const d = new Date(2026, 9, 29, 13, 0, 0, 0);
  return d;
}

describe('时间换算', () => {
  it('当天稍后的钟点按今天算', () => {
    const r = parseDueAt('20:30', Number.NaN, now());
    assert.ok(!('error' in r));
    if ('error' in r) return;
    const d = new Date(r.dueAt);
    assert.equal(d.getDate(), 29);
    assert.equal(d.getHours(), 20);
    assert.equal(d.getMinutes(), 30);
  });

  it('已经过去的钟点按明天算', () => {
    const r = parseDueAt('08:00', Number.NaN, now());
    assert.ok(!('error' in r));
    if ('error' in r) return;
    assert.equal(new Date(r.dueAt).getDate(), 30);
  });

  it('相对分钟直接加，不经过日期推算', () => {
    const r = parseDueAt('', 90, now());
    assert.ok(!('error' in r));
    if ('error' in r) return;
    assert.equal(r.dueAt - now().getTime(), 90 * 60_000);
  });

  it('两个都给时以 at 为准（模型常常两个都填）', () => {
    const r = parseDueAt('20:00', 5, now());
    assert.ok(!('error' in r));
    if ('error' in r) return;
    assert.equal(new Date(r.dueAt).getHours(), 20);
  });

  it('格式不对时明确报错，而不是猜一个时间', () => {
    assert.ok('error' in parseDueAt('明天早上', Number.NaN, now()));
    assert.ok('error' in parseDueAt('25:00', Number.NaN, now()));
    assert.ok('error' in parseDueAt('08:70', Number.NaN, now()));
    assert.ok('error' in parseDueAt('', Number.NaN, now()), '两个都没给也要报错');
  });

  it('相对分钟有上下限', () => {
    assert.ok('error' in parseDueAt('', 0, now()));
    assert.ok('error' in parseDueAt('', MAX_REMIND_MINUTES + 1, now()));
    assert.ok(!('error' in parseDueAt('', MAX_REMIND_MINUTES, now())));
  });
});

describe('参数解析', () => {
  it('接受字符串形式的数字（模型很常这么写）', () => {
    assert.equal(readRemindArgs('{"after_minutes":"30"}').after, 30);
  });

  it('坏 JSON 不抛错，全部退回默认值', () => {
    const a = readRemindArgs('{不是 json');
    assert.equal(a.at, '');
    assert.ok(Number.isNaN(a.after));
    assert.equal(a.cancel, false);
  });

  it('cancel 只认真正的 true', () => {
    assert.equal(readRemindArgs('{"cancel":true}').cancel, true);
    assert.equal(readRemindArgs('{"cancel":"true"}').cancel, false);
  });
});

// ---- 引擎链路 ----

interface Hit {
  target: number;
  texts: string[];
}

function ev(): Event {
  return {
    time: 0,
    self_id: 10000,
    post_type: 'message',
    message_type: 'private',
    message_id: 1,
    user_id: 20000,
    group_id: 0,
    message: [{ type: 'text', data: { text: '明早八点提醒我交房租' } }],
    raw: {},
  };
}

const usage = { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 };

function harness(calls: { msgs: LlmMessage[]; tools?: ToolDef[] }[]): {
  engine: Engine;
  store: Store;
  hits: Hit[];
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-remind-'));
  tmpDirs.push(dir);
  const store = new Store(join(dir, 'qqbot.db'));
  store.settings.update((v) => {
    v.timing.enabled = false;
    v.bot.seg_delay_min_ms = 0;
    v.bot.seg_delay_max_ms = 0;
    // 主人私聊：电脑操作与定时消息都靠这道门
    v.computer.enabled = true;
    v.computer.owner_qq = 20000;
    // 免审批：本用例只关心"排没排上"，不点上批准
    v.computer.require_approval = false;
  });

  const hits: Hit[] = [];
  const sender: Sender = {
    sendGroup: async () => 1,
    sendPrivate: async (id, segs) => {
      hits.push({ target: id, texts: segs.map((s) => String(s.data['text'])) });
      return 1;
    },
    groupInfo: async () => '',
  };

  const llm = {
    chat: async (_cfg: unknown, msgs: LlmMessage[], _sig?: unknown, tools?: ToolDef[]) => {
      calls.push({ msgs, tools });
      return (calls.length === 1
        ? {
            content: '',
            usage,
            firstTokenMs: 1,
            toolCalls: [
              {
                id: 'call_1',
                type: 'function',
                function: {
                  name: REMIND_TOOL_NAME,
                  arguments: JSON.stringify({ after_minutes: 30, text: '该交房租了' }),
                },
              },
            ],
          }
        : { content: '行，三十分钟后叫你。', usage, firstTokenMs: 1 }) as Result;
    },
  } as unknown as LlmClient;

  const engine = new Engine({ store, log: Logger.create({ level: 'error', format: 'text' }), llm });
  engine.setSender(sender);
  engine.setSelf(10000, 'bot');
  return { engine, store, hits, cleanup: () => store.close() };
}

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('等待超时');
    await new Promise((r) => setTimeout(r, 10));
  }
}

describe('定时消息链路', () => {
  it('模型排上之后落库，到点自己发出去', async () => {
    const calls: { msgs: LlmMessage[]; tools?: ToolDef[] }[] = [];
    const h = harness(calls);
    try {
      h.engine.handleEvent(ev());
      await waitFor(() => h.hits.length >= 1);

      // 下发了工具，模型也确实调了
      assert.ok((calls[0]!.tools ?? []).some((t) => t.function.name === REMIND_TOOL_NAME));
      const pending = h.store.scheduled.pending('private:20000');
      assert.equal(pending.length, 1, '应落一条待发');
      assert.equal(pending[0]!.body, '该交房租了');
      assert.equal(pending[0]!.source, 'tool');
      assert.equal(pending[0]!.target_id, 20000);

      // 工具结果回灌给模型时要说清"已排定"，否则它会跟用户含糊其辞
      const toolMsg = calls[1]!.msgs.find((m) => m.role === 'tool');
      assert.ok(toolMsg, '必须有 role=tool 的回填');
      assert.match(String(toolMsg!.content), /已排定/);

      // 还没到点：tick 不该发
      await h.engine.tick();
      await new Promise((r) => setTimeout(r, 100));
      assert.equal(h.hits.length, 1, '未到期不应发出');

      // 到点：自己发出去，不需要用户再说话
      await h.engine.tick(Date.now() + 31 * 60_000);
      await waitFor(() => h.hits.length >= 2);
      assert.equal(h.hits[1]!.texts[0], '该交房租了');
      assert.equal(h.store.scheduled.countPending(), 0);
    } finally {
      h.cleanup();
    }
  });

  it('没有电脑操作权限时既不下发工具、也不给说明', async () => {
    const calls: { msgs: LlmMessage[]; tools?: ToolDef[] }[] = [];
    const dir = mkdtempSync(join(tmpdir(), 'qqbot-remind-'));
    tmpDirs.push(dir);
    const store = new Store(join(dir, 'qqbot.db'));
    // 默认设置：computer.enabled = false，主人为空
    store.settings.update((v) => {
      v.timing.enabled = false;
    });
    const llm = {
      chat: async (_c: unknown, msgs: LlmMessage[], _s?: unknown, tools?: ToolDef[]) => {
        calls.push({ msgs, tools });
        return { content: '好的。', usage, firstTokenMs: 1 } as Result;
      },
    } as unknown as LlmClient;
    const engine = new Engine({ store, log: Logger.create({ level: 'error', format: 'text' }), llm });
    engine.setSender({ sendGroup: async () => 1, sendPrivate: async () => 1, groupInfo: async () => '' });
    engine.setSelf(10000, 'bot');
    try {
      engine.handleEvent(ev());
      await new Promise((r) => setTimeout(r, 150));
      assert.equal(calls[0]!.tools, undefined, '没有权限时不该带任何工具');
      // 没权限就不该跟模型说"你能定时"，否则它会承诺一件做不到的事
      assert.ok(!calls[0]!.msgs[0]!.content.toString().includes('schedule_message'));
    } finally {
      store.close();
    }
  });
});
