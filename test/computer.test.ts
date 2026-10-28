// 电脑操作工具层的单测。
//
// 这里只测「工具这一层」：危险命令拦不拦、谁有权限、工具真的跑起来是什么样。
// 引擎的循环（带不带工具、次数预算、回灌）在 engine.test.ts 里验。
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { ApprovalQueue } from '../src/bot/computer-approval';
import {
  COMPUTER_TOOL_NAMES,
  computerAccess,
  computerPromptBlock,
  computerTools,
  dangerOf,
  dangerPathOf,
  isComputerTool,
  resolveWorkdir,
  runComputerTool,
  type ComputerActor,
  type ComputerContext,
} from '../src/bot/computer';
import { defaultComputer } from '../src/store/types';
import { Logger } from '../src/log/logger';

const tmpDirs: string[] = [];

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'qqbot-cmp-'));
  tmpDirs.push(d);
  return d;
}

after(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

const log = Logger.create({ level: 'error', format: 'text' });

function actor(over: Partial<ComputerActor> = {}): ComputerActor {
  return { sid: 'private:10001', kind: 'private', target: 10001, user: 10001, role: '', ...over };
}

/** 一套「已授权、免审批」的上下文，工具层用例默认用它。 */
function ctx(cwd: string, over: Partial<ComputerContext> = {}): ComputerContext {
  return {
    settings: { ...defaultComputer(), enabled: true, owner_qq: 10001, require_approval: false },
    actor: actor(),
    cwd,
    approvals: new ApprovalQueue(),
    log,
    audit: () => undefined,
    ...over,
  };
}

describe('dangerOf', () => {
  it('拦下删根、格式化、关机、容器控制这类不可逆命令', () => {
    const cases: [string, string][] = [
      ['rm -rf /', '递归删除'],
      ['rm -rf /*', '递归删除'],
      ['rm -fr ~', '递归删除'],
      ['sudo rm -rf /', '提权'],
      ['rm --no-preserve-root -rf /', '删除保护'],
      ['mkfs.ext4 /dev/sda1', '格式化'],
      ['fdisk /dev/sda', '分区'],
      ['dd if=/dev/zero of=/dev/sda', '块设备'],
      ['shutdown -h now', '关机'],
      ['reboot', '重启'],
      ['docker ps', '容器'],
      ['systemctl restart nginx', '系统服务'],
      ['passwd root', '账号密码'],
      ['mount /dev/sdb /mnt', '挂载'],
      ['echo hi | docker ps', '容器'],
      ['ls && shutdown -h now', '关机'],
      ['echo x > /dev/sda', '覆写磁盘'],
    ];
    for (const [cmd, why] of cases) {
      const v = dangerOf(cmd);
      assert.equal(v.denied, true, `${cmd} 应该被拒绝`);
      assert.match(v.reason, new RegExp(why));
    }
  });

  it('不误伤日常诊断命令', () => {
    const cases = [
      'ls -la',
      'df -h',
      'cat /etc/hosts',
      'tail -n 50 /opt/qqbot/data/qqbot.log',
      'grep -rn docker src/',
      'rm -rf ./dist',
      'rm -f /tmp/x.log',
      'echo "docker"',
      'ps aux | grep node',
      'head -c 100 /opt/qqbot/data/qqbot.db',
    ];
    for (const cmd of cases) {
      const v = dangerOf(cmd);
      assert.equal(v.denied, false, `${cmd} 不该被拒绝（${v.reason}）`);
    }
  });

  it('空命令直接放行（由调用方报"command 是空的"）', () => {
    assert.equal(dangerOf('   ').denied, false);
  });

  it('写文件的系统路径被挡，普通路径放行', () => {
    assert.equal(dangerPathOf('/proc/sys/kernel/x').denied, true);
    assert.equal(dangerPathOf('/etc/passwd').denied, true);
    assert.equal(dangerPathOf('/etc/sudoers').denied, true);
    assert.equal(dangerPathOf('/opt/qqbot/data/notes.txt').denied, false);
    assert.equal(dangerPathOf('/etc/hosts').denied, false, '只挡会毁系统的那几个，不是白名单');
  });
});

describe('computerAccess', () => {
  const c = { ...defaultComputer(), enabled: true, owner_qq: 10001, allow_users: [20002], allow_groups: [30003] };

  it('主人私聊可用', () => {
    assert.equal(computerAccess(c, actor()).allowed, true);
  });

  it('陌生私聊不可用', () => {
    const v = computerAccess(c, actor({ user: 99999, sid: 'private:99999', target: 99999 }));
    assert.equal(v.allowed, false);
    assert.match(v.reason, /白名单/);
  });

  it('白名单好友可用', () => {
    assert.equal(computerAccess(c, actor({ user: 20002, sid: 'private:20002' })).allowed, true);
  });

  it('白名单群里只有群主和管理员可用', () => {
    const g = (role: string) => actor({ kind: 'group', sid: 'group:30003', target: 30003, user: 555, role });
    assert.equal(computerAccess(c, g('owner')).allowed, true);
    assert.equal(computerAccess(c, g('admin')).allowed, true);
    const member = computerAccess(c, g('member'));
    assert.equal(member.allowed, false);
    assert.match(member.reason, /群主和管理员/);
  });

  it('不在白名单的群一律不行（哪怕说话的人是群主）', () => {
    const v = computerAccess(c, actor({ kind: 'group', sid: 'group:40004', target: 40004, role: 'owner' }));
    assert.equal(v.allowed, false);
  });

  it('总开关关着时主人也不行', () => {
    assert.equal(computerAccess({ ...c, enabled: false }, actor()).allowed, false);
  });
});

describe('工具声明与说明', () => {
  it('恰好四个工具，名字固定', () => {
    const names = computerTools().map((t) => t.function.name);
    assert.deepEqual(names.sort(), ['list_dir', 'read_file', 'run_command', 'write_file']);
    assert.equal(COMPUTER_TOOL_NAMES.length, 4);
    assert.equal(isComputerTool('run_command'), true);
    assert.equal(isComputerTool('web_search'), false);
  });

  it('说明里带工作目录、超时与"别装东西"', () => {
    const c = defaultComputer();
    const block = computerPromptBlock(c, '/opt/qqbot/data');
    assert.match(block, /\/opt\/qqbot\/data/);
    assert.match(block, /20 秒/);
    assert.match(block, /不要安装软件包/);
    assert.match(block, /面板上确认/, '默认要审批，就得说清楚');
  });

  it('关掉审批时不再提"等批准"', () => {
    const block = computerPromptBlock({ ...defaultComputer(), require_approval: false }, '/data');
    assert.doesNotMatch(block, /面板上确认/);
  });

  it('工作目录为空时退到数据目录', () => {
    assert.equal(resolveWorkdir(defaultComputer(), '/opt/qqbot/data'), '/opt/qqbot/data');
  });
});

describe('runComputerTool', () => {
  it('read_file 带行号；write_file 先新建再覆盖；list_dir 看得到', async () => {
    const dir = tmp();
    const c = ctx(dir);

    const w1 = await runComputerTool('write_file', JSON.stringify({ path: 'sub/a.txt', content: 'hello' }), c);
    assert.match(w1, /新建/);
    assert.match(w1, /5 字节/);

    const w2 = await runComputerTool('write_file', JSON.stringify({ path: 'sub/a.txt', content: 'hello2' }), c);
    assert.match(w2, /覆盖/);

    const r = await runComputerTool('read_file', JSON.stringify({ path: 'sub/a.txt' }), c);
    assert.match(r, /1\| hello2/);

    const l = await runComputerTool('list_dir', JSON.stringify({}), c);
    assert.match(l, /sub\//);
  });

  it('run_command 拿得到输出与退出码', async () => {
    const c = ctx(tmp());
    const out = await runComputerTool('run_command', JSON.stringify({ command: 'echo hi' }), c);
    assert.match(out, /退出码 0/);
    assert.match(out, /hi/);
  });

  it('危险命令连审批都不进', async () => {
    const approvals = new ApprovalQueue();
    const c = ctx(tmp(), { approvals, settings: { ...defaultComputer(), enabled: true, require_approval: true } });
    const out = await runComputerTool('run_command', JSON.stringify({ command: 'rm -rf /' }), c);
    assert.match(out, /硬性拒绝/);
    assert.equal(approvals.size, 0, '硬拒的命令不该在面板上留一条待批准');
  });

  it('未批准就不执行', async () => {
    const dir = tmp();
    const approvals = new ApprovalQueue();
    const c = ctx(dir, { approvals, settings: { ...defaultComputer(), enabled: true, require_approval: true } });

    const p = runComputerTool('write_file', JSON.stringify({ path: 'x.txt', content: 'nope' }), c);
    // 等面板出现待批准，然后拒绝
    const deadline = Date.now() + 2000;
    let id = '';
    while (Date.now() < deadline && id === '') {
      const first = approvals.list()[0];
      if (first) id = first.id;
      else await new Promise((r) => setTimeout(r, 5));
    }
    assert.notEqual(id, '', '应该挂起一条待批准');
    approvals.decide(id, false);

    const out = await p;
    assert.match(out, /没有得到批准/);
    assert.equal(existsSyncJoin(dir, 'x.txt'), false, '拒绝之后文件不该出现');
  });

  it('批准之后才真的执行', async () => {
    const dir = tmp();
    const approvals = new ApprovalQueue();
    const c = ctx(dir, { approvals, settings: { ...defaultComputer(), enabled: true, require_approval: true } });

    const p = runComputerTool('write_file', JSON.stringify({ path: 'ok.txt', content: 'yes' }), c);
    const deadline = Date.now() + 2000;
    let id = '';
    while (Date.now() < deadline && id === '') {
      const first = approvals.list()[0];
      if (first) id = first.id;
      else await new Promise((r) => setTimeout(r, 5));
    }
    approvals.decide(id, true);

    const out = await p;
    assert.match(out, /新建/);
    assert.equal(existsSyncJoin(dir, 'ok.txt'), true);
  });

  it('未知工具名回一句，不抛错', async () => {
    const out = await runComputerTool('format_disk', '{}', ctx(tmp()));
    assert.match(out, /没有名为/);
  });

  it('路径不存在给出中文原因', async () => {
    const out = await runComputerTool('read_file', JSON.stringify({ path: 'nope.txt' }), ctx(tmp()));
    assert.match(out, /执行失败/);
    assert.match(out, /不存在/);
  });
});

/** 用 join 拼路径再判存在，避免 Windows 上相对路径判错。 */
function existsSyncJoin(dir: string, name: string): boolean {
  return existsSync(join(dir, name));
}
