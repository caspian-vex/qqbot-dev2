// 会话级设置覆盖：纯函数部分。
//
// 这一层的正确性只有三条标准，用例也围着它们转：
//   1. 覆盖了就用覆盖值，没覆盖的组仍跟全局；
//   2. 全局任何时候都不会被覆盖污染（否则会串到别的会话）；
//   3. 名单只能收紧，不能放宽。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  OVERRIDE_FIELDS,
  OVERRIDABLE_GROUPS,
  badFieldOf,
  isEmptyOverrides,
  normalizeOverrides,
  overriddenGroups,
  groupBase,
  pickBot,
  pickGroups,
  resolveSettings,
  type SessionOverrides,
} from '../src/store/overrides';
import { Store } from '../src/store';
import { defaultSettings } from '../src/store/types';

const tmpDirs: string[] = [];
after(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function tempStore(): { store: Store; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-ovr-'));
  tmpDirs.push(dir);
  return { store: new Store(join(dir, 'qqbot.db')), dir };
}

describe('合成生效设置', () => {
  it('覆盖值生效，没覆盖的组仍跟全局', () => {
    const g = defaultSettings();
    g.bot.passive_rate = 0.9;
    g.context.max_turns = 10;

    const r = resolveSettings(g, {
      bot: { ...pickBot(g.bot), passive_rate: 0.15 },
    });
    assert.equal(r.bot.passive_rate, 0.15, '覆盖值应生效');
    assert.equal(r.context.max_turns, 10, '没覆盖的组应跟全局');
    assert.equal(r.proactive.echo_enabled, g.proactive.echo_enabled);
  });

  it('空数组 / 0 / false 是有效覆盖值，不被当成"没填"而回落全局', () => {
    const g = defaultSettings();
    g.bot.wake_words = ['小助手'];
    g.context.max_turns = 10;
    g.vision.enabled = true;
    g.images.enabled = true;

    const r = resolveSettings(g, {
      // 唤醒词留空 = 只响应 @ 与私聊，是个有意义的配置
      bot: { ...pickBot(g.bot), wake_words: [] },
      context: { max_turns: 0, token_budget: 3000 },
      vision: { enabled: false, max_images: 4 },
      images: { enabled: false, max_per_reply: 1 },
    });
    assert.deepEqual(r.bot.wake_words, []);
    assert.equal(r.context.max_turns, 0, '0 轮 = 不带历史，不能被当成缺省');
    assert.equal(r.vision.enabled, false);
    assert.equal(r.images.enabled, false);
  });

  it('全局黑名单永远生效，会话只能追加', () => {
    const g = defaultSettings();
    g.bot.blacklist_users = [7];

    // 会话里写空：删不掉全局那一个
    assert.deepEqual(resolveSettings(g, { bot: { ...pickBot(g.bot), blacklist_users: [] } }).bot.blacklist_users, [7]);
    // 会话里追加：并集，全局在前
    assert.deepEqual(
      resolveSettings(g, { bot: { ...pickBot(g.bot), blacklist_users: [8, 7] } }).bot.blacklist_users,
      [7, 8],
      '应按全局在前去重合并',
    );
  });

  it('会话覆盖改不了 max_concurrent 与群白名单', () => {
    const g = defaultSettings();
    g.bot.max_concurrent = 3;
    g.bot.whitelist_groups = [1001];

    // 正常路径：这两项根本不在可覆盖字段里，normalize 会丢
    const cleaned = normalizeOverrides(
      { bot: { max_concurrent: 9, whitelist_groups: [2002], passive_rate: 0.5 } },
      g,
    );
    assert.equal(cleaned.bot!.passive_rate, 0.5);
    assert.ok(!Object.hasOwn(cleaned.bot!, 'max_concurrent'));
    assert.ok(!Object.hasOwn(cleaned.bot!, 'whitelist_groups'));

    // 就算有人硬塞进已经规范化过的对象，resolve 也不会让它覆盖
    const forced = { bot: { ...pickBot(g.bot), max_concurrent: 9, whitelist_groups: [2002] } } as unknown as SessionOverrides;
    const r = resolveSettings(g, forced);
    assert.equal(r.bot.max_concurrent, 3);
    assert.deepEqual(r.bot.whitelist_groups, [1001]);
  });

  it('合成不污染全局（数组也不能共享引用）', () => {
    const g = defaultSettings();
    g.bot.wake_words = ['全局词'];

    const r = resolveSettings(g, { bot: { ...pickBot(g.bot), wake_words: ['会话词'] } });
    r.bot.wake_words.push('临时改的');
    r.proactive.echo_rate = 0.99;

    assert.deepEqual(g.bot.wake_words, ['全局词'], '全局数组不能被改动');
    assert.notEqual(g.proactive.echo_rate, 0.99);

    // 连"缓存对象"也不能被串改：resolveFor 拿到的是 SettingsRepo.get() 的克隆，
    // 但一旦有人直接把缓存递进来，就地改写就会串到别的会话。
    const { store } = tempStore();
    const cached = store.settings.get();
    const out = resolveSettings(cached, { context: { max_turns: 1, token_budget: 500 } });
    out.context.max_turns = 42;
    assert.equal(store.settings.get().context.max_turns, 10);
    store.close();
  });

  it('null 覆盖等价于原样返回全局', () => {
    const g = defaultSettings();
    assert.deepEqual(resolveSettings(g, null), g);
  });

  it('六组都能被覆盖', () => {
    const g = defaultSettings();
    const r = resolveSettings(g, {
      bot: { ...pickBot(g.bot), group_cooldown_sec: 5 },
      proactive: { ...g.proactive, echo_enabled: true, echo_rate: 1, echo_daily_limit: 3 },
      images: { enabled: true, max_per_reply: 3 },
      vision: { enabled: false, max_images: 1 },
      search: { enabled: true, max_results: 3, timeout_sec: 5, max_calls: 1 },
      context: { max_turns: 3, token_budget: 800 },
    });
    assert.equal(r.bot.group_cooldown_sec, 5);
    assert.equal(r.proactive.echo_daily_limit, 3);
    assert.equal(r.images.max_per_reply, 3);
    assert.equal(r.vision.max_images, 1);
    assert.equal(r.search.max_calls, 1);
    assert.equal(r.context.token_budget, 800);
  });
});

describe('规范化外来覆盖', () => {
  it('组内缺字段用全局值补全，不会给引擎留下 undefined', () => {
    const g = defaultSettings();
    g.bot.passive_rate = 0.4;
    g.context.token_budget = 2222;

    const ov = normalizeOverrides({ bot: { passive_rate: 0.8 }, context: {} }, g);
    assert.deepEqual(ov.bot, { ...pickBot(g.bot), passive_rate: 0.8 });
    assert.deepEqual(ov.context, { max_turns: g.context.max_turns, token_budget: 2222 });
  });

  it('未知组与类型不符的组被丢弃，不抛', () => {
    const g = defaultSettings();
    const ov = normalizeOverrides(
      { llm: { model: 'x' }, panel: { admin_user: 'root' }, bot: { passive_rate: '0.5' } },
      g,
    );
    assert.deepEqual(ov, {}, '整组类型不符应按"没有覆盖"处理');
  });

  it('非对象输入一律当成没有覆盖', () => {
    const g = defaultSettings();
    for (const bad of [null, undefined, 42, 'x', []]) {
      assert.deepEqual(normalizeOverrides(bad, g), {});
    }
  });

  it('QQ 号列表只收正整数', () => {
    const g = defaultSettings();
    assert.deepEqual(normalizeOverrides({ bot: { blacklist_users: ['7'] } }, g), {});
    assert.deepEqual(normalizeOverrides({ bot: { blacklist_users: [0] } }, g), {});
    assert.deepEqual(normalizeOverrides({ bot: { blacklist_users: [7, 8] } }, g).bot!.blacklist_users, [7, 8]);
  });

  it('badFieldOf 能定位类型不对的字段', () => {
    assert.equal(badFieldOf('bot', { passive_rate: '0.5' }), 'passive_rate');
    assert.equal(badFieldOf('bot', { wake_words: [1] }), 'wake_words');
    assert.equal(badFieldOf('bot', { passive_rate: 0.5, wake_words: ['a'] }), '');
    assert.equal(badFieldOf('context', { max_turns: Number.NaN }), 'max_turns');
  });

  it('组清单与字段清单自洽（面板白名单靠它，写漏一个就是静默不支持）', () => {
    assert.deepEqual([...OVERRIDABLE_GROUPS], [
      'bot',
      'proactive',
      'images',
      'vision',
      'search',
      'computer',
      'context',
    ]);
    assert.deepEqual(Object.keys(OVERRIDE_FIELDS.bot).sort(), [
      'blacklist_users',
      'group_cooldown_sec',
      'max_segments',
      'passive_rate',
      'quote_reply',
      'seg_delay_max_ms',
      'seg_delay_min_ms',
      'wake_words',
    ]);
  });

  it('电脑操作的会话覆盖不带走部署级字段，也不冻结全局值', () => {
    const g = defaultSettings();
    g.computer = {
      ...g.computer,
      enabled: true,
      owner_qq: 10001,
      workdir: '/opt/qqbot/data',
      allow_users: [20002],
      allow_groups: [30003],
      require_approval: true,
      approval_timeout_sec: 90,
    };
    const ov = normalizeOverrides({ computer: { enabled: true, max_calls: 3, timeout_sec: 15 } }, g);
    const r = resolveSettings(g, ov);

    assert.equal(r.computer.enabled, true);
    assert.equal(r.computer.max_calls, 3);
    assert.equal(r.computer.timeout_sec, 15);
    // 部署级边界必须还是全局那份
    assert.equal(r.computer.owner_qq, 10001);
    assert.equal(r.computer.workdir, '/opt/qqbot/data');
    assert.deepEqual(r.computer.allow_users, [20002]);
    assert.deepEqual(r.computer.allow_groups, [30003]);
    assert.equal(r.computer.require_approval, true);

    // 全局随后改了白名单：这个会话要跟着变，说明没被冻结进快照
    const g2 = defaultSettings();
    g2.computer = { ...g.computer, allow_users: [40004] };
    assert.deepEqual(resolveSettings(g2, ov).computer.allow_users, [40004]);
    // 也不该污染全局
    assert.deepEqual(g.computer.allow_users, [20002]);
  });

  it('groupBase(computer) 只暴露三个可覆盖字段', () => {
    const keys = Object.keys(groupBase('computer', defaultSettings())).sort();
    assert.deepEqual(keys, ['enabled', 'max_calls', 'timeout_sec']);
  });

  it('空覆盖识别', () => {
    assert.equal(isEmptyOverrides(null), true);
    assert.equal(isEmptyOverrides({}), true);
    assert.equal(isEmptyOverrides({ context: { max_turns: 1, token_budget: 900 } }), false);
    assert.deepEqual(overriddenGroups({ bot: {} as never, context: { max_turns: 1, token_budget: 900 } }), [
      'bot',
      'context',
    ]);
  });

  it('pickGroups 只给七个可覆盖组（不含 Key 与面板凭据）', () => {
    const g = defaultSettings();
    g.llm.api_key = 'sk-secret';
    const p = pickGroups(g);
    assert.deepEqual(Object.keys(p).sort(), [
      'bot',
      'computer',
      'context',
      'images',
      'proactive',
      'search',
      'vision',
    ]);
    assert.ok(!JSON.stringify(p).includes('sk-secret'));
  });
});

describe('覆盖仓储', () => {
  it('写入、读回、清空', () => {
    const { store, dir } = tempStore();
    const g = store.settings.get();
    store.sessionSettings.set('group:1', normalizeOverrides({ context: { max_turns: 2 } }, g), {
      kind: 'group',
      name: '测试群',
    });
    const got = store.sessionSettings.get('group:1');
    assert.equal(got?.context?.max_turns, 2);
    assert.deepEqual(store.sessionSettings.ids(), new Set(['group:1']));
    assert.equal(store.sessionSettings.count(), 1);

    const row = store.sessionSettings.list().find((r) => r.session_id === 'group:1');
    assert.equal(row?.target_name, '测试群');
    assert.equal(row?.kind, 'group');

    store.sessionSettings.clear('group:1');
    assert.equal(store.sessionSettings.get('group:1'), null);
    store.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('空覆盖等于删行，不是存一份空 JSON', () => {
    const { store } = tempStore();
    store.sessionSettings.set('group:1', { context: { max_turns: 2, token_budget: 800 } });
    store.sessionSettings.set('group:1', {});
    assert.equal(store.sessionSettings.get('group:1'), null);
    assert.equal(store.sessionSettings.count(), 0);
    store.close();
  });

  it('重写时不带名字不会把已存的名字擦掉', () => {
    const { store } = tempStore();
    store.sessionSettings.set('group:1', { context: { max_turns: 2, token_budget: 800 } }, { kind: 'group', name: '夜猫子群' });
    store.sessionSettings.set('group:1', { context: { max_turns: 3, token_budget: 800 } });
    const row = store.sessionSettings.list().find((r) => r.session_id === 'group:1');
    assert.equal(row?.target_name, '夜猫子群');
    assert.equal(store.sessionSettings.get('group:1')?.context?.max_turns, 3);
    store.close();
  });

  it('坏 JSON 读成 null 而不是抛（一条脏行不该让某个群哑掉）', () => {
    const { store } = tempStore();
    store.db.run(
      `INSERT INTO session_settings (session_id, kind, target_name, overrides, updated_at) VALUES (?, '', '', ?, 0)`,
      'group:9',
      '{不是 json',
    );
    assert.equal(store.sessionSettings.get('group:9'), null);
    store.close();
  });

  it('删会话时一并清掉它的覆盖', () => {
    const { store } = tempStore();
    store.sessions.touch('group:1', 'group', 1, '群');
    store.sessionSettings.set('group:1', { context: { max_turns: 2, token_budget: 800 } });
    store.sessions.delete('group:1');
    assert.equal(store.sessionSettings.count(), 0, '残留的覆盖会在同群再开口时悄悄复活');
    store.close();
  });
});
