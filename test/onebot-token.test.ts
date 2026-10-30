// OneBot 访问令牌的来源解析。
//
// 这组用例守的是一条顺序：用户的显式配置（env / toml）压过自动生成的值，
// 而自动生成的值必须能跨重启复用——否则每次重启都会给协议端换一次令牌，
// 表现成"升级后机器人时不时掉线几秒"，很难归因。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveOnebotToken, type TokenLogger } from '../src/onebot/token';
import { Box, generateKey } from '../src/secret/box';
import { Store } from '../src/store/index';

interface Captured {
  level: string;
  msg: string;
}

function quietLog(): { log: TokenLogger; lines: Captured[] } {
  const lines: Captured[] = [];
  const push = (level: string) => (msg: string) => {
    lines.push({ level, msg });
  };
  return {
    lines,
    log: { debug: push('debug'), info: push('info'), warn: push('warn') },
  };
}

/** 只提供两个闭包的假存储，用来精确数"写了几次"。 */
function memoryStore(initial = ''): {
  read: () => string;
  write: (t: string) => void;
  writes: string[];
  value: () => string;
} {
  let v = initial;
  const writes: string[] = [];
  return {
    read: () => v,
    write: (t: string) => {
      writes.push(t);
      v = t;
    },
    writes,
    value: () => v,
  };
}

test('env 非空时优先，且不写库', () => {
  const s = memoryStore('stored-token');
  const { log } = quietLog();
  const r = resolveOnebotToken({ env: ' from-env ', toml: 'from-toml', read: s.read, write: s.write, log });
  assert.equal(r.token, 'from-env', '两端的空白要吃掉，env 文件手写很容易多一个空格');
  assert.equal(r.source, 'env');
  assert.equal(s.writes.length, 0, '用户显式指定的值不该被写进库，否则会盖掉下次的显式选择');
});

test('env 为空时用 toml，且不写库', () => {
  const s = memoryStore('stored-token');
  const { log } = quietLog();
  const r = resolveOnebotToken({ env: '  ', toml: 'from-toml', read: s.read, write: s.write, log });
  assert.equal(r.token, 'from-toml');
  assert.equal(r.source, 'toml');
  assert.equal(s.writes.length, 0);
});

test('都没有时生成 32 位十六进制并落库一次', () => {
  const s = memoryStore('');
  const { log } = quietLog();
  const r = resolveOnebotToken({ env: '', toml: '', read: s.read, write: s.write, log });
  assert.match(r.token, /^[0-9a-f]{32}$/);
  assert.equal(r.source, 'generated');
  assert.deepEqual(s.writes, [r.token]);
});

test('已保存的值优先于重新生成，且复用同一个值', () => {
  const s = memoryStore('kept-token');
  const { log } = quietLog();
  const r = resolveOnebotToken({ env: '', toml: '', read: s.read, write: s.write, log });
  assert.equal(r.token, 'kept-token');
  assert.equal(r.source, 'stored');
  assert.equal(s.writes.length, 0);
});

test('落库失败时降级为内存令牌并给出可操作的 warn', () => {
  const { log, lines } = quietLog();
  const r = resolveOnebotToken({
    env: '',
    toml: '',
    read: () => '',
    write: () => {
      throw new Error('readonly database');
    },
    log,
  });
  assert.match(r.token, /^[0-9a-f]{32}$/, '存不下也要有值可用，本次运行两端得一致');
  assert.equal(r.source, 'generated-memory');
  const warn = lines.find((l) => l.level === 'warn');
  assert.ok(warn);
  assert.match(warn.msg, /无法保存/);
  assert.match(warn.msg, /重启后会重新生成/, '必须说清代价，否则用户不知道下次重启还会断一下');
});

test('读已保存值抛错时重新生成，而不是直接崩', () => {
  const { log, lines } = quietLog();
  const s = memoryStore('');
  const r = resolveOnebotToken({
    env: '',
    toml: '',
    read: () => {
      throw new Error('database is locked');
    },
    write: s.write,
    log,
  });
  assert.equal(r.source, 'generated');
  assert.ok(lines.some((l) => l.level === 'warn' && /读取已保存/.test(l.msg)));
});

