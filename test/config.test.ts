// 配置加载的边界：默认值、环境变量覆盖、以及"写错了要当场报错"的那几项。
//
// 这里重点是 onebot.url 的方案校验。写错方案的后果不是报错而是"永远连不上"：
// new WebSocket 会在 dial() 里同步抛错，而 dial 的所有失败都被当成网络故障
// 按退避无限重连，日志里只剩一条条"拨号失败"，看上去像协议端没起来。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { loadConfig } from '../src/config';

const dirs: string[] = [];
after(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** 写一份最小可用的 toml，返回它的路径。 */
function toml(body: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'qqbot-cfg-'));
  dirs.push(dir);
  const p = join(dir, 'qqbot.toml');
  writeFileSync(p, body, 'utf8');
  return p;
}

describe('配置加载', () => {
  it('onebot.url 必须是 ws:// 或 wss://', () => {
    const p = toml(`data_dir = "/tmp/qqbot-test"
[onebot]
url = "http://127.0.0.1:3001"
`);
    assert.throws(() => loadConfig(p), /ws:\/\/ 或 wss:\/\//);
  });

  it('onebot.url 为空时仍报"不能为空"', () => {
    const p = toml(`data_dir = "/tmp/qqbot-test"
[onebot]
url = "   "
`);
    assert.throws(() => loadConfig(p), /不能为空/);
  });

  it('合法的 ws/wss 地址照常通过', () => {
    for (const url of ['ws://napcat:3001', 'wss://example.com/ws']) {
      const p = toml(`data_dir = "/tmp/qqbot-test"
[onebot]
url = "${url}"
`);
      assert.equal(loadConfig(p).config.onebot.url, url);
    }
  });

  it('未知配置项给出 warning 而不是直接失败', () => {
    const p = toml(`data_dir = "/tmp/qqbot-test"
[onebot]
url = "ws://127.0.0.1:3001"
no_such_key = 1
`);
    const { warning } = loadConfig(p);
    assert.match(warning ?? '', /未知配置项/);
  });

  it('配置文件不存在时回退默认值并提示', () => {
    const { config, warning } = loadConfig(join(tmpdir(), 'qqbot-nope', 'x.toml'));
    assert.equal(config.onebot.url, 'ws://127.0.0.1:3001');
    assert.match(warning ?? '', /配置文件不存在/);
  });
});
