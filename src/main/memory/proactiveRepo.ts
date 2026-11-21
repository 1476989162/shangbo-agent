import { getDb } from '../db'
import {
  learnFromFeedback,
  type Clue,
  type LearnedRule,
  type ProactiveAction,
  type ProactiveContext
} from './dreaming'

/**
 * Proactive / Dreaming 的持久化层（v8 三张表）。
 *
 * 设计要点：DB 只存「已学规则 / 线索计数 / 当日判定日志」这三件确定的事；
 * 「聊天是否安静满 3 分钟」和「静默期汇总队列」是进程内瞬时状态，写库没有意义，
 * 也不该在用户发消息的关键路径上产生写 IO。
 */
export const CHAT_QUIET_MS = 3 * 60 * 1000
export const QUIET_HOUR_START = 22
export const QUIET_HOUR_END = 8

export function localDayStr(now = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

export function listRules(): Record<string, ProactiveAction> {
  const rows = getDb().prepare('SELECT kind, action FROM proactive_rules').all() as {
    kind: string
    action: ProactiveAction
  }[]
  const out: Record<string, ProactiveAction> = {}
  for (const row of rows) out[row.kind] = row.action
  return out
}

export function upsertRule(rule: LearnedRule, now = Date.now()): void {
  getDb()
    .prepare(
      `INSERT INTO proactive_rules (kind, action, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(kind) DO UPDATE SET action = excluded.action, updated_at = excluded.updated_at`
    )
    .run(rule.kind, rule.action, now)
}

export function listClues(): Clue[] {
  const rows = getDb().prepare('SELECT kind, action, seen FROM proactive_clues').all() as Clue[]
  return rows.map((r) => ({ kind: r.kind, action: r.action, seen: r.seen }))
}

export function setClues(clues: Clue[], now = Date.now()): void {
  const db = getDb()
  const write = db.transaction(() => {
    db.prepare('DELETE FROM proactive_clues').run()
    const insert = db.prepare(
      'INSERT INTO proactive_clues (kind, action, seen, updated_at) VALUES (?, ?, ?, ?)'
    )
    for (const clue of clues) insert.run(clue.kind, clue.action, clue.seen, now)
  })
  write()
}

/** 同一事项一天只判一次；返回 false 表示今天已判过，调用方不应重复决策。 */
export function recordDecision(
  dayStr: string,
  itemKey: string,
  action: ProactiveAction,
  now = Date.now()
): boolean {
  const result = getDb()
    .prepare(
      `INSERT OR IGNORE INTO proactive_daily_log (day_str, item_key, action, created_at)
       VALUES (?, ?, ?, ?)`
    )
    .run(dayStr, itemKey, action, now)
  return result.changes > 0
}

export function listJudgedToday(dayStr: string): string[] {
  const rows = getDb()
    .prepare('SELECT item_key FROM proactive_daily_log WHERE day_str = ?')
    .all(dayStr) as { item_key: string }[]
  return rows.map((r) => r.item_key)
}

export function countRemindersToday(dayStr: string): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS n FROM proactive_daily_log WHERE day_str = ? AND action = 'tell-now'")
    .get(dayStr) as { n: number }
  return row.n
}

export function loadProactiveContext(now = new Date()): ProactiveContext & { dayStr: string } {
  const dayStr = localDayStr(now)
  return {
    dayStr,
    remindersToday: countRemindersToday(dayStr),
    judgedToday: listJudgedToday(dayStr),
    rules: listRules()
  }
}

/** 用户回复 → 线索/规则落库，返回本轮是否成规（供日志与后续决策用）。 */
export function applyFeedback(
  text: string,
  kind: string,
  hour = new Date().getHours()
): { rule: LearnedRule | null; direct: boolean } {
  const outcome = learnFromFeedback(listClues(), text, kind, hour)
  setClues(outcome.clues)
  if (outcome.rule) upsertRule(outcome.rule)
  return { rule: outcome.rule, direct: outcome.direct }
}

/* ---------- 进程内瞬时状态（不落库、不进用户等待路径） ---------- */

let lastUserMessageAt = 0
let followUpQueue: Array<{ title: string; body: string; at: number }> = []

export function noteUserMessage(at = Date.now()): void {
  lastUserMessageAt = Math.max(lastUserMessageAt, at)
}

/** 距离最近一次前台用户发言过了多久；从未发言过视为「足够安静」。 */
export function chatQuietForMs(now = Date.now()): number {
  return lastUserMessageAt === 0 ? Number.POSITIVE_INFINITY : Math.max(0, now - lastUserMessageAt)
}

export function isChatQuiet(now = Date.now()): boolean {
  return chatQuietForMs(now) >= CHAT_QUIET_MS
}

export function queueFollowUp(title: string, body: string, at = Date.now()): void {
  if (followUpQueue.length >= 50) followUpQueue.shift()
  followUpQueue.push({ title, body, at })
}

/** 08:00 之后才允许把静默期攒下的消息汇总成一条推送。 */
export function takeFollowUps(hour: number): Array<{ title: string; body: string; at: number }> {
  if (hour < QUIET_HOUR_END || hour >= QUIET_HOUR_START) return []
  if (followUpQueue.length === 0) return []
  const pending = followUpQueue
  followUpQueue = []
  return pending
}

export function followUpCount(): number {
  return followUpQueue.length
}

/** 仅供单测清理进程内状态。 */
export function resetProactiveTransientState(): void {
  lastUserMessageAt = 0
  followUpQueue = []
}
