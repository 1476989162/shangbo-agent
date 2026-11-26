import { getDb, onDatabaseClose } from './db'

/**
 * 设置项以 JSON 字符串存于 settings 表，避免为每个开关加一次迁移。
 *
 * 写透内存缓存：设置是读多写少，getSetting 先查内存、未命中再读库；
 * setSetting 写库成功后同步更新内存。缓存与 DB 实例绑定（而非全局永久）：
 * 关库重开（测试多库切换）时实例变化即整体失效，从根上杜绝零跨库脏读；
 * 并经 onDatabaseClose 注册同步清理——关库瞬间清空，不经过微任务，
 * 避免异步清理误伤关库后立刻打开的下个 DB 的缓存。
 * 缓存联动失效（技能/经验/MCP）语义不变。
 */

const settingsCache = new Map<string, unknown>()
/** 缓存归属的 DB 实例；关库重开后实例变化，读写前自动整桶失效。 */
let cacheOwner: unknown = null

function ensureCacheScope(): void {
  let db: unknown = null
  try {
    db = getDb()
  } catch {
    // 库尚未初始化（如单测只调 clearSettingsCache）：保持现状，不抛错
    return
  }
  if (db !== cacheOwner) {
    settingsCache.clear()
    cacheOwner = db
  }
}

/** 测试/关库用：清空写透缓存并解绑 DB 实例。 */
export function clearSettingsCache(): void {
  settingsCache.clear()
  cacheOwner = null
}

// 关库同步清理：db/index.ts 只暴露钩子、不反向依赖 settings，
// 静态单向依赖 settings → db，无循环导入。
onDatabaseClose(clearSettingsCache)

/** 设置项以 JSON 字符串存于 settings 表，避免为每个开关加一次迁移。 */
export function getSetting<T>(key: string, fallback: T): T {
  ensureCacheScope()
  if (settingsCache.has(key)) return settingsCache.get(key) as T
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  if (!row) return fallback
  try {
    const value = JSON.parse(row.value) as T
    settingsCache.set(key, value)
    return value
  } catch {
    return fallback
  }
}

export function setSetting(key: string, value: unknown): void {
  getDb()
    .prepare(
      `INSERT INTO settings (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .run(key, JSON.stringify(value))
  // 写透：落库成功才更新内存；先对齐 DB 实例作用域，避免跨库污染。
  ensureCacheScope()
  settingsCache.set(key, value)
  // 缓存联动失效：技能/经验/MCP 都是读多写少，写时立即失效，避免 30s-5min 延迟。
  // 用动态 import 避免 settings ↔ loader/store 循环依赖；失效失败不影响主写。
  try {
    if (key === 'agent.skillDirs' || key.startsWith('agent.plugins') || key.startsWith('agent.skill')) {
      void import('./skills/loader').then((m) => m.invalidateSkillPacksCache?.()).catch(() => {})
      void import('./agent/runtime').then((m) => m.invalidateContextStaticsCache?.()).catch(() => {})
    }
    if (key.startsWith('agent.mcp') || key === 'agent.mcpServers') {
      void import('./mcp/manager').then((m) => {
        try { m.mcpManager.invalidateStatusCache() } catch {}
      }).catch(() => {})
      void import('./agent/agentLoop').then((m) => m.invalidateMcpSchemasCache?.()).catch(() => {})
      void import('./agent/runtime').then((m) => m.invalidateContextStaticsCache?.()).catch(() => {})
    }
    if (key === 'agent.plugins' || key === 'agent.instructions' || key === 'agent.computerUse') {
      void import('./agent/runtime').then((m) => m.invalidateContextStaticsCache?.()).catch(() => {})
    }
  } catch {}
}

export function getAllSettings(): Record<string, unknown> {
  const rows = getDb().prepare('SELECT key, value FROM settings').all() as {
    key: string
    value: string
  }[]
  const out: Record<string, unknown> = {}
  for (const row of rows) {
    try {
      out[row.key] = JSON.parse(row.value)
    } catch {
      out[row.key] = row.value
    }
  }
  // 全量读顺手回填缓存：与单条读写同一份内存视图，不引入第二口径。
  ensureCacheScope()
  for (const [key, value] of Object.entries(out)) settingsCache.set(key, value)
  return out
}
