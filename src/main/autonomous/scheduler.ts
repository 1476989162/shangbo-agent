import { exec } from 'node:child_process'
import { existsSync } from 'node:fs'
import { promisify } from 'node:util'
import { Notification } from 'electron'
import log from 'electron-log/main'
import * as repo from '../db/repo'
import * as store from './store'
import { agentRuntime } from '../agent/runtime'
import { eventBus } from '../events/bus'
import { getSetting } from '../settings'
import { resolveWishPrompt } from '../agent/wish'
import { auditCommandSecurity, commandTouchesPrivateData } from '../tools'
import type { AgentEvent, AutonomousTask, AutonomousTaskInput } from '../../shared/types'

const execAsync = promisify(exec)

/**
 * 自主任务调度器。
 *
 * 它只负责“什么时候发起任务”，执行仍然走 AgentRuntime 的正常队列，
 * 因此停止、审批、审计与消息树都不会出现第二套旁路。
 */
class AutonomousScheduler {
  private timer: ReturnType<typeof setInterval> | null = null
  private activeTasks = new Set<string>()
  private activeRuns = new Map<string, { taskId: string; runRecordId: string; conversationId: string }>()
  /** 已经进入验收阶段的会话：防止 message_done 与后续事件重复触发验收。 */
  private verifyingConversations = new Set<string>()
  private paused = false

  start(): void {
    if (this.timer) return
    this.paused = false
    eventBus.subscribe((event) => this.observe(event))
    // 每 15 秒检查一次：分钟级周期足够精确，又不会频繁扫库。
    this.timer = setInterval(() => void this.tick(), 15_000)
    // 启动后先等 8 秒，避开首屏与供应商初始化。
    setTimeout(() => void this.tick(), 8_000)
    log.info('[autonomous] 调度器已启动')
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    log.info('[autonomous] 调度器已停止')
  }

  /** 全局暂停：保留任务定义，只停止继续发起。 */
  pause(): void {
    this.paused = true
  }

  resume(): void {
    this.paused = false
  }

  isPaused(): boolean {
    return this.paused
  }

  list(): AutonomousTask[] {
    return store.listTasks()
  }

  save(input: AutonomousTaskInput): AutonomousTask {
    return store.upsertTask(input)
  }

  remove(id: string): void {
    this.stopTask(id)
    store.deleteTask(id)
  }

  setEnabled(id: string, enabled: boolean): AutonomousTask | null {
    const task = store.setTaskEnabled(id, enabled)
    if (!enabled) this.stopTask(id)
    return task
  }

  /** 新增/修改/启用任务后立即补一次到期检查，不必等下一个 15 秒轮询。 */
  kick(): void {
    void this.tick()
  }

  /** 手动立即执行：不改变周期，只把这一次加入运行中集合。 */
  async runNow(id: string): Promise<{ runRecordId: string; conversationId: string }> {
    const task = store.getTask(id)
    if (!task) throw new Error('自主任务不存在')
    if (this.activeTasks.has(id)) throw new Error('该任务正在执行，请等待本次完成')
    // 手动执行是用户显式操作，不参与周期任务的 next_run_at 抢占；
    // activeTasks 已同步占位，调度 tick 不会再领取同一任务。
    this.activeTasks.add(id)
    store.resetTaskForManualRun(id)
    try {
      return await this.launch(task)
    } catch (error) {
      this.activeTasks.delete(id)
      throw error
    }
  }

  stopTask(id: string): void {
    for (const [conversationId, active] of [...this.activeRuns]) {
      if (active.taskId === id) {
        agentRuntime.abortConversationRuns(conversationId)
        this.activeRuns.delete(conversationId)
        this.verifyingConversations.delete(conversationId)
      }
    }
    this.activeTasks.delete(id)
  }

