// 本机执行层的单元测试。
//
// 这里跑的是真进程、真文件：执行层的作用就是「把 shell 和 fs 的脾气摸清楚」，
// 用假实现测它等于什么都没测。为了让同一套用例在 Windows 开发机和 alpine
// 容器里都能跑，所有命令都通过 `shell` 参数换成 `node -e <脚本>`——
// 这样断言的是「退出码/超时/截断」这套机制，而不是某条 shell 语法。
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, normalize } from 'node:path';
import { after, describe, it } from 'node:test';
import {
  CommandLock,
  READ_MAX_LINES,
  clipOutput,
  listDir,
  readTextFile,
  resolvePath,
  runCommand,
  writeTextFile,
} from '../src/bot/computer-exec';

const tmpDirs: string[] = [];

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'qqbot-exec-'));
  tmpDirs.push(d);
  return d;
}

after(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

/** 用 node 当 shell：command 就是一段 JS。 */
const nodeShell = { file: process.execPath, args: ['-e'] };

function run(script: string, opt: { timeoutMs?: number; maxOutput?: number; cwd?: string } = {}) {
  return runCommand(script, {
    cwd: opt.cwd ?? tmp(),
    timeoutMs: opt.timeoutMs ?? 10_000,
    maxOutput: opt.maxOutput,
    shell: nodeShell,
  });
}

describe('runCommand', () => {
  it('退出码 0：带回 stdout 与 stderr', async () => {
    const r = await run(`process.stdout.write('hi'); process.stderr.write('err');`);
    assert.equal(r.code, 0);
    assert.equal(r.timedOut, false);
    assert.equal(r.truncated, false);
    assert.match(r.output, /hi/);
    assert.match(r.output, /err/);
  });

  it('非零退出码不抛错：码原样带回给模型', async () => {
    const r = await run(`process.exit(3)`);
    assert.equal(r.code, 3);
    assert.equal(r.timedOut, false);
  });

  it('超时被杀，标记 timedOut 且带回已产生的输出', async () => {
    const started = Date.now();
    const r = await run(`process.stdout.write('半截'); setTimeout(() => {}, 30000)`, { timeoutMs: 1000 });
    assert.equal(r.timedOut, true);
    assert.match(r.output, /半截/);
    assert.ok(Date.now() - started < 8000, '不该真的等 30 秒');
  });

  it('输出按上限截断，保留头尾而不是只留头', async () => {
    const r = await run(`process.stdout.write('H' + 'x'.repeat(100000) + 'T')`, { maxOutput: 2048 });
    assert.equal(r.truncated, true);
    assert.ok(r.output.length < 3000, `实际长度 ${r.output.length}`);
    assert.match(r.output, /中间省略/);
    assert.ok(r.output.startsWith('H'), '头部要留住');
    assert.ok(r.output.endsWith('T'), '尾部要留住');
  });

  it('工作目录不存在时给出中文错误', async () => {
    await assert.rejects(
      () => runCommand(`process.exit(0)`, { cwd: join(tmp(), 'nope'), timeoutMs: 5000, shell: nodeShell }),
      /启动命令失败/,
    );
  });
});

describe('CommandLock', () => {
  it('第二条命令直接拒绝，不排队', async () => {
    const lock = new CommandLock();
    const first = lock.tryRun(() => run(`setTimeout(() => {}, 800)`));
    const second = await lock.tryRun(() => Promise.resolve('second'));
    assert.equal(second.ran, false, '1 核机器上不该让第二条排队');
    const done = await first;
    assert.equal(done.ran, true);
    // 跑完之后又能用了
    const third = await lock.tryRun(() => Promise.resolve('third'));
    assert.equal(third.ran, true);
  });
});

describe('clipOutput', () => {
  it('短文本原样返回', () => {
    const r = clipOutput('abc', 10);
    assert.equal(r.text, 'abc');
    assert.equal(r.truncated, false);
  });

  it('长文本标出省略了多少字符', () => {
    const r = clipOutput('a'.repeat(100), 20);
    assert.equal(r.truncated, true);
    assert.match(r.text, /省略 \d+ 字符/);
  });
});

describe('readTextFile', () => {
  it('带行号，行号宽度按总行数对齐', async () => {
    const p = join(tmp(), 'a.txt');
    writeFileSync(p, 'one\ntwo\nthree\n');
    const r = await readTextFile(p);
    assert.equal(r.lines, 3, '结尾换行不该多算一行');
    assert.equal(r.text.split('\n')[0], '1| one');
    assert.equal(r.text.split('\n')[2], '3| three');
  });

  it('超过行数上限就截断并标注', async () => {
    const p = join(tmp(), 'b.txt');
    writeFileSync(p, Array.from({ length: 3000 }, (_, i) => `L${i + 1}`).join('\n'));
    const r = await readTextFile(p, { maxLines: 100 });
    assert.equal(r.lines, 100);
    assert.equal(r.truncatedLines, true);
    assert.equal(r.text.split('\n').length, 100);
  });

  it('二进制文件直接拒绝，不往上下文里塞乱码', async () => {
    const p = join(tmp(), 'c.bin');
    writeFileSync(p, Buffer.from([0x61, 0x62, 0x00, 0x63, 0x64]));
    await assert.rejects(() => readTextFile(p), /二进制/);
  });

  it('目录给出可执行的提示', async () => {
    await assert.rejects(() => readTextFile(tmp()), /目录/);
  });

  it('默认行数上限不会被越过', async () => {
    assert.equal(READ_MAX_LINES, 2000);
  });
});

describe('writeTextFile', () => {
  it('父目录不存在时自动建，并区分新建/覆盖', async () => {
    const p = join(tmp(), 'x', 'y', 'z.txt');
    const first = await writeTextFile(p, '你好');
    assert.equal(first.created, true);
    assert.equal(first.bytes, 6, '中文按 UTF-8 算 6 字节');

    const second = await writeTextFile(p, '你好');
    assert.equal(second.created, false);

    const back = await readTextFile(p);
    assert.match(back.text, /你好/);
  });

  it('目标是目录时拒绝', async () => {
    const d = join(tmp(), 'dir');
    mkdirSync(d);
    await assert.rejects(() => writeTextFile(d, 'x'), /目录/);
  });
});

describe('listDir', () => {
  it('目录在前、带大小、深度受限', async () => {
    const root = tmp();
    mkdirSync(join(root, 'alpha'));
    mkdirSync(join(root, 'beta'));
    writeFileSync(join(root, 'top.txt'), 'abc');
    mkdirSync(join(root, 'alpha', 'deep'));
    writeFileSync(join(root, 'alpha', 'deep', 'far.txt'), 'x');

    const r = await listDir(root, { maxDepth: 1 });
    const lines = r.text.split('\n');
    assert.equal(lines[0], root);
    const fileAt = lines.findIndex((l) => l.includes('top.txt'));
    assert.ok(lines.indexOf('  alpha/') < fileAt, '目录要排在文件前面');
    assert.ok(lines.some((l) => l.trim() === 'deep/'), '深度 1 的目录要列出来');
    assert.ok(!r.text.includes('far.txt'), '深度 1 以下的文件不该出现');
  });

  it('条数上限会截断并说明', async () => {
    const root = tmp();
    for (let i = 0; i < 60; i++) writeFileSync(join(root, `f${i}.txt`), 'x');
    const r = await listDir(root, { maxEntries: 20 });
    assert.equal(r.truncated, true);
    assert.equal(r.entries, 20);
    assert.match(r.text, /只列了前面这些/);
  });

  it('对文件调用时给出可执行的提示', async () => {
    const p = join(tmp(), 'one.txt');
    writeFileSync(p, 'x');
    await assert.rejects(() => listDir(p), /不是目录/);
  });
});

describe('resolvePath', () => {
  it('相对路径按工作目录解析', () => {
    const cwd = tmp();
    assert.equal(resolvePath('a/b.txt', cwd), join(cwd, 'a', 'b.txt'));
  });

  it('绝对路径原样规范化', () => {
    assert.equal(resolvePath('/a/../b', '/opt'), normalize('/b'));
  });

  it('~ 展开成家目录', () => {
    assert.equal(resolvePath('~/x', '/opt'), join(process.env.HOME ?? process.env.USERPROFILE ?? '', 'x'));
  });
});
