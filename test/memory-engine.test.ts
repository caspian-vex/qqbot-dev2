// 引擎侧的记忆接线：注入位置、开关语义、按人召回、以及"记忆坏了不能连累回复"。
//
// 这里最关键的一条断言是注入位置——记忆必须落在「输出要求：」之前。
// 格式约束是"怎么说话"，应最后被读到；记忆是资料，塞在规则后面模型会把它
// 当成新的指令去执行（"以后叫我哥"会被当命令而不是事实）。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { Engine, type Sender } from '../src/bot';
import {
  contentText,
  type LlmClient,
  type Message as LlmMessage,
  type Result,
} from '../src/llm/client';
import { Logger } from '../src/log/logger';
import type { Event, Segment } from '../src/onebot/types';
import { Store } from '../src/store';
import type { Settings } from '../src/store/types';

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, ms = 3000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > ms) throw new Error('等待超时');
    await sleep(20);
  }
}

interface Harness {
  engine: Engine;
  store: Store;
  sent: Segment[][];
  /** 每次请求的 system 提示词。 */
  systems: string[];
  cleanup: () => void;
}

function make(patch?: (v: Settings) => void): Harness {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-mem-engine-'));
  dirs.push(dir);
  const store = new Store(join(dir, 'qqbot.db'));
  store.settings.update((v) => {
    v.bot.passive_rate = 1;
    v.bot.group_cooldown_sec = 0;
    v.bot.seg_delay_min_ms = 0;
    v.bot.seg_delay_max_ms = 0;
    v.llm.api_key = 'sk-test';
    v.memory.enabled = true;
    patch?.(v);
  });

  const sent: Segment[][] = [];
  const sender: Sender = {
    sendGroup: async (_id, segs) => {
      sent.push(segs);
      return 1;
    },
    sendPrivate: async (_id, segs) => {
      sent.push(segs);
      return 2;
    },
    groupInfo: async () => '测试群',
  };

  const systems: string[] = [];
  const llm = {
    chat: async (_cfg: unknown, msgs: LlmMessage[]): Promise<Result> => {
      const first = msgs[0];
      if (first) systems.push(contentText(first.content));
      return {
        content: '收到。',
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        firstTokenMs: 1,
      };
    },
  } as unknown as LlmClient;

  const engine = new Engine({
    store,
    log: Logger.create({ level: 'error', format: 'text' }),
    llm,
    dataDir: dir,
  });
  engine.setSender(sender);
  engine.setSelf(10000, 'bot');
  return { engine, store, sent, systems, cleanup: () => store.close() };
}

function groupEv(userId = 20000, messageId = 1): Event {
  return {
    time: 0,
    self_id: 10000,
    post_type: 'message',
    message_type: 'group',
    message_id: messageId,
    user_id: userId,
    group_id: 30000,
    message: [{ type: 'text', data: { text: '你好' } }],
    raw: {},
  };
}

/** 时间行每次都不同，比对 system 之前先抹掉。 */
const maskTime = (s: string): string => s.replace(/\d{4}-\d{2}-\d{2} \d{2}:\d{2}/g, 'TIME');

describe('注入', () => {
  it('记忆块在 system 里，且位于「输出要求：」之前', async () => {
    const h = make();
    try {
      h.store.memory.add({ scope: 'user', owner_id: '20000', content: '在杭州做后端', score: 5 });
      h.store.memory.add({ scope: 'session', owner_id: 'group:30000', content: '这个群在聊考研', score: 5 });

      h.engine.handleEvent(groupEv());
      await waitFor(() => h.systems.length >= 1);

      const sys = h.systems[0] ?? '';
      const block = sys.indexOf('【关于对方的长期记忆】');
      const rules = sys.indexOf('输出要求：');
      assert.ok(block >= 0, '记忆块应该被注入');
      assert.ok(rules > 0, '格式约束应该还在');
      assert.ok(block < rules, '记忆是资料，必须排在格式约束之前');
      assert.match(sys, /在杭州做后端/);
      assert.match(sys, /这个群在聊考研/);
    } finally {
      h.cleanup();
    }
  });

  it('开关关着时，system 与「开着但库里一条记忆都没有」逐字节相同', async () => {
    const off = make((v) => (v.memory.enabled = false));
    const empty = make();
    try {
      off.engine.handleEvent(groupEv());
      await waitFor(() => off.systems.length >= 1);
      empty.engine.handleEvent(groupEv());
      await waitFor(() => empty.systems.length >= 1);

      assert.equal(
        maskTime(off.systems[0] ?? ''),
        maskTime(empty.systems[0] ?? ''),
        '关掉开关就等于没有这个功能，不能留下空段落',
      );
    } finally {
      off.cleanup();
      empty.cleanup();
    }
  });

  it('群聊只召回本会话与当前说话人的记忆，别人的不串进来', async () => {
    const h = make();
    try {
      h.store.memory.add({ scope: 'user', owner_id: '20000', content: '当前说话人的事', score: 5 });
      h.store.memory.add({ scope: 'user', owner_id: '99999', content: '另一个人的秘密', score: 5 });
      h.store.memory.add({ scope: 'session', owner_id: 'group:88888', content: '别的群的约定', score: 5 });

      h.engine.handleEvent(groupEv(20000));
      await waitFor(() => h.systems.length >= 1);

      const sys = h.systems[0] ?? '';
      assert.match(sys, /当前说话人的事/);
      assert.doesNotMatch(sys, /另一个人的秘密/, '群里不该看见别人的私事');
      assert.doesNotMatch(sys, /别的群的约定/);
    } finally {
      h.cleanup();
    }
  });

  it('低分事实不注入（门槛）', async () => {
    const h = make((v) => (v.memory.min_score = 5));
    try {
      h.store.memory.add({ scope: 'user', owner_id: '20000', content: '一条不太重要的事', score: 3 });
      h.engine.handleEvent(groupEv(20000));
      await waitFor(() => h.systems.length >= 1);
      assert.doesNotMatch(h.systems[0] ?? '', /一条不太重要的事/);
    } finally {
      h.cleanup();
    }
  });
});

describe('故障隔离', () => {
  it('记忆表坏了也只影响记忆，回复照发', async () => {
    const h = make();
    try {
      h.store.memory.add({ scope: 'user', owner_id: '20000', content: '会读失败的一条', score: 5 });
      h.store.db.run('DROP TABLE memories');

      h.engine.handleEvent(groupEv());
      await waitFor(() => h.sent.length >= 1);

      const text = h.sent[0]
        ?.filter((s) => s.type === 'text')
        .map((s) => String(s.data['text']))
        .join('');
      assert.equal(text, '收到。', '记忆读不出来只是这次没记性，不能让整个群哑掉');
    } finally {
      h.cleanup();
    }
  });
});