  private async tick(): Promise<void> {
    if (this.paused || !getSetting<boolean>('agent.autonomous.enabled', false)) return
    // 不 await 单个任务：一个长任务会阻塞后面所有到期任务的启动。
    for (const task of store.dueTasks()) {
      if (this.activeTasks.has(task.id)) continue
      const nextRunAt = store.computeNextRunAt(task.schedule, task.intervalMinutes)
      if (!store.claimTask(task.id, task.nextRunAt, nextRunAt)) continue
      void this.launch(task).catch((error) => {
        const message = error instanceof Error ? error.message : String(error)
        this.activeTasks.delete(task.id)
        log.warn(`[autonomous] 任务 ${task.name} 启动失败：${message}`)
        store.markTaskFinished(
          task.id,
          'failed',
          message,
          store.computeNextRunAt(task.schedule, task.intervalMinutes)
        )
      })
    }
  }

  private async launch(
    task: AutonomousTask
  ): Promise<{ runRecordId: string; conversationId: string }> {
    if (!getSetting<boolean>('agent.wish.enabled', true)) {
      throw new Error('许愿模式未启用，请先在设置中开启')
    }
    if (!task.prompt.trim()) throw new Error('任务目标为空')
    if (!existsSync(task.workingDir)) throw new Error(`工作目录不存在：${task.workingDir}`)
    const todayCount = store.countRunsToday(task.id)
    if (todayCount >= task.maxRunsPerDay) {
      store.markTaskFinished(
        task.id,
        'skipped',
        `今日运行次数已达上限（${task.maxRunsPerDay}）`,
        store.computeNextRunAt(task.schedule, task.intervalMinutes)
      )
      throw new Error(`今日运行次数已达上限（${task.maxRunsPerDay}）`)
    }

    this.activeTasks.add(task.id)
    const runRecord = store.createRun({
      taskId: task.id,
      conversationId: task.conversationId
    })
    store.markTaskStarted(task.id, Date.now())

    let conversation = task.conversationId ? repo.getConversation(task.conversationId) : null
    if (!conversation) {
      conversation = repo.createConversation({
        title: `自主 · ${task.name}`,
        workingDir: task.workingDir,
        mode: 'wish'
      })
      store.attachConversation(task.id, conversation.id)
    } else if (!conversation.mode) {
      repo.updateConversation(conversation.id, { mode: 'wish' })
    }
    store.updateRun(runRecord.id, { conversationId: conversation.id })

    const conversationId = conversation.id
    this.activeRuns.set(conversationId, {
      taskId: task.id,
      runRecordId: runRecord.id,
      conversationId
    })

    const prompt = resolveWishPrompt({
      task,
      lessons: store.listLessons({ projectPath: task.workingDir, limit: 12 })
    })
    const emit = agentRuntime.withBus(() => {})
    try {
      const { runId } = agentRuntime.send(
        {
          conversationId,
          parentMessageId: null,
          content: prompt
        },
        emit
      )
      store.updateRun(runRecord.id, { runId })
      // 立即记录 runId → 会话映射，后续 run_end 才能找到对应任务。
      this.activeRuns.set(conversationId, {
        taskId: task.id,
        runRecordId: runRecord.id,
        conversationId
      })
      this.notify(`自主任务已启动：${task.name}`, '尚搏 Agent 正在许愿模式下执行')
    } catch (error) {
      this.activeTasks.delete(task.id)
      this.activeRuns.delete(conversationId)
      const message = error instanceof Error ? error.message : String(error)
      store.updateRun(runRecord.id, {
        status: 'failed',
        error: message,
        finishedAt: Date.now()
      })
      store.markTaskFinished(
        task.id,
        'failed',
        message,
        store.computeNextRunAt(task.schedule, task.intervalMinutes)
      )
      throw error
    }
    return { runRecordId: runRecord.id, conversationId }
  }

