// SQLite 连接、迁移与事务。
//
// 用 Node 内置的 node:sqlite（DatabaseSync）：同步 API，与 Go 版的
// database/sql 调用形态几乎一一对应，且不需要任何原生模块编译——
// 这是「一个架构无关的预编译包同时覆盖 amd64/arm64」的前提。
import { DatabaseSync, type StatementSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/** 迁移脚本，下标即目标版本号。只追加，不改已发布的条目。 */
const MIGRATIONS: string[] = [
  // v1
  `
  CREATE TABLE settings (
    id         INTEGER PRIMARY KEY CHECK (id = 1),
    json       TEXT    NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE personas (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT    NOT NULL UNIQUE,
    system_prompt TEXT    NOT NULL,
    active        INTEGER NOT NULL DEFAULT 0,
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL
  );
  -- 激活人格的唯一性下沉到库，避免应用层并发切换出现两个 active
  CREATE UNIQUE INDEX ux_persona_active ON personas(active) WHERE active = 1;

  CREATE TABLE sessions (
    id         TEXT    PRIMARY KEY,
    kind       TEXT    NOT NULL CHECK (kind IN ('group', 'private')),
    target_id  INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX ix_sessions_updated ON sessions(updated_at DESC);

  CREATE TABLE messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT    NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    role       TEXT    NOT NULL,
    content    TEXT    NOT NULL,
    tokens     INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX ix_messages_page ON messages(session_id, id DESC);

  -- 写时聚合，替代原版「每天扫全表 + N+1 次查询」
  CREATE TABLE usage_daily (
    day               TEXT    PRIMARY KEY,
    requests          INTEGER NOT NULL,
    peak_requests     INTEGER NOT NULL,
    prompt_tokens     INTEGER NOT NULL,
    completion_tokens INTEGER NOT NULL,
    cost_micros       INTEGER NOT NULL
  );

  CREATE TABLE audit_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    action     TEXT    NOT NULL,
    detail     TEXT    NOT NULL,
    remote     TEXT    NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX ix_audit_id ON audit_log(id DESC);
  `,
  // v2：图池标签。
  //
  // 只存标签名与备注，图片本身仍是磁盘上的文件（data/images/<标签>/）。
  // 为什么不在库里记图片：图池是"用户往目录里丢图"的模型，
  // 盘上有文件就算数，库里再记一份就会立刻出现两套事实，
  // 而用户手动拷图进目录时没人会去同步数据库。
  `
  CREATE TABLE image_tags (
    name       TEXT    PRIMARY KEY,
    note       TEXT    NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  );
  `,
];

export class Db {
  readonly raw: DatabaseSync;
  private readonly cache = new Map<string, StatementSync>();
  private depth = 0;

  constructor(readonly path: string) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.raw = new DatabaseSync(path);

    // WAL + NORMAL：兼顾并发读与写入吞吐，避免每条消息 fsync。
    // 低配云盘 IOPS 很低，这一项对稳定性影响很大。
    this.raw.exec('PRAGMA journal_mode = WAL');
    this.raw.exec('PRAGMA synchronous = NORMAL');
    this.raw.exec('PRAGMA busy_timeout = 5000');
    this.raw.exec('PRAGMA foreign_keys = ON');
    // 4MB 页缓存，护住容器的 RSS 预算
    this.raw.exec('PRAGMA cache_size = -4096');

    this.migrate();
  }

  /** 取一条预编译语句（带缓存，热路径不必反复 prepare）。 */
  stmt(sql: string): StatementSync {
    let s = this.cache.get(sql);
    if (!s) {
      s = this.raw.prepare(sql);
      this.cache.set(sql, s);
    }
    return s;
  }

  /** 执行查询并返回第一行。 */
  get<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T | undefined {
    return this.stmt(sql).get(...(params as never[])) as T | undefined;
  }

  /** 执行查询并返回全部行。 */
  all<T = Record<string, unknown>>(sql: string, ...params: unknown[]): T[] {
    return this.stmt(sql).all(...(params as never[])) as T[];
  }

  /** 执行写入，返回受影响行数。 */
  run(sql: string, ...params: unknown[]): number {
    const r = this.stmt(sql).run(...(params as never[]));
    return typeof r.changes === 'bigint' ? Number(r.changes) : r.changes;
  }

  /**
   * 事务包装。node:sqlite 没有 better-sqlite3 那种 transaction() 辅助，
   * 需要自己管 BEGIN/COMMIT，并加嵌套深度守卫（嵌套事务会直接抛错）。
   */
  tx<T>(fn: () => T): T {
    if (this.depth > 0) {
      // 已在事务中：直接执行，由最外层统一提交
      this.depth++;
      try {
        return fn();
      } finally {
        this.depth--;
      }
    }

    this.raw.exec('BEGIN IMMEDIATE');
    this.depth = 1;
    try {
      const out = fn();
      this.raw.exec('COMMIT');
      return out;
    } catch (e) {
      try {
        this.raw.exec('ROLLBACK');
      } catch {
        // 回滚失败不应掩盖原始异常
      }
      throw e;
    } finally {
      this.depth = 0;
    }
  }

  userVersion(): number {
    const row = this.get<{ user_version: number }>('PRAGMA user_version');
    return row ? Number(row.user_version) : 0;
  }

  private migrate(): void {
    const current = this.userVersion();

    if (current > MIGRATIONS.length) {
      // 库比程序新：继续跑会用旧代码写坏新结构，宁可拒绝启动
      throw new Error(
        `数据库版本 ${current} 高于程序支持的 ${MIGRATIONS.length}，` +
          `请升级 qqbot 或换回匹配版本`,
      );
    }

    for (let v = current; v < MIGRATIONS.length; v++) {
      const sql = MIGRATIONS[v];
      if (sql === undefined) continue;
      this.tx(() => {
        this.raw.exec(sql);
        // PRAGMA 不支持参数化，这里拼的是程序内的常量整数，安全
        this.raw.exec(`PRAGMA user_version = ${v + 1}`);
      });
    }
  }

  close(): void {
    this.cache.clear();
    this.raw.close();
  }
}
