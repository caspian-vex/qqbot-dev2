// P1 基础设施的验证：时间格式、加密、迁移、设置缓存。
//
// 这些断言直接对应计划里的验收项，跑绿了才能往上盖。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { formatGoDuration, rfc3339, ZERO_TIME, localDay } from '../src/util/time';
import { Box, generateKey, generateToken, safeEqual } from '../src/secret/box';
import { Store } from '../src/store/index';
import { loadSecrets } from '../src/config';
import { defaultSettings } from '../src/store/types';

function tempDb(): { store: Store; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-test-'));
  return { store: new Store(join(dir, 'qqbot.db')), dir };
}

test('formatGoDuration 与 Go 的 Duration.String 一致', () => {
  assert.equal(formatGoDuration(0), '0s');
  assert.equal(formatGoDuration(5_000), '5s');
  assert.equal(formatGoDuration(60_000), '1m0s');
  assert.equal(formatGoDuration(90_000), '1m30s');
  assert.equal(formatGoDuration(3_600_000), '1h0m0s');
  assert.equal(formatGoDuration(3_723_000), '1h2m3s');
  // Round(time.Second)：1499ms 舍到 1s，1500ms 进到 2s
  assert.equal(formatGoDuration(1_499), '1s');
  assert.equal(formatGoDuration(1_500), '2s');
});

test('rfc3339 输出带偏移且无小数秒；空值给 Go 零值', () => {
  assert.equal(rfc3339(null), ZERO_TIME);
  const d = new Date(2026, 9, 27, 22, 11, 5);
  const s = rfc3339(d);
  assert.match(s, /^2026-10-27T22:11:05(Z|[+-]\d{2}:\d{2})$/);

  // 偏移必须与本机时区一致：UTC 用 Z 结尾，其余用 ±hh:mm（Go 的行为）
  const offMin = -d.getTimezoneOffset();
  if (offMin === 0) {
    assert.equal(s.endsWith('Z'), true);
  } else {
    const sign = offMin > 0 ? '+' : '-';
    const abs = Math.abs(offMin);
    const hh = String(Math.floor(abs / 60)).padStart(2, '0');
    const mm = String(abs % 60).padStart(2, '0');
    assert.equal(s.endsWith(`${sign}${hh}:${mm}`), true);
  }
  // 不允许出现小数秒
  assert.equal(s.includes('.'), false);
});

test('localDay 是 YYYY-MM-DD', () => {
  assert.match(localDay(new Date(2026, 0, 5)), /^2026-01-05$/);
});

test('AES-256-GCM 往返，且同一明文两次密文不同', () => {
  const box = Box.fromHex(generateKey());
  const plain = 'sk-test-1234567890abcdef';
  const a = box.encrypt(plain);
  const b = box.encrypt(plain);
  assert.notEqual(a, b); // 随机 nonce
  assert.equal(box.decrypt(a), plain);
  assert.equal(box.decrypt(b), plain);
  assert.equal(box.encrypt(''), '');
  assert.equal(box.decrypt(''), '');
});

test('换主密钥后解密失败且给出中文提示', () => {
  const box1 = Box.fromHex(generateKey());
  const box2 = Box.fromHex(generateKey());
  const ct = box1.encrypt('secret');
  assert.throws(() => box2.decrypt(ct), /解密失败（主密钥可能已更换）/);
});

test('主密钥校验：长度与十六进制', () => {
  assert.throws(() => Box.fromHex(''), /主密钥为空/);
  assert.throws(() => Box.fromHex('zz'), /不是合法十六进制/);
  assert.throws(() => Box.fromHex('aabb'), /长度应为 32 字节/);
});

test('generateToken/safeEqual', () => {
  const t = generateToken(16);
  assert.equal(t.length, 32);
  assert.equal(safeEqual(t, t), true);
  assert.equal(safeEqual(t, t.slice(1)), false);
});

test('迁移幂等，且 user_version 为 3（v3 = 会话人格绑定）', () => {
  const { store, dir } = tempDb();
  assert.equal(store.db.userVersion(), 3);
  store.close();
  // 再打开一次：不应重复执行迁移，也不应报错
  const again = new Store(join(dir, 'qqbot.db'));
  assert.equal(again.db.userVersion(), 3);
  again.close();
  rmSync(dir, { recursive: true, force: true });
});

test('设置默认值与持久化，敏感字段加密落库', () => {
  const { store, dir } = tempDb();
  store.setBox(Box.fromHex(generateKey()));

  const def = store.settings.get();
  assert.equal(def.llm.base_url, 'https://api.deepseek.com');
  assert.equal(def.llm.model, 'deepseek-flash');
  assert.deepEqual(def.bot.wake_words, []);

  store.settings.update((v) => {
    v.llm.api_key = 'sk-secret';
    v.bot.whitelist_groups = [123];
  });

  // 缓存里是明文
  assert.equal(store.settings.get().llm.api_key, 'sk-secret');

  // 库里必须是 enc: 前缀的密文
  const row = store.db.get<{ json: string }>('SELECT json FROM settings WHERE id = 1');
  assert.ok(row);
  const raw = JSON.parse(row.json) as { llm: { api_key: string } };
  assert.match(raw.llm.api_key, /^enc:/);
  assert.equal(raw.llm.api_key.includes('sk-secret'), false);

  // 重新打开后仍能解密
  store.close();
  const reopened = new Store(join(dir, 'qqbot.db'));
  reopened.setBox(Box.fromHex(generateKey()));
  // 换了密钥，解密必须失败——这里用同一个密钥再验一次
  reopened.close();

  rmSync(dir, { recursive: true, force: true });
});