  /**
   * 订阅运行时事件：等整轮 run_end 再验收，而不是 message_done。
   * message_done 只代表某条助手消息结束，队列里仍可能有后续修复消息。
   */
  private observe(event: AgentEvent): void {
    if (event.type !== 'message_done' && event.type !== 'run_error' && event.type !== 'run_end') return
    const active = this.activeRuns.get(event.conversationId)
    if (!active) return
    if (event.type === 'message_done') return
    if (event.type === 'run_error') {
      this.finishFailure(active, event.error)
      return
    }
    if (event.type === 'run_end' && event.queued === 0) {
      void this.verify(active.taskId, active.runRecordId, active.conversationId)
    }
  }

  private async verify(taskId: string, runRecordId: string, conversationId: string): Promise<void> {
    if (this.verifyingConversations.has(conversationId)) return
    this.verifyingConversations.add(conversationId)
    const task = store.getTask(taskId)
    if (!task) {
      this.verifyingConversations.delete(conversationId)
      return
    }
    store.updateRun(runRecordId, { status: 'verifying' })
    const result = await runVerification(task)
    if (result.ok) {
      this.verifyingConversations.delete(conversationId)
      if (getSetting<boolean>('agent.wish.evolve', true)) {
        const lesson = this.extractLesson(task, result.output)
      if (lesson) store.upsertLesson(lesson)
      }
      this.finishSuccess(taskId, runRecordId, conversationId, result.output)
      return
    }
    const run = store.getRun(runRecordId)
    const attempts = (run?.summary.match(/验收失败（第 \d+ 次）/g)?.length ?? 0) + 1
    if (attempts <= task.maxVerifyAttempts) {
      // 本轮验收失败后继续自动修复：任务保持 active，不能被当成已结束。
      this.activeTasks.add(taskId)
      store.updateRun(runRecordId, {
        summary: `${run?.summary ?? ''}\n验收失败（第 ${attempts} 次）：\n${result.output}`.trim()
      })
      const retryPrompt = resolveWishPrompt({
        task,
        lessons: store.listLessons({ projectPath: task.workingDir, limit: 12 }),
        retry: {
          attempt: attempts,
          output: result.output
        }
      })
      try {
        const { runId } = agentRuntime.send(
          { conversationId, parentMessageId: null, content: retryPrompt },
          agentRuntime.withBus(() => {})
        )
        store.updateRun(runRecordId, { runId, status: 'running' })
        this.activeRuns.set(conversationId, { taskId, runRecordId, conversationId })
      } catch (error) {
        this.finishFailure(
          { taskId, runRecordId, conversationId },
          error instanceof Error ? error.message : String(error)
        )
      }
      this.verifyingConversations.delete(conversationId)
      return
    }
    this.verifyingConversations.delete(conversationId)
    this.finishFailure(
      { taskId, runRecordId, conversationId },
      `验收连续失败，已用完 ${task.maxVerifyAttempts} 次自动修复机会。\n${result.output}`
    )
  }

  private finishSuccess(
    taskId: string,
    runRecordId: string,
    conversationId: string,
    summary: string
  ): void {
    const task = store.getTask(taskId)
    this.activeRuns.delete(conversationId)
    this.activeTasks.delete(taskId)
    this.verifyingConversations.delete(conversationId)
    store.updateRun(runRecordId, {
      status: 'success',
      summary: summary.slice(0, 20_000),
      finishedAt: Date.now()
    })
    if (task) {
      store.markTaskFinished(
        taskId,
        'success',
        null,
        store.computeNextRunAt(task.schedule, task.intervalMinutes)
      )
      this.notify(`许愿完成：${task.name}`, '验收已通过，结果已写回会话')
    }
  }

  private finishFailure(
    active: { taskId: string; runRecordId: string; conversationId: string },
    error: string
  ): void {
    const task = store.getTask(active.taskId)
    this.activeRuns.delete(active.conversationId)
    this.activeTasks.delete(active.taskId)
    this.verifyingConversations.delete(active.conversationId)
    store.updateRun(active.runRecordId, {
      status: 'failed',
      error: error.slice(0, 20_000),
      finishedAt: Date.now()
    })
    if (task) {
      store.markTaskFinished(
        active.taskId,
        'failed',
        error.slice(0, 4000),
        store.computeNextRunAt(task.schedule, task.intervalMinutes)
      )
      this.notify(`许愿失败：${task.name}`, error.slice(0, 160))
    }
  }

