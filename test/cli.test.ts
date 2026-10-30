// 命令行参数解析的验证。
//
// 这里盯的是「开关被当成带值参数」这类静默失效：
// 解析错了不会报错，只会让 --keep-totp 悄悄失效，
// 用户以为保住了二步验证，实际被关掉了。
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { flagName, parseFlags } from '../src/cli/flags';

test('flag 名归一化：单横线、双横线、下划线、大小写都等价', () => {
  assert.equal(flagName('--db'), 'db');
  assert.equal(flagName('-db'), 'db');
  assert.equal(flagName('--keep-totp'), 'keeptotp');
  assert.equal(flagName('-keepTOTP'), 'keeptotp');
  assert.equal(flagName('--keep_totp'), 'keeptotp');
  assert.equal(flagName('--KEEP-TOTP'), 'keeptotp');
});

test('--keep-totp 被识别成布尔开关，不会吃掉后面的参数', () => {
  const f = parseFlags(['--db', '/tmp/x.db', '--keep-totp']);
  assert.equal(f.db, '/tmp/x.db');
  assert.equal(f.keepTOTP, true);

  // 开关写在前面时，后面的 --db 仍必须被正确解析
  const g = parseFlags(['--keep-totp', '--db', '/tmp/y.db']);
  assert.equal(g.keepTOTP, true);
  assert.equal(g.db, '/tmp/y.db');
});

test('--keep-totp 的三种写法等价，且不与 -config 混用出错', () => {
  for (const flag of ['--keep-totp', '-keep-totp', '--keep_totp', '--keepTOTP']) {
    const f = parseFlags([flag]);
    assert.equal(f.keepTOTP, true, `${flag} 应被识别为布尔开关`);
  }
  const f = parseFlags(['-config', '/etc/qqbot.toml', '--keep-totp']);
  assert.equal(f.config, '/etc/qqbot.toml');
  assert.equal(f.keepTOTP, true);
});

test('没写开关时 keepTOTP 为空（默认关闭 TOTP 的路径不受影响）', () => {
  const f = parseFlags(['--db', '/tmp/z.db']);
  assert.equal(f.keepTOTP, undefined);
  assert.equal(parseFlags([]).keepTOTP, undefined);
});

test('--help / -h 只置 help，不当成带值参数', () => {
  assert.equal(parseFlags(['-h']).help, true);
  assert.equal(parseFlags(['--help']).help, true);
  // help 后面跟的东西不能被吃掉：-h 与 -db 并存时 db 仍然解析得到
  const f = parseFlags(['-h', '-db', '/tmp/h.db']);
  assert.equal(f.help, true);
  assert.equal(f.db, '/tmp/h.db');
});

test('不认识的开关不会吃掉后面的参数', () => {
  // --verbose 没人认，但它绝不能把 --config 当成自己的值：那会让 config
  // 变成 undefined、静默回退到默认路径，机器起来连的是另一份配置。
  const f = parseFlags(['--verbose', '--config', '/opt/qqbot/etc/qqbot.toml']);
  assert.equal(f.config, '/opt/qqbot/etc/qqbot.toml');
});

test('--k=v 写法等价于 --k v', () => {
  const f = parseFlags(['--config=/opt/x.toml', '--db=/opt/x.db']);
  assert.equal(f.config, '/opt/x.toml');
  assert.equal(f.db, '/opt/x.db');

  // 等号写法也不会把后面的参数再吃一遍
  const g = parseFlags(['--config=/opt/y.toml', '--keep-totp']);
  assert.equal(g.config, '/opt/y.toml');
  assert.equal(g.keepTOTP, true);
});

test('带值开关缺值时不会吞掉下一个开关', () => {
  // 这是写错的命令行，但错误的代价不该是"后面的 --db 也丢了"
  const f = parseFlags(['--config', '--db', '/tmp/x.db']);
  assert.equal(f.config, undefined);
  assert.equal(f.db, '/tmp/x.db');
});
