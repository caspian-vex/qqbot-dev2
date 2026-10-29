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
  // v3：会话 → 人格绑定。
  //
  // 为什么单开一张表而不是给 sessions 加列：
  //   1. sessions 的行是「收到第一条消息」时才 touch 出来的，加列的话
  //      还没说过话的群就没地方预置人格；这张表不依赖 sessions 存在。
  //   2. 绑定关系可能指向任意会话 ID，与 sessions 的生命周期（清理、
  //      删除）解耦；会话被删了，绑定留着也不会有害。
  // persona_id 上加 ON DELETE CASCADE：人格被删时绑定一并清掉，
  // 否则会留下指向不存在人格的死绑定，查询直接返回空。
  `
  CREATE TABLE session_personas (
    session_id TEXT    PRIMARY KEY,
    persona_id INTEGER NOT NULL REFERENCES personas(id) ON DELETE CASCADE,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX ix_session_personas_pid ON session_personas(persona_id);
  `,
  // v4：给绑定补「对话对象快照」。
  //
  // 预设人格时那个群/好友可能一条消息都没有，sessions 里没有对应的行，
  // 面板就只能显示 group:1101472600 这样一串号码——三十个群号谁也认不出。
  // 所以绑定时把群名/昵称一并存下来。
  // 附带的好处：协议端掉线时 /api/groups 会 502，有快照的话已预设的
  // 列表照样能列出来、能改、能解绑，不会因为拉不到列表就变成一片空白。
  //
  // 允许默认空串而不是回填：老库里的绑定本来就没存名字，回填不了；
  // 面板对空名字退化成显示 ID，行为跟升级前一致。
  `
  ALTER TABLE session_personas ADD COLUMN kind TEXT NOT NULL DEFAULT '';
  ALTER TABLE session_personas ADD COLUMN target_name TEXT NOT NULL DEFAULT '';
  `,
  // v5：会话表记下对话对象的名字。
  //
  // 面板那一列原来显示 group:1101472600 / private:2083882365——号码对不上人，
  // 群多了根本认不出哪个是哪个。名字有了着落：
  //   群聊 → get_group_info（引擎算 {{group_name}} 时本来就拉过，缓存里现成）
  //   私聊 → 消息发送者的名片 / 昵称
  // 允许空串：老会话没有这个信息，行为退回升级前（显示号码）；
  // 面板再拿 /api/groups + /api/friends 兜一次，协议端在线时也能补齐。
  `
  ALTER TABLE sessions ADD COLUMN name TEXT NOT NULL DEFAULT '';
  `,
  // v6：按对话对象的设置覆盖。
  //
  // 为什么单开一张表、而不是给 sessions 加列：与 v3/v4 是同一个教训——
  // sessions 的行要收到第一条消息才 touch 出来，而"给一个安静的群单独配
  // 一套触发规则"恰恰发生在它开口之前。加列的话，用户配完刷新一下行就没了。
  //
  // 为什么不挂到 session_personas 上：
  //   1. 那张表的 persona_id 是 NOT NULL，只想覆盖设置、不改人格的会话
  //      会被迫写一行假人格；
  //   2. 它的生命周期由 personas 的 ON DELETE CASCADE 管，删一个人格就会
  //      顺手删掉整会话的设置——两件毫不相干的事。
  //
  // overrides 存 JSON（与 settings 同一思路）：组的集合将来还会加，
  // 加一组不该再来一次迁移；访问路径只有 WHERE session_id = ?，
  // 不需要按字段检索。不加 JSON CHECK：坏数据要让面板看得见、
  // 让引擎回落到全局，而不是让整库写不进去。
  //
  // kind / target_name 是快照，理由同 v4：只有覆盖、没有消息的会话在
  // sessions 里不存在，面板要把它补成一行并显示名字。
  `
  CREATE TABLE session_settings (
    session_id  TEXT    PRIMARY KEY,
    kind        TEXT    NOT NULL DEFAULT '',
    target_name TEXT    NOT NULL DEFAULT '',
    overrides   TEXT    NOT NULL DEFAULT '{}',
    updated_at  INTEGER NOT NULL
  );
  `,
  // v7：预排的主动消息（"闹钟"）。
  //
  // 为什么必须落库、而不能只靠内存里的 setTimeout：
  // 进程重启、`qqbot up` 重建容器、OOM 被杀（1 核 2G 上很常见），
  // 内存里的定时器全都没了。用户昨天让机器人"明早提醒我交房租"，
  // 早上容器刚好重建过一次，这条提醒就凭空消失——而面板上会显示"已设置"。
  //
  // 不放 pendingEcho 那种"排定即执行"的路由里，也刻意不建外键：
  // 与 v3/v4/v6 是同一个教训——预设的对话对象可能还没有 sessions 行。
  //
  // status 用文本而不是布尔：将来会有 'expired'（过期未发）与
  // 'cancelled'（用户撤了），用 done 一个字段表达不了"为什么没发"。
  `
  CREATE TABLE scheduled_messages (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT    NOT NULL,
    kind       TEXT    NOT NULL CHECK (kind IN ('group', 'private')),
    target_id  INTEGER NOT NULL,
    due_at     INTEGER NOT NULL,
    source     TEXT    NOT NULL DEFAULT 'tool',
    body       TEXT    NOT NULL DEFAULT '',
    status     TEXT    NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL,
    fired_at   INTEGER NOT NULL DEFAULT 0
  );
  CREATE INDEX ix_sched_due ON scheduled_messages(status, due_at);
  CREATE INDEX ix_sched_session ON scheduled_messages(session_id, status);
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