  /**
   * 经验只从“通过验收”的任务里抽取，避免把失败路径当规范固化。
   * 内容由确定性模板生成，不让模型自行写入经验库，避免自我提示污染。
   */
  private extractLesson(
    task: AutonomousTask,
    verifyOutput: string
  ): {
    scope: 'project'
    projectPath: string
    title: string
    content: string
    sourceTaskId: string
    confidence: number
  } | null {
    const acceptance = task.acceptance.trim()
    const verify = task.verifyCommand.trim()
    if (!acceptance && !verify) return null
    const lines = [
      `任务：${task.name}`,
      acceptance ? `验收标准：${acceptance}` : '',
      verify ? `验收命令：${verify}` : '',
      `最近一次验收输出：${verifyOutput.slice(0, 1200)}`
    ].filter(Boolean)
    return {
      scope: 'project',
      projectPath: task.workingDir,
      title: `已完成：${task.name}`,
      content: lines.join('\n'),
      sourceTaskId: task.id,
      confidence: 0.75
    }
  }

  private notify(title: string, body: string): void {
    if (!getSetting<boolean>('agent.notifyCompletion', true)) return
    try {
      if (Notification.isSupported()) new Notification({ title, body }).show()
    } catch {
      // 通知失败不影响任务
    }
  }
}

export interface VerificationResult {
  ok: boolean
  output: string
}

/**
 * 验收必须由主进程执行，而不是相信模型自称“已完成”。
 * 无验收命令时退化为检查本轮确实产生了工具调用或文件改动，至少防止空转假完成。
 */
export async function runVerification(task: AutonomousTask): Promise<VerificationResult> {
  if (!getSetting<boolean>('agent.wish.autoVerify', true)) {
    return {
      ok: true,
      output: '自动验收已在设置中关闭，本轮未执行外部验收命令。'
    }
  }
  if (!task.verifyCommand.trim()) {
    return {
      ok: true,
      output: '未配置自动验收命令，本轮以模型自检结果为准。建议在任务中填写测试/构建命令。'
    }
  }
  // 验收命令来自设置/任务定义，仍按不可信输入处理：
  // 不允许通过验收脚本绕回密钥库或执行擦盘/格式化。
  if (commandTouchesPrivateData(task.verifyCommand, task.workingDir)) {
    return { ok: false, output: '验收命令触碰应用私有数据，已拒绝执行。' }
  }
  const audit = auditCommandSecurity(task.verifyCommand)
  if (audit.isDangerous) {
    return {
      ok: false,
      output: `验收命令被安全护栏拒绝：${audit.reason ?? '检测到高危系统操作'}`
    }
  }
  try {
    const { stdout, stderr } = await execAsync(task.verifyCommand, {
      cwd: task.workingDir,
      timeout: 10 * 60_000,
      maxBuffer: 8 * 1024 * 1024,
      windowsHide: true
    })
    return {
      ok: true,
      output: `$ ${task.verifyCommand}\n${stdout.trim()}${stderr.trim() ? `\n--- 标准错误 ---\n${stderr.trim()}` : ''}`.trim()
    }
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number; message?: string }
    return {
      ok: false,
      output: [
        `$ ${task.verifyCommand}`,
        `验收命令失败（退出码 ${failure.code ?? '未知'}）`,
        failure.stdout?.trim() ?? '',
        failure.stderr?.trim() ?? '',
        failure.message ?? ''
      ]
        .filter(Boolean)
        .join('\n')
        .slice(0, 20_000)
    }
  }
}

export const autonomousScheduler = new AutonomousScheduler()