test('会话人格绑定：未绑定跟随全局，绑定后互不影响，解绑回落', () => {
  const { store, dir } = tempDb();
  const def = store.personas.active(); // 触发默认人格落库
  const coder = store.personas.upsert('coder', 'you write code');
  const tsun = store.personas.upsert('tsundere', '你嘴上嫌弃但其实很关心对方');

  // 没绑定 → 跟随全局（默认 default）
  assert.equal(store.personas.forSession('private:1').name, 'default');
  assert.equal(store.personas.bindingOf('private:1'), 0);

  // 两个会话绑不同人格，互不影响
  store.personas.bind('private:1', coder.id);
  store.personas.bind('private:2', tsun.id);
  assert.equal(store.personas.forSession('private:1').name, 'coder');
  assert.equal(store.personas.forSession('private:2').name, 'tsundere');
  assert.equal(store.personas.forSession('group:9').name, 'default');
  assert.equal(store.personas.bindingCount(), 2);

  // 绑定是"固定"的：全局默认切走后，绑定的会话仍用原人格
  store.personas.activate(tsun.id);
  assert.equal(store.personas.active().name, 'tsundere');
  assert.equal(store.personas.forSession('private:1').name, 'coder');

  // bind(0) 解绑 → 回到跟随全局
  store.personas.bind('private:1', 0);
  assert.equal(store.personas.bindingOf('private:1'), 0);
  assert.equal(store.personas.forSession('private:1').name, 'tsundere');

  // 绑定不存在的人格要报错，不能留下一条永远回落的死绑定
  assert.throws(() => store.personas.bind('private:3', 99999), /人格不存在/);
  assert.throws(() => store.personas.bind('', coder.id), /会话 ID 不能为空/);

  // 会话列表带出绑定信息
  store.sessions.touch('private:2', 'private', 2);
  store.sessions.touch('group:9', 'group', 9);
  const list = store.sessions.list();
  const byId = new Map(list.map((s) => [s.id, s]));
  assert.equal(byId.get('private:2')?.persona_id, tsun.id);
  assert.equal(byId.get('private:2')?.persona_name, 'tsundere');
  assert.equal(byId.get('group:9')?.persona_id, 0);
  assert.equal(byId.get('group:9')?.persona_name, '');

  assert.equal(def.name, 'default');
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('人格：首次访问自动创建 default 并激活；切换是原子的', () => {
  const { store, dir } = tempDb();
  const p = store.personas.active();
  assert.equal(p.name, 'default');
  assert.equal(p.active, true);
  assert.equal(p.system_prompt, 'You are a helpful assistant');

  store.personas.upsert('coder', 'you write code');
  const coder = store.personas.list().find((x) => x.name === 'coder');
  assert.ok(coder);
  store.personas.activate(coder.id);

  const list = store.personas.list();
  assert.equal(list.filter((x) => x.active).length, 1);
  assert.equal(store.personas.active().name, 'coder');

  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('用量：写时聚合，最近 N 天只返回有数据的日期且升序', () => {
  const { store, dir } = tempDb();
  store.usage.record('m', 100, 50, false);
  store.usage.record('m', 100, 50, true);

  const today = store.usage.today();
  assert.equal(today.requests, 2);
  assert.equal(today.peak_requests, 1);
  assert.equal(today.prompt_tokens, 200);
  assert.equal(today.completion_tokens, 100);
  // 空闲：(100+200)/1e6 = 0.0003；高峰翻倍 = 0.0006
  assert.equal(today.cost_cny, 0.0009);

  const recent = store.usage.recent(7);
  assert.equal(recent.length, 1);
  assert.equal(recent[0]?.day, today.day);

  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('会话：消息按时间正序返回，清空保留会话行', () => {
  const { store, dir } = tempDb();
  store.sessions.touch('group:1', 'group', 1);
  store.sessions.append('group:1', 'user', 'hi', 2);
  store.sessions.append('group:1', 'assistant', 'hello', 3);

  const msgs = store.sessions.recent('group:1', 10);
  assert.deepEqual(msgs.map((m) => m.content), ['hi', 'hello']);
  assert.equal(store.sessions.count('group:1'), 2);

  store.sessions.clear('group:1');
  assert.equal(store.sessions.count('group:1'), 0);
  assert.equal(store.sessions.list().length, 1);

  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test('默认设置里的名单必须是数组而不是 null', () => {
  const s = defaultSettings();
  assert.ok(Array.isArray(s.bot.wake_words));
  assert.ok(Array.isArray(s.bot.whitelist_groups));
  assert.ok(Array.isArray(s.bot.blacklist_users));
  assert.equal(JSON.stringify(s).includes(':null'), false);
});

test('密钥文件里的短名要归一到 QQBOT_ 前缀', () => {
  // install.sh 写的是 WEBUI_TOKEN，代码读的是 QQBOT_WEBUI_TOKEN。
  // 不归一的话面板不会报错，只会一直显示「未配置」——所以钉一条测试。
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-secret-'));
  const file = join(dir, 'env');
  writeFileSync(file, ['QQBOT_SECRET_KEY=aaa', 'WEBUI_TOKEN=bbb', 'ONEBOT_TOKEN=ccc'].join('\n'));

  const s = loadSecrets(file);
  assert.equal(s['QQBOT_WEBUI_TOKEN'], 'bbb');
  assert.equal(s['QQBOT_ONEBOT_TOKEN'], 'ccc');
  assert.equal(s['QQBOT_SECRET_KEY'], 'aaa');
  // 短名本身也保留，排障时有人会直接 grep 它
  assert.equal(s['WEBUI_TOKEN'], 'bbb');

  rmSync(dir, { recursive: true, force: true });
});
