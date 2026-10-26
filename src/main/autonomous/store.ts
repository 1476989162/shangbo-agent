import { randomUUID } from 'node:crypto'
import { getDb } from '../db'
import type {
  AutonomousRun,
  AutonomousRunStatus,
  AutonomousTask,
  AutonomousTaskInput,
  Lesson
} from '../../shared/types'

interface TaskRow {
  id: string
  name: string
  prompt: string
  acceptance: string
  working_dir: string
  schedule: string
  interval_minutes: number | null
  verify_command: string
  max_verify_attempts: number
  enabled: number
  conversation_id: string | null
  next_run_at: number | null
  last_run_at: number | null
  last_status: string | null
  last_error: string | null
  failure_count: number
  max_steps: number
  max_runs_per_day: number
  created_at: number
  updated_at: number
}

interface RunRow {
  id: string
  task_id: string
  conversation_id: string | null
  run_id: string | null
  status: string
  summary: string
  error: string | null
  started_at: number
  finished_at: number | null
}

interface LessonRow {
  id: string
  scope: string
  project_path: string | null
  title: string
  content: string
  source_task_id: string | null
  source_run_id: string | null
  confidence: number
  use_count: number
  last_used_at: number | null
  created_at: number
  updated_at: number
}

function toTask(row: TaskRow): AutonomousTask {
  return {
    id: row.id,
    name: row.name,
    prompt: row.prompt,
    acceptance: row.acceptance,
    workingDir: row.working_dir,
    schedule: row.schedule === 'interval' ? 'interval' : 'manual',
    intervalMinutes: row.interval_minutes,
    verifyCommand: row.verify_command,
    maxVerifyAttempts: row.max_verify_attempts,
    enabled: row.enabled === 1,
    conversationId: row.conversation_id,
    nextRunAt: row.next_run_at,
    lastRunAt: row.last_run_at,
    lastStatus: row.last_status,
    lastError: row.last_error,
    failureCount: row.failure_count,
    maxSteps: row.max_steps,
    maxRunsPerDay: row.max_runs_per_day,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function toRun(row: RunRow): AutonomousRun {
  return {
    id: row.id,
    taskId: row.task_id,
    conversationId: row.conversation_id,
    runId: row.run_id,
    status: row.status as AutonomousRunStatus,
    summary: row.summary,
    error: row.error,
    startedAt: row.started_at,
    finishedAt: row.finished_at
  }
}

function toLesson(row: LessonRow): Lesson {
  return {
    id: row.id,
    scope: row.scope === 'project' ? 'project' : 'global',
    projectPath: row.project_path,
    title: row.title,
    content: row.content,
    sourceTaskId: row.source_task_id,
    sourceRunId: row.source_run_id,
    confidence: row.confidence,
    useCount: row.use_count,
    lastUsedAt: row.last_used_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

/** 周期任务的下一触发点；手动任务永远为 null。 */
export function computeNextRunAt(
  schedule: AutonomousTask['schedule'],
  intervalMinutes: number | null,
  from = Date.now()
): number | null {
  if (schedule !== 'interval' || !intervalMinutes || intervalMinutes <= 0) return null
  return from + intervalMinutes * 60_000
}

export function listTasks(): AutonomousTask[] {
  const rows = getDb()
    .prepare('SELECT * FROM autonomous_tasks ORDER BY created_at DESC')
    .all() as TaskRow[]
  return rows.map(toTask)
}

export function getTask(id: string): AutonomousTask | null {
  const row = getDb().prepare('SELECT * FROM autonomous_tasks WHERE id = ?').get(id) as
    | TaskRow
    | undefined
  return row ? toTask(row) : null
}

export function upsertTask(input: AutonomousTaskInput): AutonomousTask {
  const now = Date.now()
  const current = input.id ? getTask(input.id) : null
  const id = input.id ?? randomUUID()
  const schedule = input.schedule ?? current?.schedule ?? 'manual'
  const intervalMinutes =
    input.intervalMinutes !== undefined ? input.intervalMinutes : (current?.intervalMinutes ?? null)
  // 自主调度是显式授权能力：未传 enabled 时默认停用，避免新建任务在用户还没打开总开关前自己跑。
  const enabled = input.enabled ?? current?.enabled ?? true
  const wasEnabled = current?.enabled ?? false
  const scheduleChanged =
    !current || current.schedule !== schedule || current.intervalMinutes !== intervalMinutes
  let nextRunAt = current?.nextRunAt ?? null
  if (!enabled || schedule !== 'interval') {
    nextRunAt = null
  } else if (!current || !wasEnabled || scheduleChanged || nextRunAt === null) {
    // 新建/重新启用/改周期时从下一个周期开始，避免保存设置就立刻消耗一次模型调用。
    nextRunAt = computeNextRunAt(schedule, intervalMinutes, now)
  }

  const row: TaskRow = {
    id,
    name: input.name.trim() || '未命名自主任务',
    prompt: input.prompt.trim(),
    acceptance: input.acceptance?.trim() ?? current?.acceptance ?? '',
    working_dir: input.workingDir.trim(),
    schedule,
    interval_minutes: schedule === 'interval' ? Math.max(1, Math.floor(intervalMinutes ?? 60)) : null,
    verify_command: input.verifyCommand?.trim() ?? current?.verifyCommand ?? '',
    max_verify_attempts: Math.max(
      0,
      Math.min(10, Math.floor(input.maxVerifyAttempts ?? current?.maxVerifyAttempts ?? 2))
    ),
    enabled: enabled ? 1 : 0,
    conversation_id: current?.conversationId ?? null,
    next_run_at: nextRunAt,
    last_run_at: current?.lastRunAt ?? null,
    last_status: current?.lastStatus ?? null,
    last_error: current?.lastError ?? null,
    failure_count: current?.failureCount ?? 0,
    max_steps: Math.max(1, Math.min(500, Math.floor(input.maxSteps ?? current?.maxSteps ?? 80))),
    max_runs_per_day: Math.max(
      1,
      Math.min(100, Math.floor(input.maxRunsPerDay ?? current?.maxRunsPerDay ?? 12))
    ),
    created_at: current?.createdAt ?? now,
    updated_at: now
  }

  getDb()
    .prepare(
      `INSERT INTO autonomous_tasks
         (id, name, prompt, acceptance, working_dir, schedule, interval_minutes,
          verify_command, max_verify_attempts, enabled, conversation_id, next_run_at,
          last_run_at, last_status, last_error, failure_count, max_steps,
          max_runs_per_day, created_at, updated_at)
       VALUES
         (@id, @name, @prompt, @acceptance, @workingDir, @schedule, @intervalMinutes,
          @verifyCommand, @maxVerifyAttempts, @enabled, @conversationId, @nextRunAt,
          @lastRunAt, @lastStatus, @lastError, @failureCount, @maxSteps,
          @maxRunsPerDay, @createdAt, @updatedAt)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         prompt = excluded.prompt,
         acceptance = excluded.acceptance,
         working_dir = excluded.working_dir,
         schedule = excluded.schedule,
         interval_minutes = excluded.interval_minutes,
         verify_command = excluded.verify_command,
         max_verify_attempts = excluded.max_verify_attempts,
         enabled = excluded.enabled,
         next_run_at = excluded.next_run_at,
         failure_count = excluded.failure_count,
         max_steps = excluded.max_steps,
         max_runs_per_day = excluded.max_runs_per_day,
         updated_at = excluded.updated_at`
    )
    .run({
      id: row.id,
      name: row.name,
      prompt: row.prompt,
      acceptance: row.acceptance,
      workingDir: row.working_dir,
      schedule: row.schedule,
      intervalMinutes: row.interval_minutes,
      verifyCommand: row.verify_command,
      maxVerifyAttempts: row.max_verify_attempts,
      enabled: row.enabled,
      conversationId: row.conversation_id,
      nextRunAt: row.next_run_at,
      lastRunAt: row.last_run_at,
      lastStatus: row.last_status,
      lastError: row.last_error,
      failureCount: row.failure_count,
      maxSteps: row.max_steps,
      maxRunsPerDay: row.max_runs_per_day,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    })
  return getTask(id)!
}

export function deleteTask(id: string): void {
  getDb().prepare('DELETE FROM autonomous_tasks WHERE id = ?').run(id)
}

export function setTaskEnabled(id: string, enabled: boolean): AutonomousTask | null {
  const task = getTask(id)
  if (!task) return null
  return upsertTask({
    id: task.id,
    name: task.name,
    prompt: task.prompt,
    acceptance: task.acceptance,
    workingDir: task.workingDir,
    schedule: task.schedule,
    intervalMinutes: task.intervalMinutes,
    verifyCommand: task.verifyCommand,
    maxVerifyAttempts: task.maxVerifyAttempts,
    enabled,
    maxSteps: task.maxSteps,
    maxRunsPerDay: task.maxRunsPerDay
  })
}

export function attachConversation(id: string, conversationId: string): void {
  getDb()
    .prepare('UPDATE autonomous_tasks SET conversation_id = ?, updated_at = ? WHERE id = ?')
    .run(conversationId, Date.now(), id)
}

export function resetTaskForManualRun(id: string): void {
  getDb()
    .prepare(
      `UPDATE autonomous_tasks
       SET last_status = NULL, last_error = NULL, failure_count = 0, updated_at = ?
       WHERE id = ?`
    )
    .run(Date.now(), id)
}

/**
 * 到期任务。手动任务只在“立即运行”时执行，不进入周期扫描；
 * 周期任务的 next_run_at 为空时表示尚未排期，也不应被误判为到期。
 */
export function dueTasks(now = Date.now()): AutonomousTask[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM autonomous_tasks
       WHERE enabled = 1 AND schedule = 'interval'
         AND next_run_at IS NOT NULL AND next_run_at <= ?
       ORDER BY next_run_at ASC`
    )
    .all(now) as TaskRow[]
  return rows.map(toTask)
}

export function markTaskStarted(id: string, startedAt: number): void {
  getDb()
    .prepare(
      `UPDATE autonomous_tasks
       SET last_run_at = ?, last_status = 'running', last_error = NULL, updated_at = ?
       WHERE id = ?`
    )
    .run(startedAt, startedAt, id)
}

/**
 * 原子认领：只有把 next_run_at 从旧的到期值推进成功，才算拿到执行权。
 * 调度 tick 与手动“立即运行”同时发生时，另一条路径会得到 false，不会双跑。
 */
export function claimTask(id: string, expectedNextRunAt: number | null, nextRunAt: number | null): boolean {
  const result =
    expectedNextRunAt === null
      ? getDb()
          .prepare(
            `UPDATE autonomous_tasks
             SET next_run_at = ?, updated_at = ?
             WHERE id = ? AND next_run_at IS NULL`
          )
          .run(nextRunAt, Date.now(), id)
      : getDb()
          .prepare(
            `UPDATE autonomous_tasks
             SET next_run_at = ?, updated_at = ?
             WHERE id = ? AND next_run_at = ?`
          )
          .run(nextRunAt, Date.now(), id, expectedNextRunAt)
  return result.changes === 1
}

export function markTaskFinished(
  id: string,
  status: 'success' | 'failed' | 'skipped',
  error: string | null,
  nextRunAt: number | null
): void {
  const now = Date.now()
  const task = getTask(id)
  const failureCount = status === 'success' ? 0 : (task?.failureCount ?? 0) + 1
  getDb()
    .prepare(
      `UPDATE autonomous_tasks
       SET last_status = ?, last_error = ?, failure_count = ?,
           next_run_at = ?, updated_at = ?
       WHERE id = ?`
    )
    .run(status, error, failureCount, nextRunAt, now, id)
}

export function createRun(input: {
  taskId: string
  conversationId: string | null
  status?: AutonomousRunStatus
}): AutonomousRun {
  const now = Date.now()
  const id = randomUUID()
  getDb()
    .prepare(
      `INSERT INTO autonomous_runs
         (id, task_id, conversation_id, run_id, status, summary, error, started_at, finished_at)
       VALUES (?, ?, ?, NULL, ?, '', NULL, ?, NULL)`
    )
    .run(id, input.taskId, input.conversationId, input.status ?? 'running', now)
  return getRun(id)!
}

export function getRun(id: string): AutonomousRun | null {
  const row = getDb().prepare('SELECT * FROM autonomous_runs WHERE id = ?').get(id) as
    | RunRow
    | undefined
  return row ? toRun(row) : null
}

export function updateRun(
  id: string,
  patch: Partial<Pick<AutonomousRun, 'conversationId' | 'runId' | 'status' | 'summary' | 'error' | 'finishedAt'>>
): void {
  const current = getRun(id)
  if (!current) return
  getDb()
    .prepare(
      `UPDATE autonomous_runs
       SET conversation_id = ?, run_id = ?, status = ?, summary = ?, error = ?, finished_at = ?
       WHERE id = ?`
    )
    .run(
      patch.conversationId !== undefined ? patch.conversationId : current.conversationId,
      patch.runId !== undefined ? patch.runId : current.runId,
      patch.status ?? current.status,
      patch.summary ?? current.summary,
      patch.error !== undefined ? patch.error : current.error,
      patch.finishedAt !== undefined ? patch.finishedAt : current.finishedAt,
      id
    )
}

export function listRuns(taskId?: string, limit = 50): AutonomousRun[] {
  const safeLimit = Math.max(1, Math.min(200, Math.floor(limit)))
  const rows = taskId
    ? (getDb()
        .prepare(
          'SELECT * FROM autonomous_runs WHERE task_id = ? ORDER BY started_at DESC LIMIT ?'
        )
        .all(taskId, safeLimit) as RunRow[])
    : (getDb()
        .prepare('SELECT * FROM autonomous_runs ORDER BY started_at DESC LIMIT ?')
        .all(safeLimit) as RunRow[])
  return rows.map(toRun)
}

/**
 * 启动时把上次进程遗留的 running/verifying 记录收敛为 failed。
 * 进程已经退出，这些运行不可能再收到 run_end；保持 running 会让界面永远转圈。
 */
export function settleOrphanAutonomousRuns(): number {
  const now = Date.now()
  const result = getDb()
    .prepare(
      `UPDATE autonomous_runs
       SET status = 'failed',
           error = COALESCE(error, '应用重启，上一轮自主运行已中断'),
           finished_at = ?
       WHERE status IN ('running', 'verifying')`
    )
    .run(now)
  if (result.changes > 0) {
    getDb()
      .prepare(
        `UPDATE autonomous_tasks
         SET last_status = 'failed',
             last_error = '应用重启，上一轮自主运行已中断',
             updated_at = ?
         WHERE last_status = 'running'`
      )
      .run(now)
  }
  return result.changes
}

export function countRunsToday(taskId: string): number {
  const start = new Date()
  start.setHours(0, 0, 0, 0)
  const row = getDb()
    .prepare(
      `SELECT COUNT(*) AS n FROM autonomous_runs
       WHERE task_id = ? AND started_at >= ?`
    )
    .get(taskId, start.getTime()) as { n: number }
  return row.n
}

export function listLessons(options?: {
  projectPath?: string | null
  limit?: number
}): Lesson[] {
  const limit = Math.max(1, Math.min(200, Math.floor(options?.limit ?? 100)))
  const projectPath = options?.projectPath?.trim()
  const rows = projectPath
    ? (getDb()
        .prepare(
          `SELECT * FROM lessons
           WHERE scope = 'global' OR (scope = 'project' AND project_path = ?)
           ORDER BY confidence DESC, updated_at DESC LIMIT ?`
        )
        .all(projectPath, limit) as LessonRow[])
    : (getDb()
        .prepare('SELECT * FROM lessons ORDER BY confidence DESC, updated_at DESC LIMIT ?')
        .all(limit) as LessonRow[])
  return rows.map(toLesson)
}

export function upsertLesson(input: {
  id?: string
  scope?: 'global' | 'project'
  projectPath?: string | null
  title: string
  content: string
  sourceTaskId?: string | null
  sourceRunId?: string | null
  confidence?: number
}): Lesson {
  const now = Date.now()
  const id = input.id ?? randomUUID()
  const current = input.id
    ? (getDb().prepare('SELECT * FROM lessons WHERE id = ?').get(input.id) as LessonRow | undefined)
    : undefined
  const scope = input.scope ?? (current?.scope === 'project' ? 'project' : 'global')
  const row: LessonRow = {
    id,
    scope,
    project_path: scope === 'project' ? (input.projectPath ?? current?.project_path ?? null) : null,
    title: input.title.trim(),
    content: input.content.trim(),
    source_task_id: input.sourceTaskId ?? current?.source_task_id ?? null,
    source_run_id: input.sourceRunId ?? current?.source_run_id ?? null,
    confidence: Math.max(0, Math.min(1, input.confidence ?? current?.confidence ?? 0.6)),
    use_count: current?.use_count ?? 0,
    last_used_at: current?.last_used_at ?? null,
    created_at: current?.created_at ?? now,
    updated_at: now
  }
  getDb()
    .prepare(
      `INSERT INTO lessons
         (id, scope, project_path, title, content, source_task_id, source_run_id,
          confidence, use_count, last_used_at, created_at, updated_at)
       VALUES
         (@id, @scope, @projectPath, @title, @content, @sourceTaskId, @sourceRunId,
          @confidence, @useCount, @lastUsedAt, @createdAt, @updatedAt)
       ON CONFLICT(id) DO UPDATE SET
         scope = excluded.scope,
         project_path = excluded.project_path,
         title = excluded.title,
         content = excluded.content,
         source_task_id = excluded.source_task_id,
         source_run_id = excluded.source_run_id,
         confidence = excluded.confidence,
         updated_at = excluded.updated_at`
    )
    .run({
      id: row.id,
      scope: row.scope,
      projectPath: row.project_path,
      title: row.title,
      content: row.content,
      sourceTaskId: row.source_task_id,
      sourceRunId: row.source_run_id,
      confidence: row.confidence,
      useCount: row.use_count,
      lastUsedAt: row.last_used_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at
    })
  return toLesson(
    getDb().prepare('SELECT * FROM lessons WHERE id = ?').get(id) as LessonRow
  )
}

export function deleteLesson(id: string): void {
  getDb().prepare('DELETE FROM lessons WHERE id = ?').run(id)
}

export function markLessonsUsed(ids: string[]): void {
  if (ids.length === 0) return
  const now = Date.now()
  const stmt = getDb().prepare(
    'UPDATE lessons SET use_count = use_count + 1, last_used_at = ?, updated_at = ? WHERE id = ?'
  )
  getDb().transaction(() => {
    for (const id of ids) stmt.run(now, now, id)
  })()
}

export function lessonForTask(taskId: string): Lesson | null {
  const row = getDb()
    .prepare('SELECT * FROM lessons WHERE source_task_id = ? ORDER BY updated_at DESC LIMIT 1')
    .get(taskId) as LessonRow | undefined
  return row ? toLesson(row) : null
}