test('生成的令牌加密落库，重启后仍能取回同一个值', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-token-'));
  const key = generateKey();
  try {
    const first = new Store(join(dir, 'qqbot.db'));
    first.setBox(Box.fromHex(key));
    const { log } = quietLog();
    const a = resolveOnebotToken({
      env: '',
      toml: '',
      read: () => first.settings.get().onebot.access_token,
      write: (t) => {
        first.settings.update((v) => {
          v.onebot.access_token = t;
        });
      },
      log,
    });
    assert.equal(a.source, 'generated');

    // 库里必须是密文：这个令牌等同 OneBot 的控制面凭据，不能明文躺着
    const row = first.db.get<{ json: string }>('SELECT json FROM settings WHERE id = 1');
    assert.ok(row);
    const raw = JSON.parse(row.json) as { onebot: { access_token: string } };
    assert.match(raw.onebot.access_token, /^enc:/);
    assert.equal(raw.onebot.access_token.includes(a.token), false);
    first.close();

    const second = new Store(join(dir, 'qqbot.db'));
    second.setBox(Box.fromHex(key));
    const b = resolveOnebotToken({
      env: '',
      toml: '',
      read: () => second.settings.get().onebot.access_token,
      write: (t) => {
        second.settings.update((v) => {
          v.onebot.access_token = t;
        });
      },
      log: quietLog().log,
    });
    assert.equal(b.token, a.token, '重启换令牌 = 每次重启都改协议端配置 = 每次重启都断一次线');
    assert.equal(b.source, 'stored');
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('换过主密钥导致解不开时重新生成（不是静默用空令牌）', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-token-'));
  try {
    const first = new Store(join(dir, 'qqbot.db'));
    first.setBox(Box.fromHex(generateKey()));
    first.settings.update((v) => {
      v.onebot.access_token = 'old-token';
    });
    first.close();

    const second = new Store(join(dir, 'qqbot.db'));
    // 换了密钥：解不出来。此时若把空串当令牌用，机器人会以"无凭据"去拨号，
    // 而协议端还留着旧令牌——症状是 401 死循环且日志里什么都没说。
    second.setBox(Box.fromHex(generateKey()));
    assert.equal(second.settings.get().onebot.access_token, '');
    const { log } = quietLog();
    const r = resolveOnebotToken({
      env: '',
      toml: '',
      read: () => second.settings.get().onebot.access_token,
      write: (t) => {
        second.settings.update((v) => {
          v.onebot.access_token = t;
        });
      },
      log,
    });
    assert.equal(r.source, 'generated');
    assert.notEqual(r.token, 'old-token');
    assert.match(r.token, /^[0-9a-f]{32}$/);
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('老库没有 onebot 块时不会崩，归一化补出空值再生成', () => {
  // 升级路径：0.10 之前写下的 settings JSON 里没有 onebot 这一组。
  // load() 的注释说得很清楚——它跑在登录之前，一抛就是面板 500 且无法自救。
  // 这里钉住"缺块 → 补默认 → 生成"，而不是靠 normalizeSettings 的通用逻辑兜着。
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-token-'));
  try {
    const first = new Store(join(dir, 'qqbot.db'));
    // 直接写一行"0.10 之前那种"设置：只有 llm，没有 onebot / panel / memory……
    const legacy = { llm: { base_url: 'https://api.deepseek.com', api_key: '', model: 'm' } };
    const json = JSON.stringify(legacy);
    first.db.run(
      'INSERT INTO settings (id, json, updated_at) VALUES (1, ?, 0) ON CONFLICT(id) DO UPDATE SET json = ?',
      json,
      json,
    );
    first.close();

    const second = new Store(join(dir, 'qqbot.db'));
    second.setBox(Box.fromHex(generateKey()));
    const settings = second.settings.get();
    assert.equal(settings.onebot.access_token, '', '缺块要补成空值，不能是 undefined');

    const { log } = quietLog();
    const r = resolveOnebotToken({
      env: '',
      toml: '',
      read: () => second.settings.get().onebot.access_token,
      write: (t) => {
        second.settings.update((v) => {
          v.onebot.access_token = t;
        });
      },
      log,
    });
    assert.equal(r.source, 'generated');
    assert.equal(second.settings.get().onebot.access_token, r.token);
    second.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
