import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import { getDb } from '../db'
import * as repo from '../db/repo'
import { getSetting } from '../settings'
import { eventBus } from '../events/bus'
import { textOf } from '../providers/types'
import { agentRuntime } from './runtime'
import type { AgentEvent } from '../../shared/types'

/**
 * Meta / AlterEgo 异步后台分身（对标 Linger docs/task-delegation.md、team-md.md）。
 *
 * - task_create 只做同步的建行/建目录，10ms 内返回；真正的子循环放 setImmediate 后台跑，
 *   父回合完全不阻塞。
 * - 每个分身拥有独立且归档（UI 列表不可见）的子会话，产出写到
 *   `<workspace>/.shangbo-tasks/<taskId>/`，互不覆盖。
 * - 完成 / 失败 / 等待审批通过 eventBus 的 delegated_task_report 汇报给父会话。
 * - 默认不自动唤醒 Meta 发消息（避免无限自激），只让 task_status 可查；
 *   需要自动汇报时打开 agent.tasks.wakeMetaOnDone。
 */
export type DelegatedState = 'running' | 'waiting_for_approval' | 'idle' | 'failed' | 'canceled'

export interface DelegatedTaskRecord {
  id: string
  parentConversationId: string
  childConversationId: string
  title: string
  brief: string
  state: DelegatedState
  workspaceDir: string | null
  lastReport: string
  error: string | null
  createdAt: number
  updatedAt: number
}

export interface TeamMember {
  id: string
  role: string
  receivesFrom?: string[]
  deliverable: string
}

export const MAX_CONCURRENT_ALTEREGOS = 10
export const APPROVAL_TIMEOUT_MS = 10 * 60_000

const ALTEREGO_RULES = `【AlterEgo 后台分身 · 铁律】
1. 你不直接向用户发问；有疑问写进最终报告，交由 Meta 决定是否问用户。
2. 你不可再创建后台分身（禁止调用 task_create），防止无限套娃。
3. 若工作目录里有 team.md，按其中的 Goal / Coordinator / Members / Handoff DAG 接力。
4. 产出文件一律写进分配给你的独立工作目录，不要覆盖主工作区里的同名文件。
5. 结束时给出简短报告：做了什么、产出路径、剩余风险。`

interface TaskRow {
  id: string
  parent_conversation_id: string
  child_conversation_id: string
  title: string
  brief: string
  state: DelegatedState
  workspace_dir: string | null
  last_report: string
  error: string | null
  created_at: number
  updated_at: number
}

