// 版本号的一致性守卫。
//
// 版本号有三个读者：package.json（本地构建与 npm 的默认值）、git tag（CI 打镜像
// 时的标签）、面板左下角（用户报问题时念出来的那串）。三者只要有一个人忘了改，
// 就会出现"两个不同的构建显示同一个版本"，回溯问题时只能靠猜。
//
// 这里不做任何"自动同步"，只把不一致变成一条红灯：改代码时忘了升版本、
// 升了版本忘了写 CHANGELOG，都会在这里被拦下来。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { versionString } from '../src/version';

const root = join(__dirname, '..');
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as { version: string };
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8')) as {
  version: string;
  packages: Record<string, { version?: string }>;
};
const changelog = readFileSync(join(root, 'CHANGELOG.md'), 'utf8');

/** 从 CHANGELOG 里取第一条形如 `## [1.2.3] - 2026-01-01` 的版本号。 */
function firstChangelogVersion(): string | null {
  const m = /^## \[(\d+\.\d+\.\d+)\]/m.exec(changelog);
  return m ? m[1]! : null;
}

test('版本号是合法的 semver', () => {
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/, `package.json 里是 ${pkg.version}`);
});

test('package-lock 的两处版本与 package.json 一致', () => {
  // 只改一处时 `npm ci` 会警告锁文件与依赖描述不符，但不会失败——
  // 正是那种"看起来没事、下一次装机才出问题"的不一致。
  assert.equal(lock.version, pkg.version);
  assert.equal(lock.packages['']?.version, pkg.version);
});

test('CHANGELOG 最新一条就是当前版本', () => {
  // 这条断言就是"每次更新都要加上版本号"的执行方式：
  // 改了行为却没写 CHANGELOG，或者写了 CHANGELOG 却没升版本，都会红。
  assert.equal(
    firstChangelogVersion(),
    pkg.version,
    'CHANGELOG.md 顶部缺一条与 package.json 同号的记录，先跑 npm run bump',
  );
});

test('版本串能在源码直跑时优雅降级', () => {
  // tsx 直接跑源码时，esbuild 注入的三个常量并不存在（ReferenceError 而非
  // undefined），所以 version.ts 用 try 兜底。这里钉住兜底结果，
  // 免得哪天有人"顺手"把它改成直接读常量，面板一开就崩。
  const s = versionString();
  assert.match(s, /^qqbot \S+ \(/);
  assert.ok(!s.includes('undefined'));
});
