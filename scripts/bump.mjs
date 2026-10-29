// 版本号推进脚本：`npm run bump -- <patch|minor|major|x.y.z> [说明]`
//
// 为什么要有这个脚本：
//   版本号在本项目里有三个读者——package.json（本地构建的默认值）、
//   git tag（CI 发布镜像时的镜像标签）、面板左下角（用户报问题时会念出来）。
//   三者靠手工同步必然漂移，最常见的是"改了代码忘了改版本"，于是两个不同的
//   构建在面板上显示同一个号，回溯问题只能靠猜。所以把"升版本 + 记一条变更"
//   做成一条命令，并配一条测试（test/version.test.ts）盯着两者是否一致。
//
// 只改三个地方：package.json、package-lock.json（两处 version）、CHANGELOG.md。
// 不碰 git——提交与打 tag 是人的决定，脚本只负责把文件改对。
import { readFileSync, writeFileSync } from 'node:fs';

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

function fail(msg) {
  process.stderr.write(`${msg}\n`);
  process.exit(1);
}

const pkgPath = 'package.json';
const lockPath = 'package-lock.json';
const logPath = 'CHANGELOG.md';

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'));
const cur = SEMVER.exec(pkg.version);
if (!cur) fail(`package.json 里的版本号不是合法的 semver：${pkg.version}`);

const arg = (process.argv[2] ?? '').trim();
const note = process.argv.slice(3).join(' ').trim();

/** 当前版本 + 增量 → 新版本。传完整版本号时直接用它，但要更大。 */
function nextVersion(input) {
  const exact = SEMVER.exec(input);
  const base = [Number(cur[1]), Number(cur[2]), Number(cur[3])];

  if (exact) {
    const want = [Number(exact[1]), Number(exact[2]), Number(exact[3])];
    for (let i = 0; i < 3; i++) {
      if (want[i] !== base[i]) {
        if (want[i] < base[i]) fail(`新版本 ${input} 小于当前 ${pkg.version}`);
        return want.join('.');
      }
    }
    fail(`新版本 ${input} 与当前版本相同`);
  }

  switch (input) {
    case 'major':
      return `${base[0] + 1}.0.0`;
    case 'minor':
      return `${base[0]}.${base[1] + 1}.0`;
    case 'patch':
      return `${base[0]}.${base[1]}.${base[2] + 1}`;
    default:
      return fail('用法：npm run bump -- <patch|minor|major|x.y.z> [一句说明]');
  }
}

const next = nextVersion(arg);
const today = new Date().toISOString().slice(0, 10);
// 先留一份旧号：下面会把 pkg.version 覆盖掉，打印时再读就成了"0.3.0 → 0.3.0"。
const from = pkg.version;

if (!note) {
  process.stderr.write('提示：没给说明，CHANGELOG 里会留一条待补的空条目。\n');
}

// ---- package.json ----
pkg.version = next;
writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);

// ---- package-lock.json ----
// 两处：顶层 version，以及 packages[""] 里那份（npm 自己的元数据）。
// 只改一处时 `npm ci` 会警告 lock 与 package 不一致。
const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
lock.version = next;
if (lock.packages && lock.packages['']) lock.packages[''].version = next;
writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);

// ---- CHANGELOG.md ----
const entry = [`## [${next}] - ${today}`, '', `- ${note || '（待补）'}`, ''].join('\n');
const log = readFileSync(logPath, 'utf8');

// 插在文件头部说明之后、第一条版本记录之前。用第一条 `## [` 作锚点，
// 而不是按行号——文件被人手工编辑过也能用。
const anchor = log.indexOf('\n## [');
const updated = anchor < 0
  ? `${log.trimEnd()}\n\n${entry}`
  : `${log.slice(0, anchor + 1)}${entry}\n${log.slice(anchor + 1)}`;
writeFileSync(logPath, updated);

process.stdout.write(
  `版本 ${from} → ${next}\n` +
    `CHANGELOG 已加一条。接下来：\n` +
    `  git add -A && git commit -m "chore(release): v${next}"\n` +
    `  git tag v${next} && git push origin main --tags\n`,
);
