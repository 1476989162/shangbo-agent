import { getDb } from './db'

/** 设置项以 JSON 字符串存于 settings 表，避免为每个开关加一次迁移。 */
export function getSetting<T>(key: string, fallback: T): T {
  const row = getDb().prepare('SELECT value FROM settings WHERE key = ?').get(key) as
    | { value: string }
    | undefined
  if (!row) return fallback
  try {
    return JSON.parse(row.value) as T
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
  return out
}