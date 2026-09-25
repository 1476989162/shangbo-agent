import { app } from 'electron'
import Database from 'better-sqlite3'
import { join } from 'node:path'
import log from 'electron-log/main'

let db: Database.Database | null = null
let dbFilePath = ''

interface Migration {
  version: number
  sql: string
}

/**
 * 迁移一旦发布就不可修改，只能追加新版本。
 * 消息以 parent_id 组成树，而不是线性数组——「编辑重发」「重新生成」「分支切换」
 * 都建立在树结构上，这是本应用最不可妥协的数据模型决策。
 */
const MIGRATIONS: Migration[] = [
  {
    version: 1,
    sql: `
      CREATE TABLE IF NOT EXISTS conversations (
        id            TEXT PRIMARY KEY,
        title         TEXT NOT NULL DEFAULT '新对话',
        project_id    TEXT,
        provider_id   TEXT,
        model         TEXT,
        system_prompt TEXT,
        created_at    INTEGER NOT NULL,
        updated_at    INTEGER NOT NULL,
        archived_at   INTEGER
      );

      CREATE TABLE IF NOT EXISTS messages (
        id              TEXT PRIMARY KEY,
        conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
        parent_id       TEXT REFERENCES messages(id) ON DELETE CASCADE,
        role            TEXT NOT NULL,
        blocks          TEXT NOT NULL DEFAULT '[]',
        status          TEXT NOT NULL DEFAULT 'done',
        error           TEXT,
        provider_id     TEXT,
        model           TEXT,
        usage           TEXT,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_messages_conv   ON messages(conversation_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_messages_parent ON messages(parent_id);

      CREATE TABLE IF NOT EXISTS conversation_state (
        conversation_id TEXT PRIMARY KEY REFERENCES conversations(id) ON DELETE CASCADE,
        active_leaf_id  TEXT
      );

      CREATE TABLE IF NOT EXISTS providers (
        id         TEXT PRIMARY KEY,
        name       TEXT NOT NULL,
        kind       TEXT NOT NULL,
        base_url   TEXT NOT NULL,
        models     TEXT NOT NULL DEFAULT '[]',
        enabled    INTEGER NOT NULL DEFAULT 1,
        priority   INTEGER NOT NULL DEFAULT 100,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS settings (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS memories (
        id              TEXT PRIMARY KEY,
        scope           TEXT NOT NULL DEFAULT 'global',
        conversation_id TEXT,
        content         TEXT NOT NULL,
        embedding       BLOB,
        created_at      INTEGER NOT NULL,
        updated_at      INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS mcp_servers (
        id           TEXT PRIMARY KEY,
        name         TEXT NOT NULL,
        transport    TEXT NOT NULL,
        command      TEXT,
        args         TEXT NOT NULL DEFAULT '[]',
        url          TEXT,
        env          TEXT NOT NULL DEFAULT '{}',
        enabled      INTEGER NOT NULL DEFAULT 0,
        auto_approve TEXT NOT NULL DEFAULT '[]',
        created_at   INTEGER NOT NULL,
        updated_at   INTEGER NOT NULL
      );
    `
  },
  {
    // v2：供应商支持自定义 HTTP 请求头（部分网关如 opencode 要求 x-opencode-session）
    version: 2,
    sql: `ALTER TABLE providers ADD COLUMN headers TEXT NOT NULL DEFAULT '{}';`
  },
  {
    // v3：对话可绑定本机项目目录，作为工具相对路径与命令工作目录的锚点
    version: 3,
    sql: `ALTER TABLE conversations ADD COLUMN working_dir TEXT;`
  }
]

function migrate(database: Database.Database): void {
  database.exec(
    'CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL)'
  )
  const applied = new Set(
    (database.prepare('SELECT version FROM schema_migrations').all() as { version: number }[]).map(
      (row) => row.version
    )
  )

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) continue
    const run = database.transaction(() => {
      database.exec(migration.sql)
      database
        .prepare('INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)')
        .run(migration.version, Date.now())
    })
    run()
    log.info(`[db] 已应用迁移 v${migration.version}`)
  }
}

export function getDb(): Database.Database {
  if (db) return db

  dbFilePath = join(app.getPath('userData'), 'shangbo-agent.db')
  db = new Database(dbFilePath)
  db.pragma('journal_mode = WAL')
  db.pragma('foreign_keys = ON')
  db.pragma('synchronous = NORMAL')
  migrate(db)
  log.info(`[db] 已打开 ${dbFilePath}`)
  return db
}

export function getDbPath(): string {
  return dbFilePath || join(app.getPath('userData'), 'shangbo-agent.db')
}

export function closeDatabase(): void {
  if (!db) return
  db.close()
  db = null
  log.info('[db] 已关闭')
}