function rowToRecord(row: TaskRow): DelegatedTaskRecord {
  return {
    id: row.id,
    parentConversationId: row.parent_conversation_id,
    childConversationId: row.child_conversation_id,
    title: row.title,
    brief: row.brief,
    state: row.state,
    workspaceDir: row.workspace_dir,
    lastReport: row.last_report,
    error: row.error,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

/** 结构化协作协议（team.md）：Goal / Coordinator / Member DAG，供多分身接力读取。 */
export function buildTeamMarkdown(
  goal: string,
  coordinator: string,
  members: TeamMember[]
): string {
  const lines = [
    '# Team Protocol',
    '',
    '## Goal',
    goal.trim(),
    '',
    '## Coordinator',
    coordinator.trim() || 'Meta',
    '',
    '## Members',
    ''
  ]
  for (const member of members) {
    lines.push(
      `### ${member.id}`,
      `- role: ${member.role}`,
      `- receives_from: ${(member.receivesFrom ?? []).join(', ') || 'Meta'}`,
      `- deliverable: ${member.deliverable}`,
      ''
    )
  }
  lines.push('## Handoff DAG', '')
  for (const member of members) {
    lines.push(`- ${(member.receivesFrom ?? []).join(' + ') || 'Meta'} → ${member.id} → Meta`)
  }
  return `${lines.join('\n')}\n`
}

function rowById(id: string): DelegatedTaskRecord | null {
  const row = getDb().prepare('SELECT * FROM delegated_tasks WHERE id = ?').get(id) as TaskRow | undefined
  return row ? rowToRecord(row) : null
}

function rowByChild(childConversationId: string): DelegatedTaskRecord | null {
  const row = getDb()
    .prepare(
      'SELECT * FROM delegated_tasks WHERE child_conversation_id = ? ORDER BY created_at DESC LIMIT 1'
    )
    .get(childConversationId) as TaskRow | undefined
  return row ? rowToRecord(row) : null
}

export function getDelegatedTask(id: string): DelegatedTaskRecord | null {
  return rowById(id)
}

/** 分身子会话不允许再派分身（工具层用此判断做硬拦截）。 */
export function isDelegatedChildConversation(conversationId: string): boolean {
  return rowByChild(conversationId) !== null
}

export function countActive(parentConversationId: string): number {
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM delegated_tasks
       WHERE parent_conversation_id = ? AND state IN ('running', 'waiting_for_approval')`
    )
    .get(parentConversationId) as { n: number }
  return row.n
}

function patchTask(
  id: string,
  patch: Partial<Pick<DelegatedTaskRecord, 'state' | 'lastReport' | 'error' | 'brief'>>
): void {
  const fields: string[] = []
  const values: unknown[] = []
  if (patch.state !== undefined) {
    fields.push('state = ?')
    values.push(patch.state)
  }
  if (patch.lastReport !== undefined) {
    fields.push('last_report = ?')
    values.push(patch.lastReport)
  }
  if (patch.error !== undefined) {
    fields.push('error = ?')
    values.push(patch.error)
  }
  if (patch.brief !== undefined) {
    fields.push('brief = ?')
    values.push(patch.brief)
  }
  if (fields.length === 0) return
  fields.push('updated_at = ?')
  values.push(Date.now(), id)
  getDb().prepare(`UPDATE delegated_tasks SET ${fields.join(', ')} WHERE id = ?`).run(...values)
}

export function listDelegatedTasks(
  parentConversationId: string,
  taskId?: string
): DelegatedTaskRecord[] {
  const rows = taskId
    ? (getDb()
        .prepare('SELECT * FROM delegated_tasks WHERE id = ? AND parent_conversation_id = ?')
        .all(taskId, parentConversationId) as TaskRow[])
    : (getDb()
        .prepare(
          'SELECT * FROM delegated_tasks WHERE parent_conversation_id = ? ORDER BY created_at DESC'
        )
        .all(parentConversationId) as TaskRow[])
  return rows.map(rowToRecord)
}

function collectLastReport(childConversationId: string): string {
  try {
    const messages = repo.listMessages(childConversationId)
    const last = [...messages].reverse().find((m) => m.role === 'assistant')
    return last ? textOf(last.blocks).trim().slice(0, 4_000) : ''
  } catch {
    return ''
  }
}

function publishReport(task: DelegatedTaskRecord, state: DelegatedState, report: string, error?: string): void {
  const event: AgentEvent = {
    type: 'delegated_task_report',
    conversationId: task.parentConversationId,
    taskId: task.id,
    childConversationId: task.childConversationId,
    state,
    report,
    ...(error ? { error } : {})
  }
  eventBus.publish(event)
}

/** 完成/失败时可选唤醒 Meta：默认关闭，避免后台任务自己引发新一轮无限对话。 */
function maybeWakeMeta(task: DelegatedTaskRecord, state: DelegatedState, report: string): void {
  if (!getSetting<boolean>('agent.tasks.wakeMetaOnDone', false)) return
  if (state !== 'idle' && state !== 'failed') return
  setImmediate(() => {
    try {
      agentRuntime.send(
        {
          conversationId: task.parentConversationId,
          parentMessageId: null,
          content: `【后台分身汇报】${task.title}（${state}）\n${report.slice(0, 1_500)}\n请用一两句话向用户汇报结果，不要重新派发任务。`
        },
        agentRuntime.withBus(() => {})
      )
    } catch {
      // 唤醒失败不影响任务结果，Meta 仍可主动调 task_status
    }
  })
}

let unsubscribe: (() => void) | null = null
function ensureSubscribed(): void {
  if (unsubscribe) return
  unsubscribe = eventBus.subscribe((event: AgentEvent) => {
    if (event.type === 'approval_required') {
      const task = rowByChild(event.conversationId)
      if (task && task.state === 'running') {
        patchTask(task.id, { state: 'waiting_for_approval' })
        publishReport(task, 'waiting_for_approval', `等待用户审批工具：${event.name}`)
        setTimeout(() => {
          const current = rowById(task.id)
          if (current?.state === 'waiting_for_approval') patchTask(task.id, { state: 'running' })
        }, APPROVAL_TIMEOUT_MS).unref?.()
      }
      return
    }
    if (event.type === 'run_error') {
      const task = rowByChild(event.conversationId)
      if (!task || task.state === 'canceled') return
      patchTask(task.id, { state: 'failed', error: event.error.slice(0, 4_000) })
      publishReport(task, 'failed', collectLastReport(task.childConversationId), event.error)
      maybeWakeMeta(task, 'failed', event.error)
      return
    }
    if (event.type === 'run_end' && event.queued === 0) {
      const task = rowByChild(event.conversationId)
      if (!task || task.state === 'canceled' || task.state === 'failed') return
      const report = collectLastReport(task.childConversationId)
      patchTask(task.id, { state: 'idle', lastReport: report })
      publishReport(task, 'idle', report)
      maybeWakeMeta(task, 'idle', report)
    }
  })
}

export interface StartTaskInput {
  parentConversationId: string
  title: string
  brief: string
  workingDirectory: string | null
  team?: { goal: string; coordinator?: string; members: TeamMember[] }
}

export interface StartTaskResult {
  taskId: string
  status: 'running'
  workspacePath: string
  childConversationId: string
}

/** 创建并立即返回；子循环在后台异步启动，绝不阻塞当前回合。 */
export function startTask(input: StartTaskInput): StartTaskResult {
  if (isDelegatedChildConversation(input.parentConversationId)) {
    throw new Error('分身不允许再创建分身（禁止无限套娃）')
  }
  if (countActive(input.parentConversationId) >= MAX_CONCURRENT_ALTEREGOS) {
    throw new Error(`同一会话最多并发 ${MAX_CONCURRENT_ALTEREGOS} 个后台分身`)
  }
  const parent = repo.getConversation(input.parentConversationId)
  if (!parent) throw new Error('父会话不存在，无法创建后台分身')

  const id = randomUUID()
  const now = Date.now()
  const root = input.workingDirectory ?? app.getPath('userData')
  const workspaceDir = join(root, '.shangbo-tasks', id)
  try {
    mkdirSync(workspaceDir, { recursive: true })
    writeFileSync(join(workspaceDir, 'brief.md'), `# ${input.title}\n\n${input.brief}\n`, 'utf8')
    if (input.team) {
      writeFileSync(
        join(workspaceDir, 'team.md'),
        buildTeamMarkdown(input.team.goal, input.team.coordinator ?? 'Meta', input.team.members),
        'utf8'
      )
    }
  } catch {
    // 目录不可写不应阻断任务本身；分身仍可用主工作目录
  }

  const child = repo.createConversation({
    title: `分身 · ${input.title}`,
    workingDir: input.workingDirectory,
    mode: 'builder'
  })
  // 归档 = UI 会话列表里隐藏，但 DB 与运行时仍可正常读写
  getDb().prepare('UPDATE conversations SET archived_at = ? WHERE id = ?').run(now, child.id)

  getDb()
    .prepare(
      `INSERT INTO delegated_tasks
        (id, parent_conversation_id, child_conversation_id, title, brief, state,
         workspace_dir, last_report, error, created_at, updated_at)
       VALUES (@id, @parent, @child, @title, @brief, 'running',
               @workspaceDir, '', NULL, @createdAt, @updatedAt)`
    )
    .run({
      id,
      parent: input.parentConversationId,
      child: child.id,
      title: input.title,
      brief: input.brief,
      workspaceDir,
      createdAt: now,
      updatedAt: now
    })

  ensureSubscribed()
  const prompt = [
    ALTEREGO_RULES,
    '',
    `【任务】${input.title}`,
    input.brief,
    '',
    `【独立工作目录】${workspaceDir}`,
    input.team ? '【团队协议】请先读取该目录下的 team.md 再开工。' : ''
  ]
    .filter(Boolean)
    .join('\n')

  setImmediate(() => {
    try {
      agentRuntime.send(
        {
          conversationId: child.id,
          parentMessageId: null,
          content: prompt,
          priority: 'task',
          preemptible: true
        },
        agentRuntime.withBus(() => {})
      )
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      patchTask(id, { state: 'failed', error: message })
      const task = rowById(id)
      if (task) publishReport(task, 'failed', '', message)
    }
  })

  return { taskId: id, status: 'running', workspacePath: workspaceDir, childConversationId: child.id }
}

/** 向运行 / idle / canceled 的分身追加指令并重新唤醒子循环。 */
export function sendInstruction(taskId: string, instruction: string): DelegatedTaskRecord {
  const task = rowById(taskId)
  if (!task) throw new Error(`后台分身不存在：${taskId}`)
  patchTask(taskId, {
    state: 'running',
    brief: `${task.brief}\n\n【补充指令】${instruction}`.slice(0, 20_000),
    error: null
  })
  const leaf = repo.getActiveLeaf(task.childConversationId)
  setImmediate(() => {
    try {
      agentRuntime.send(
        {
          conversationId: task.childConversationId,
          parentMessageId: leaf,
          content: `【Meta 补充指令】${instruction}`,
          priority: 'task',
          preemptible: true
        },
        agentRuntime.withBus(() => {})
      )
    } catch (error) {
      patchTask(taskId, {
        state: 'failed',
        error: error instanceof Error ? error.message : String(error)
      })
    }
  })
  return rowById(taskId)!
}

/** 取消（暂停）分身：保留已生成的文件与子会话历史，后续仍可 task_send 恢复。 */
export function cancelTask(taskId: string): DelegatedTaskRecord {
  const task = rowById(taskId)
  if (!task) throw new Error(`后台分身不存在：${taskId}`)
  patchTask(taskId, { state: 'canceled' })
  try {
    agentRuntime.abortConversationRuns(task.childConversationId)
  } catch {
    // 已结束的任务不必中断
  }
  return rowById(taskId)!
}

/** 单测用：解除事件订阅，避免跨用例串扰。 */
export function resetTaskDelegationForTesting(): void {
  unsubscribe?.()
  unsubscribe = null
}
