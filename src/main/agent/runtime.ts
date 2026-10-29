import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import log from 'electron-log/main'
import * as repo from '../db/repo'
import { getSetting } from '../settings'
import { auditCommandSecurity, toolRegistry } from '../tools'
import { clearTodoItems, getTodoItems } from '../tools/todo'
import { eventBus, type EventSubscriber } from '../events/bus'
import { resolveFirstByteTimeoutMs, streamWithFallback } from '../providers/gateway'
import {
  clampSummary,
  estimateTokens,
} from './context'
import { resolveEffort } from './effort'
import { runSubagent, SPAWN_SUBAGENT_SCHEMA, SPAWN_TOOL_NAME } from './subagent'
import { mcpManager, parseMcpToolName } from '../mcp/manager'
import { deleteImageFile } from '../storage/images'
import type {
  AgentEvent,
  AgentMode,
  AgentSendRequest,
  ApprovalDecision,
  AutonomyLevel,
  ContentBlock,
  ContextStatics,
  Conversation,
  ConversationRuntimeState,
  Message,
  MessageStatus,
  Usage
} from '../../shared/types'
import {
  commandStaysInsideWorkspace
} from './commandGuard'
import { ApprovalBroker, type PendingApprovalSnapshot } from './approvals'
import { isWishAutoApproved, isWishMcpAutoApproved, isWishModeActive, resolveAgentMode } from './wishMode'
import { classifyIntent } from './intent'
import { classifyToolCall, isAutoAllowed } from './safety'
import { runAgentLoop } from './agentLoop'
import type { ToolOutcome } from './toolOutcome'
import {
  DEFAULT_SYSTEM_PROMPT,
  describeError,
  resolveTarget
} from './modelRuntime'

// 保持原有导出路径：wish.test.ts 等既有调用方无需改动
export { commandStaysInsideWorkspace } from './commandGuard'
export type { PendingApprovalSnapshot } from './approvals'

export type Emitter = (event: AgentEvent) => void

const execFileAsync = promisify(execFile)

interface ActiveRun {
  controller: AbortController
  conversationId: string
  /** 看门狗：abort 后若执行体 hang 住不返回，超时强制收尾发 run_end，界面不再永久"正在跑"。 */
  watchdog: ReturnType<typeof setTimeout> | null
  emit: Emitter
  runId: string
}

/**
 * 停止看门狗时长：abort 后执行体最长等待时间。
 * run_command 默认 60s 超时、MCP 10s 超时、网关重试退避最长约 60s，
 * 取 90s 覆盖"正常收尾"的全部路径；真 hang（如子进程无视 signal）才触发强制收尾。
 */
export const ABORT_WATCHDOG_MS = 90_000

/** 队列里待跑的一轮。emit 必须与当初提交时的那份一致，才能把事件广播到正确窗口。 */
interface QueuedRun {
  runId: string
  conversationId: string
  emit: Emitter
  /** 这轮对应的用户消息 id：排队期间用于编辑、删除与重新定位。 */
  userMessageId: string
  /** 原始发送请求，编辑内容时据此重放。 */
  payload: AgentSendRequest
  /** 执行体。接收队列项自身，以便读到编辑后的最新 payload。 */
  start: (self: QueuedRun) => Promise<void>
}

export class AgentRuntime {
  private runs = new Map<string, ActiveRun>()
  private approvalBroker = new ApprovalBroker()
  /** 会话 id → 该会话的等待队列。同一会话严格串行，不同会话互不阻塞。 */
  private queues = new Map<string, QueuedRun[]>()
  /** 会话 id → 中途指导（steer）：排队消息转指导后暂存，主循环每轮开跑前取走拼进系统提示。 */
  private steeringNotes = new Map<string, string[]>()
  /**
   * runId → 本轮实际生效的模式。
   * auto 模式的判定发生在回合开始，工具审批必须复用同一个结果，
   * 否则会出现「提示词按许愿跑、审批却按建造者拦」的分裂。
   */
  private runModes = new Map<string, AgentMode>()

  /**
   * 会话 id → 正在流式输出的助手消息的实时内容块。
   *
   * 流式正文只在工具批次边界落库（agentLoop 的阶段性 updateMessage），
   * 中途 DB 里可能是空的。切走再切回时若只读 DB，就会看到「还在跑但没内容」。
   * 这里在主进程内存里维护权威副本，运行态快照直接下发它。
   */
  private liveBlocks = new Map<string, { messageId: string; blocks: ContentBlock[] }>()

  /**
   * 事件总线订阅（阶段1/阶段3共用）。
   * AgentRuntime 内部不再直接依赖 IPC：每次 emit 都经过 withBus 包装，
   * 自动 publish 到总线，桌面窗口与远程模块各自订阅。
   */
  subscribe(fn: EventSubscriber): () => void {
    return eventBus.subscribe(fn)
  }

  /** 把闭包 emit 包装成“原样调用 + 同步 publish 到总线”。 */
  withBus(emit: Emitter): Emitter {
    return (event) => {
      try {
        emit(event)
      } finally {
        eventBus.publish(event)
      }
    }
  }

  /**
   * 包一层实时内容跟踪。
   *
   * 跟踪放在这里而不是 withBus 里：withBus 只覆盖「经总线广播」的生产接线，
   * 单元测试与内部直连（autonomous 等）传的是裸 emit，只有在这里包才能全覆盖。
   * 也正因为要唯一跟踪点，withBus 里刻意不做同样的事，否则正文会被追加两次。
   */
  private trackedEmit(emit: Emitter): Emitter {
    return (event) => {
      this.trackLiveBlocks(event)
      emit(event)
    }
  }

  /** 累积本轮实时内容块；与 agentLoop 的 appendBlock 同语义（相邻同类块合并）。 */
  private trackLiveBlocks(event: AgentEvent): void {
    switch (event.type) {
      case 'run_start': {
        this.liveBlocks.set(event.conversationId, {
          messageId: event.assistantMessageId,
          blocks: []
        })
        return
      }
      case 'text_delta':
      case 'reasoning_delta': {
        const live = this.liveBlocks.get(event.conversationId)
        if (!live || live.messageId !== event.messageId) return
        const last = live.blocks[live.blocks.length - 1]
        if (event.type === 'text_delta') {
          if (last?.type === 'text') last.text += event.text
          else live.blocks.push({ type: 'text', text: event.text })
        } else {
          if (last?.type === 'reasoning') last.text += event.text
          else live.blocks.push({ type: 'reasoning', text: event.text })
        }
        return
      }
      case 'tool_use': {
        const live = this.liveBlocks.get(event.conversationId)
        if (!live || live.messageId !== event.messageId) return
        live.blocks.push({
          type: 'tool_use',
          id: event.toolUseId,
          name: event.name,
          input: event.input
        })
        return
      }
      case 'tool_result': {
        const live = this.liveBlocks.get(event.conversationId)
        if (!live || live.messageId !== event.messageId) return
        live.blocks.push({
          type: 'tool_result',
          toolUseId: event.toolUseId,
          content: event.content,
          isError: event.isError
        })
        return
      }
      case 'message_done':
      case 'run_error':
      case 'run_end': {
        // 本轮收尾：实时副本已落库，内存副本没有保留价值
        this.liveBlocks.delete(event.conversationId)
        return
      }
    }
  }

  /**
   * 统一的生命周期包装：失败发 run_error，结束必发 run_end。
   * 收尾顺序很关键：先把自己从 runs 里摘掉，再推进队列。
   * 反过来的话 isRunning 仍为 true，队列里的下一轮会被当成「排队」塞回去，
   * 永远起不来——同会话第二条消息就再也不会被回复。
   */
  private async execute(
    runId: string,
    conversationId: string,
    emit: Emitter,
    task: () => Promise<void>
  ): Promise<void> {
    try {
      await task()
    } catch (error) {
      log.error('[agent] 回合失败', error)
      emit({ type: 'run_error', runId, conversationId, messageId: '', error: describeError(error) })
    } finally {
      this.finishRun(runId, conversationId, emit)
    }
  }

  /**
   * 收尾一轮：清看门狗、从 runs 摘掉、推进队列、发 run_end。
   * 看门狗触发的强制收尾与正常收尾共用，保证只发一次 run_end。
   */
  private finishRun(runId: string, conversationId: string, emit: Emitter): void {
    const active = this.runs.get(runId)
    if (active?.watchdog) clearTimeout(active.watchdog)
    if (!this.runs.has(runId)) {
      this.runModes.delete(runId)
      return
    }
    this.runs.delete(runId)
    this.runModes.delete(runId)
    clearTodoItems(runId)
    // 推进队列前先记下还剩几项，这样 run_end 里的 queued 是「不含本轮」的准确值
    const queued = this.queueLength(conversationId)
    this.advanceQueue(conversationId)
    emit({ type: 'run_end', runId, conversationId, queued })
  }

  /**
   * 把一轮交给队列：会话空闲就立刻开跑，否则排在队尾等前面的结束。
   * runId 同步返回——调用方（含渲染层）据此知道「这条已经接收」，不必等它真的开始。
   *
   * queuedContext 非空表示这次是「排队」而非「开跑」：调用方需要先发一条
   * run_queued 让 UI 看到这条消息处于等待状态。
   */
  private enqueue(
    item: QueuedRun,
    queuedContext?: { userMessage: Message } | null
  ): { runId: string } {
    const queue = this.queues.get(item.conversationId) ?? []
    queue.push(item)
    this.queues.set(item.conversationId, queue)

    if (this.isRunning(item.conversationId)) {
      if (queuedContext) {
        item.emit({
          type: 'run_queued',
          runId: item.runId,
          conversationId: item.conversationId,
          userMessageId: queuedContext.userMessage.id,
          // 前面有 1 个正在跑 + queue 里已有的项
          position: queue.length,
          userMessage: queuedContext.userMessage
        })
      }
      return { runId: item.runId }
    }

    this.startRun(queue.shift() as QueuedRun)
    return { runId: item.runId }
  }

  /** 真正启动一轮：登记占用、在微任务里执行，结束后让出执行权。 */
  private startRun(item: QueuedRun): void {
    // 在这里包跟踪，保证无论调用方怎么构造 emit，实时内容都被记下来
    item.emit = this.trackedEmit(item.emit)
    this.runs.set(item.runId, {
      controller: new AbortController(),
      conversationId: item.conversationId,
      watchdog: null,
      emit: item.emit,
      runId: item.runId
    })
    // 放到微任务里，确保调用方先拿到 runId 再收到事件
    queueMicrotask(() => {
      void this.execute(item.runId, item.conversationId, item.emit, () => item.start(item))
    })
  }

  /**
   * 上一轮结束，推进队列里的下一轮。
   *
   * 必须在 runs 里把上一轮摘掉之后再调用：否则 isRunning 仍为 true，
   * 下一轮会被误判成「排队」重新塞回去，永远起不来（死锁）。
   */
  private advanceQueue(conversationId: string): void {
    const queue = this.queues.get(conversationId)
    if (!queue || queue.length === 0) {
      this.queues.delete(conversationId)
      return
    }
    this.startRun(queue.shift() as QueuedRun)
  }

  /**
   * 测量每轮请求的静态开销（不含会话消息），供渲染层的上下文浮层显示。
   *
   * 刻意用真实序列化结果而不是写死的常量：常量会随工具集、MCP 配置、
   * 系统提示的演进而失真，曾导致浮层出现「Messages 162.8% + 剩余 0」
   * 这种分项加起来超过 100% 的自相矛盾显示。
   */
  async contextStatics(): Promise<ContextStatics> {
    const computerOn = getSetting<boolean>('agent.computerUse', true)
    const systemTools = toolRegistry
      .schemas({ readOnly: false })
      .filter((t) => computerOn || !t.name.startsWith('computer_'))
    const mcpTools = await mcpManager.toolSchemas()

    const baseSystem = DEFAULT_SYSTEM_PROMPT
    const custom = getSetting<string>('agent.instructions', '')

    return {
      // 工具 schema 以 JSON 形式进请求体，按字符估算（CJK 约 1 token/字）
      systemTools: estimateTokens(JSON.stringify([...systemTools, SPAWN_SUBAGENT_SCHEMA])),
      mcp: estimateTokens(JSON.stringify(mcpTools)),
      systemPrompt: estimateTokens(custom ? `${baseSystem}\n\n${custom}` : baseSystem),
      // Skills 与记忆文件当前没有接入请求，这里如实计 0 而不是编一个数
      skills: 0,
      memory: 0
    }
  }

  /** 该会话是否还有排队中的轮次（含正在跑的）。渲染层据此显示「排队中 N」。 */
  queueLength(conversationId: string): number {
    return this.queues.get(conversationId)?.length ?? 0
  }

  /**
   * 发起一次新的对话回合。立即返回 runId，实际执行在微任务中进行。
   *
   * 用户消息在这里就落库（而不是等到真正开跑），否则排队期间 UI 上看不到
   * 自己发了什么。落库后：
   *   - 会话空闲 → 发 run_start，UI 立刻看到流式输出
   *   - 会话在跑 → 发 run_queued，UI 显示「排队中」
   */
  send(payload: AgentSendRequest, emit: Emitter): { runId: string } {
    const busy = this.isRunning(payload.conversationId)
    // 忙时延迟抢叶子：B 落库 parent 照常挂当时叶子（UI 能显示在队尾），
    // 但不立即抢 activeLeaf，开跑时再按当时叶子修正挂载。空闲时走老路径。
    const userMessage = this.persistUserMessage(payload, busy)
    const runId = randomUUID()

    return this.enqueue({
      runId,
      conversationId: payload.conversationId,
      userMessageId: userMessage.id,
      payload,
      emit,
      start: async (self) => {
        const controller = this.runs.get(runId)?.controller ?? new AbortController()
        // 延迟挂载的排队项在这里修正历史挂载点：挂到开跑时刻的叶子下，
        // 再把叶子推到自己，保证 B 能看到 A_assistant，且 A 不会读到未回答的 B
        this.anchorQueuedItem(self)
        // 读 self.payload 而非闭包捕获的入参：编辑排队消息改的是队列项，
        // 捕获入参会让编辑完全不生效
        const fresh = repo.getMessage(self.userMessageId) ?? userMessage
        // 用 self.emit 而不是外层捕获的 emit：startRun 会给它包一层实时内容跟踪
        await this.executeSend(runId, self.payload, fresh, self.emit, controller)
      }
    }, busy ? { userMessage } : null)  }

  /**
   * 重新生成：为同一条用户消息再挂一个助手兄弟节点，形成新的分支。
   * 与 send 一样进入队列：回复还在跑时重生成不会打断它，而是排在其后。
   */
  regenerate(assistantMessageId: string, emit: Emitter): { runId: string } {
    const assistantMessage = repo.getMessage(assistantMessageId)
    if (!assistantMessage || !assistantMessage.parentId) {
      throw new Error('无法重新生成：找不到对应的用户消息')
    }
    const conversationId = assistantMessage.conversationId
    const userMessage = repo.getMessage(assistantMessage.parentId)
    if (!userMessage) throw new Error('无法重新生成：找不到对应的用户消息')
    const userMessageId = userMessage.id

    const runId = randomUUID()
    return this.enqueue(
      {
        runId,
        conversationId,
        userMessageId,
      // 重新生成复用已落库的用户消息，这里给一份仅用于取消定位的 payload
      payload: {
        conversationId,
        parentMessageId: userMessage.parentId,
        content: userMessage.blocks.find((b) => b.type === 'text')?.text ?? ''
      },
      emit,
      start: async (self) => {
        const controller = this.runs.get(runId)?.controller ?? new AbortController()
        const conversation = repo.getConversation(conversationId)
        if (!conversation) throw new Error('会话不存在或已被删除')
        // 把激活叶子退回该用户消息，让新回复成为新分支
        repo.setActiveLeaf(conversationId, userMessageId)
        await this.runModel(
          runId,
          conversation,
          userMessage,
          { providerId: assistantMessage.providerId, model: assistantMessage.model },
          // 同 send：用队列项的 emit，才能带上实时内容跟踪
          self.emit,
          controller
        )
      }
      },
      // 与 send 一致：忙时发出 run_queued 让 UI 看到排队状态，空闲时直接开跑
      this.isRunning(conversationId) ? { userMessage } : null
    )
  }

  /**
   * 停止一轮：中断执行 + 启动看门狗。
   * 以往只 abort controller，执行体 hang 住（如子进程无视 signal、流式卡住）
   * 时界面永久"正在跑"，只能退软件。看门狗 90s 后强制收尾发 run_end。
   */
  abort(runId: string): void {
    const active = this.runs.get(runId)
    if (!active) return
    active.controller.abort()
    this.armWatchdog(active)
  }

  /**
   * 停止整个会话：中断正在跑的那一轮 + 清空该会话全部排队项。
   * 用户点"停止"时期望的是"彻底停下"，而不是停完本轮自动接力下一条——
   * 后者看起来就像"卡死且停不掉"。被清掉的排队消息保留在库中（标记为 aborted），
   * 用户可重新发送；如需撤回用 cancelQueuedMessage。
   */
  abortConversationRuns(conversationId: string): { abortedRun: string | null; clearedQueued: number } {
    let abortedRun: string | null = null
    for (const [runId, run] of [...this.runs]) {
      if (run.conversationId === conversationId) {
        abortedRun = runId
        run.controller.abort()
        this.armWatchdog(run)
      }
    }
    const queue = this.queues.get(conversationId)
    const clearedQueued = queue?.length ?? 0
    if (queue) {
      // 排队项按 aborted 标记落库，界面显示"已取消"而非凭空消失
      for (const item of queue) {
        try {
          repo.updateMessage(item.userMessageId, { status: 'aborted' })
        } catch {}
      }
      this.queues.delete(conversationId)
    }
    // 挂起的审批按拒绝处理，避免弹窗残留
    this.approvalBroker.rejectConversation(conversationId)
    return { abortedRun, clearedQueued }
  }

  /** 启动某轮的看门狗：超时仍未收尾则强制 finishRun，界面恢复可操作。 */
  private armWatchdog(active: ActiveRun): void {
    if (active.watchdog) return
    active.watchdog = setTimeout(() => {
      if (!this.runs.has(active.runId)) return
      log.warn(`[agent] 停止看门狗触发：${active.runId} 仍未收尾，强制结束`)
      try {
        active.emit({ type: 'run_error', runId: active.runId, conversationId: active.conversationId, messageId: '', error: '任务停止超时，已强制结束（执行体未响应中断信号）。' })
      } finally {
        this.finishRun(active.runId, active.conversationId, active.emit)
      }
    }, ABORT_WATCHDOG_MS)
  }

  /**
   * 指导当前轮：把一条排队消息的内容注入正在跑回合的"指导区"，
   * 该回合下一轮工具循环的系统提示里会带上它，模型能立刻看到。
   * 与"等前面的跑完再问"不同：指导不新开回合、不排队、不打断工具执行，
   * 适合"先别删那个文件""用 pnpm 别用 npm"这类中途纠偏。
   * 返回 false 表示该会话当前没有在跑的回合（此时请走正常发送）。
   */
  steerRunningRound(conversationId: string, userMessageId: string): boolean {
    const running = [...this.runs.values()].find((r) => r.conversationId === conversationId)
    if (!running) return false
    const queue = this.queues.get(conversationId)
    const item = queue?.find((q) => q.userMessageId === userMessageId)
    const message = item ? repo.getMessage(item.userMessageId) : repo.getMessage(userMessageId)
    const text = message?.blocks.find((b) => b.type === 'text')?.text?.trim()
    if (!text) return false
    const guidance = this.steeringNotes.get(conversationId) ?? []
    guidance.push(text)
    this.steeringNotes.set(conversationId, guidance)
    // 排队项已转为指导，从队列摘掉并标记，界面显示"已作为指导送达"
    if (item && queue) {
      queue.splice(queue.indexOf(item), 1)
      if (queue.length === 0) this.queues.delete(conversationId)
      try {
        repo.updateMessage(item.userMessageId, { status: 'done' })
      } catch {}
    }
    running.emit({
      type: 'text_delta',
      runId: running.runId,
      conversationId,
      messageId: '',
      text: `\n\n_（已收到你的中途指导：${text.slice(0, 200)}）_`
    })
    return true
  }

  /** 取出并清空某会话累积的中途指导（主循环每轮开跑前调用）。 */
  takeSteeringNotes(conversationId: string): string[] {
    const notes = this.steeringNotes.get(conversationId) ?? []
    this.steeringNotes.delete(conversationId)
    return notes
  }

  /** 放弃某个会话的全部排队项——会话被删除时调用，避免孤儿任务复活。 */
  /**
   * 取消一条排队中的消息：把它从队列里摘掉，并删除已落库的对应消息及其图片。
   *
   * 只允许取消「尚未开跑」的轮次。已经开始生成的那一条由 abort 负责，
   * 语义不同：abort 是保留历史，这里是撤回一条还没生效的提问。
   * 返回 false 表示这条不在队列里（可能已经开跑，或根本不属于本会话）。
   */
  async cancelQueuedMessage(conversationId: string, userMessageId: string): Promise<boolean> {
    const queue = this.queues.get(conversationId)
    if (!queue) return false

    const index = queue.findIndex((item) => item.userMessageId === userMessageId)
    if (index < 0) return false

    const [removed] = queue.splice(index, 1)
    if (queue.length === 0 && !this.isRunning(conversationId)) {
      this.queues.delete(conversationId)
    }

    // 先摘队列再落库：反过来的话，取消失败会留下一条永远不执行的孤儿任务
    const message = repo.getMessage(removed.userMessageId)
    repo.deleteSubtree(removed.userMessageId)
    // 图片已落盘，撤回时一并清理，避免留下孤儿文件
    for (const block of message?.blocks ?? []) {
      if (block.type === 'image' && block.file) {
        await deleteImageFile(block.file)
      }
    }
    return true
  }

  /**
   * 编辑一条排队中的消息的内容：就地改库，队列项无需重排。
   * 图片暂不支持增删（附件已落盘，换图等于换一条消息），仅替换文本。
   */
  editQueuedMessage(
    conversationId: string,
    userMessageId: string,
    content: string
  ): boolean {
    const queue = this.queues.get(conversationId)
    if (!queue) return false

    const item = queue.find((q) => q.userMessageId === userMessageId)
    if (!item) return false

    const text = content.trim()
    if (!text) return false

    const message = repo.getMessage(userMessageId)
    if (!message) return false

    // 保留图片块，只替换文本块——图片是这条消息的一部分，不该被编辑抹掉
    const images = message.blocks.filter((b) => b.type === 'image')
    repo.updateMessage(userMessageId, {
      blocks: [...images, { type: 'text', text }]
    })

    // 同步更新队列项里的 payload，真正开跑时用的就是这份
    item.payload = { ...item.payload, content: text }
    return true
  }

  clearQueue(conversationId: string): void {
    this.queues.delete(conversationId)
  }

  abortConversation(conversationId: string): void {
    // 会话即将消失（删除），排队的轮次没有存在意义，直接丢弃
    this.clearQueue(conversationId)
    // 该会话挂起的审批按拒绝处理：删会话后弹窗残留 5 分钟，且 decide 可能误放行
    const runIds = new Set<string>()
    for (const [runId, run] of this.runs) {
      if (run.conversationId === conversationId) runIds.add(runId)
    }
    this.approvalBroker.rejectRuns(runIds)
    for (const run of this.runs.values()) {
      if (run.conversationId === conversationId) run.controller.abort()
    }
  }

  isRunning(conversationId: string): boolean {
    for (const run of this.runs.values()) {
      if (run.conversationId === conversationId) return true
    }
    return false
  }

  /** 渲染进程回传的权限确认结果（桌面本地，允许 alwaysAllow）。 */
  decide(decision: ApprovalDecision): void {
    this.approvalBroker.decide(decision)
  }

  /**
   * 带哈希绑定的审批裁决（阶段5：远程审批必须带 paramHash）。
   * - expectedParamHash 为 undefined 时为桌面本地审批，不做哈希校验（兼容现有调用）。
   * - 远程审批必须提供哈希且与创建时一致，否则按拒绝处理（防参数中途被替换）。
   * 返回 true 表示裁决被接受（批准或拒绝均已 settle），false 表示无此审批或哈希不一致。
   */
  decideWithHash(runId: string, toolUseId: string, approved: boolean, expectedParamHash?: string): boolean {
    return this.approvalBroker.decideWithHash(runId, toolUseId, approved, expectedParamHash)
  }

  /** 当前所有待审批清单（手机连上时立刻下发）。 */
  listPendingApprovals(): PendingApprovalSnapshot[] {
    return this.approvalBroker.list()
  }

  /**
   * 某会话的实时运行态快照。
   *
   * 渲染层切换会话时本地状态会被重建，事件流也可能在中途丢失（渲染层重载、
   * 缓冲上限截断）。这份快照直接读主进程内存，是「这一轮到底还在不在跑、
   * 在等哪个审批、任务清单到哪一步」的权威答案，用于切回会话后对账。
   */
  conversationRuntimeState(conversationId: string): ConversationRuntimeState {
    const running = [...this.runs.values()].find((run) => run.conversationId === conversationId)
    const runId = running?.runId ?? null
    const approvals = this.approvalBroker
      .list()
      .filter((item) => item.conversationId === conversationId)
      .map((item) => ({
        runId: item.runId,
        toolUseId: item.toolUseId,
        name: item.toolName,
        input: item.input,
        reason: item.reason,
        severity: item.severity,
        autoApprovable: item.autoApprovable
      }))

    // 没有在跑的回合就不该报 streamingMessageId，否则切回来会挂着一个永远不动的空消息
    const streamingId = runId ? repo.findStreamingAssistantMessageId(conversationId) : null

    return {
      conversationId,
      runId,
      streamingMessageId: streamingId,
      queued: this.queueLength(conversationId),
      todos: runId ? getTodoItems(runId) : [],
      approvals,
      /** 正在流式输出的实时内容（DB 里可能还是空的，切回会话靠它续显）。 */
      liveBlocks:
        streamingId && this.liveBlocks.get(conversationId)?.messageId === streamingId
          ? [...(this.liveBlocks.get(conversationId)?.blocks ?? [])]
          : []
    }
  }

  /** 对工具参数计算稳定哈希（审批绑定用，与手机端 WebCrypto SHA-256 对应）。 */
  static paramHashOf(input: unknown): string {
    return ApprovalBroker.paramHashOf(input)
  }

  /* ---------------------------------------------------------------- */

  /** 落库一条用户消息并返回实体。排队与开跑共用，让 UI 在提交瞬间就能看到这条消息。 */
  private persistUserMessage(payload: AgentSendRequest, deferAnchor = false): Message {
    const conversation = repo.getConversation(payload.conversationId)
    if (!conversation) throw new Error('会话不存在或已被删除')

    let parentId = payload.parentMessageId ?? repo.getActiveLeaf(conversation.id)
    let status: MessageStatus = 'done'
    if (deferAnchor && !payload.parentMessageId) {
      // 排队落库：挂在树上最新一条消息下（A 跑中时是 A_assistant、连排时是上一条排队消息），
      // 而不是当前叶子——B 与 A_assistant 是父子而非兄弟，前端不会多出分支；
      // status 标记为 queued，开跑时恢复，崩溃重启时由启动收敛统一标记为已取消。
      parentId = repo.getLatestMessageId(conversation.id) ?? parentId
      status = 'queued'
    }
    // 图片在文字之前入块：多数模型对"先图后文"的注意力更友好，也与截图提问的直觉一致。
    // 只存 file 路径，base64 不落库。
    const text = payload.content.trim()
    const blocks: ContentBlock[] = [
      ...(payload.images ?? []).map((image) => ({
        type: 'image' as const,
        mimeType: image.mimeType,
        file: image.file
      })),
      ...(text ? [{ type: 'text' as const, text }] : [])
    ]
    const userMessage = repo.insertMessage({
      conversationId: conversation.id,
      parentId,
      role: 'user',
      blocks,
      status,
      usageMode: payload.viewMode ?? null
    })
    // 忙时延迟抢叶子：A 跑中连发 B 时，B 落库不再立即抢 activeLeaf，
    // 否则 A 后续读历史会把还没回答的 B 读进来。真正的挂载在开跑时修正。
    if (!deferAnchor) repo.setActiveLeaf(conversation.id, userMessage.id)

    if (conversation.title === '新对话') {
      // 纯图片消息没有可用标题，退回一句可读占位，避免标题栏空白
      const title =
        text.replace(/\s+/g, ' ').trim().slice(0, 24) ||
        (payload.images?.length ? '[图片]' : '')
      if (title) repo.updateConversation(conversation.id, { title })
    }
    repo.touchConversation(conversation.id)

    return userMessage
  }

  /**
   * 排队项开跑时的历史挂载修正：把该用户消息挂到开跑时刻的叶子下，
   * 再把叶子推到自己。保证 B 开跑时能看到 A_assistant，
   * 且 A 跑中不会读到还没回答的 B（B 在 A 收尾前不在 activeLeaf 链上）。
   * 显式指定 parent 的发送（编辑重发、分支起点）不修正：调用方明确要挂哪。
   */
  private anchorQueuedItem(self: QueuedRun): void {
    // 显式 parent 是调用方的明确意图（编辑重发 parentMessageId、分支起点），不碰
    if (self.payload.parentMessageId) return
    const current = repo.getMessage(self.userMessageId)
    if (!current) return
    // 排队标记恢复：开跑即视为正常消息
    if (current.status === 'queued') repo.updateMessage(self.userMessageId, { status: 'done' })
    const leafId = repo.getActiveLeaf(self.conversationId)
    if (!leafId || leafId === current.id) {
      if (leafId !== current.id) repo.setActiveLeaf(self.conversationId, current.id)
      return
    }
    // 叶子已是别人（通常是上一轮的 assistant）：挂过去再认领
    if (current.parentId !== leafId) repo.reparentMessage(current.id, leafId)
    repo.setActiveLeaf(self.conversationId, current.id)
  }

  private async executeSend(
    runId: string,
    payload: AgentSendRequest,
    userMessage: Message,
    emit: Emitter,
    controller: AbortController
  ): Promise<void> {
    // 会话可能在入队到开跑之间被删除，这时没有存在的必要，直接放弃
    const conversation = repo.getConversation(payload.conversationId)
    if (!conversation) throw new Error('会话不存在或已被删除')

    await this.runModel(
      runId,
      conversation,
      userMessage,
      { providerId: payload.providerId, model: payload.model },
      emit,
      controller
    )
  }

  /**
   * 用当前模型把被裁掉的历史压成 ≤400 字摘要。
   * 失败或用户中断时返回 null：摘要只是优化，不能让它拖垮主回合。
   */
  private async summarizeHistory(
    transcript: string,
    providerId: string,
    signal: AbortSignal
  ): Promise<string | null> {
    try {
      let text = ''
      for await (const chunk of streamWithFallback(
        {
          model: resolveTarget(providerId, null).model,
          system:
            '你是对话摘要器。把下面的历史压成不超过 400 字的中文摘要，保留：用户目标、已确认的事实与约束、已完成与未完成的事项、关键文件与命令。不要编造，不要输出标题。',
          messages: [{ role: 'user', blocks: [{ type: 'text', text: transcript }] }],
          maxTokens: 800,
          temperature: 0
        },
        signal,
        providerId
      )) {
        if (chunk.type === 'text') text += chunk.text
      }
      const clamped = clampSummary(text)
      return clamped || null
    } catch (error) {
      log.warn('[agent] 上下文摘要生成失败，本轮改用裁剪后的原文', error)
      return null
    }
  }

  /**
  /**
   * 「规划 → 调用工具 → 观察 → 再规划」主循环。
   * 主循环体已抽到 agentLoop.ts；这里只注入运行时依赖，保持既有调用路径不变。
   */
  private async runModel(
    runId: string,
    conversation: Pick<Conversation, 'id' | 'systemPrompt' | 'workingDir' | 'mode'>,
    userMessage: Message,
    target: { providerId?: string | null; model?: string | null },
    emit: Emitter,
    controller: AbortController
  ): Promise<void> {
    // 模式判定只做一次：主循环与工具审批共用，避免两边各判一套。
    const triggerText = userMessage.blocks
      .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
      .map((block) => block.text)
      .join('')
    const intent = classifyIntent(triggerText)
    const effectiveMode = resolveAgentMode(
      conversation.mode,
      {
        wishEnabled: getSetting<boolean>('agent.wish.enabled', true),
        autoApproveWorkspace: getSetting<boolean>('agent.wish.autoApproveWorkspace', true),
        defaultMode: getSetting<string>('agent.mode', 'auto')
      },
      intent
    )
    this.runModes.set(runId, effectiveMode)

    await runAgentLoop(
      {
        git: (args, cwd) => this.git(args, cwd),
        summarizeHistory: (transcript, providerId, signal) =>
          this.summarizeHistory(transcript, providerId, signal),
        takeSteeringNotes: (conversationId) => this.takeSteeringNotes(conversationId),
        invokeTool: (
          runId,
          messageId,
          call,
          conversationId,
          workingDirectory,
          emit,
          controller,
          onNotify,
          onUsage
        ) =>
          this.invokeTool(
            runId,
            messageId,
            call,
            conversationId,
            workingDirectory,
            emit,
            controller,
            onNotify,
            onUsage
          ),
        composeUsage: (
          lastUsage,
          turnPromptTokens,
          turnCompletionTokens,
          requestCount,
          finishReason,
          turnCacheReadTokens,
          turnCacheWriteTokens
        ) =>
          this.composeUsage(
            lastUsage,
            turnPromptTokens,
            turnCompletionTokens,
            requestCount,
            finishReason,
            turnCacheReadTokens,
            turnCacheWriteTokens
          )
      },
      runId,
      conversation,
      userMessage,
      target,
      emit,
      controller,
      { effectiveMode, workMode: userMessage.usageMode ?? null }
    )
  }


  /** 组装落库的 usage：末次请求为基准，多步时附上整轮累计与请求数。 */
  private composeUsage(
    lastUsage: Usage | null,
    turnPromptTokens: number,
    turnCompletionTokens: number,
    requestCount: number,
    finishReason?: string,
    turnCacheReadTokens = 0,
    turnCacheWriteTokens = 0
  ): Usage | null {
    if (!lastUsage) {
      return finishReason ? { promptTokens: 0, completionTokens: 0, finishReason } : null
    }
    const totalTokens = turnPromptTokens + turnCompletionTokens
    return {
      ...lastUsage,
      // totalTokens 整轮累计：聚合统计不再用末次规模估算整轮
      totalTokens,
      ...(turnCacheReadTokens > 0 || turnCacheWriteTokens > 0
        ? { cacheReadTokens: turnCacheReadTokens, cacheWriteTokens: turnCacheWriteTokens }
        : {}),
      ...(requestCount > 1
        ? {
            totalPromptTokens: turnPromptTokens,
            totalCompletionTokens: turnCompletionTokens,
            requests: requestCount
          }
        : {}),
      ...(finishReason ? { finishReason } : {})
    }
  }

  private async invokeTool(
    runId: string,
    messageId: string,
    call: { id: string; name: string; input: unknown },
    conversationId: string,
    workingDirectory: string | null,
    emit: Emitter,
    controller: AbortController,
    onNotify?: (text: string) => void,
    onUsage?: (promptTokens: number, completionTokens: number, requests: number) => void
  ): Promise<ToolOutcome> {
    // 子智能体派发：不走静态注册表，直接进父回合的有界子循环。
    if (call.name === SPAWN_TOOL_NAME) {
      return this.runSubagentCall(runId, messageId, call, conversationId, workingDirectory, emit, controller, onNotify, onUsage)
    }
    // MCP 远端工具：mcp__服务__工具，走服务进程转发。
    if (call.name.startsWith('mcp__')) {
      // 许愿模式默认允许调用 MCP（设置 agent.wish.allowMcp，默认开）；
      // 是否免审批由服务级白名单决定，见 invokeMcpTool。
      if (this.isWishMode(runId, conversationId) && !getSetting<boolean>('agent.wish.allowMcp', true)) {
        return {
          content: '许愿模式已关闭外部 MCP 调用（设置 → 许愿模式 → 允许调用 MCP）。',
          isError: true
        }
      }
      return this.invokeMcpTool(runId, messageId, call, conversationId, emit, controller)
    }
    const tool = toolRegistry.get(call.name)
    if (!tool) {
      return { content: `未知工具：${call.name}。可用工具：${toolRegistry.all().map((t) => t.name).join('、')}`, isError: true }
    }

    // Computer Use 总闸：设置里关了就当不存在（清单过滤 + 这里兜底）。
    // 检查放审批之前：关掉后不再弹确认框，直接告知未启用
    if (call.name.startsWith('computer_') && !getSetting<boolean>('agent.computerUse', true)) {
      // 工具没有执行，必须报错，否则模型会以为操作成功而继续往下走
      return { content: '电脑控制未启用，请到设置里打开后再试。', isError: true }
    }

    // 只读复查兜底：即使模型私自拼出写工具名，也不执行。
    if (
      getSetting<boolean>('agent.readOnly', false) &&
      tool.requiresApproval &&
      !this.isWishMode(runId, conversationId)
    ) {
      return { content: '当前是只读复查模式，不执行写入与命令操作。如需修改请先关闭只读模式。', isError: true }
    }

    // 安全分级：先判硬红线，再决定是否走审批。
    // 自治等级只影响「软风险」是否自动放行；hard / blocked 永远不受影响。
    const autonomy = getSetting<AutonomyLevel>('agent.autonomy', 'balanced')
    const verdict = classifyToolCall(call.name, call.input, { workingDirectory, autonomy })
    if (verdict.tier === 'blocked') {
      return {
        content: `已拒绝未执行：${verdict.reason ?? '命中安全红线，任何模式下都不会执行。'}`,
        isError: true
      }
    }

    // Freebuff 安全护栏审计：补充 safety 未覆盖的系统凭据读取等场景。
    // CRITICAL 直接拒绝；HIGH 按 critical 审批处理（不允许“始终允许”绕过）。
    let securityConfirmReason = ''
    if (call.name === 'run_command' && typeof (call.input as Record<string, unknown>)?.command === 'string') {
      const audit = auditCommandSecurity(String((call.input as Record<string, unknown>).command))
      if (audit.isDangerous) {
        if (audit.severity === 'CRITICAL') {
          return {
            content: `已拦截未执行：${audit.reason ?? '检测到毁灭性系统操作。'}`,
            isError: true
          }
        }
        securityConfirmReason = audit.reason || '【Freebuff 安全护栏】检测到高危系统级操作！'
      }
    }

    const critical = verdict.tier === 'hard' || Boolean(securityConfirmReason)
    let needsApproval: boolean
    if (critical) {
      // 硬红线：无论永久放行名单、许愿模式、自治等级如何设置，都必须人工逐次确认。
      needsApproval = true
    } else if (isAutoAllowed(verdict, autonomy)) {
      needsApproval = false
    } else if (this.isAutoApproved(call.name)) {
      needsApproval = false
    } else {
      needsApproval = tool.requiresApproval
    }

    const wishAutoApproved =
      !critical &&
      this.isWishAutoApproved(runId, call.name, call.input, conversationId, workingDirectory)
    if (needsApproval && wishAutoApproved) needsApproval = false

    if (needsApproval) {
      // 无人值守时许愿模式不为软风险弹窗：直接拒绝，避免空转 5 分钟。
      // 但硬红线例外——宁可停下来等人，也不能默认放行删库/删 .git。
      if (this.isWishMode(runId, conversationId) && !critical) {
        return {
          content: `许愿模式不允许调用未授权的工具 ${call.name}。请改用工作区内的本地读写、补丁或命令工具。`,
          isError: true
        }
      }
      const decision = await this.requestApproval(
        runId,
        conversationId,
        messageId,
        call,
        {
          name: tool.name,
          approvalReason: securityConfirmReason || verdict.reason || tool.approvalReason,
          severity: critical ? 'critical' : 'normal',
          autoApprovable: verdict.autoApprovable
        },
        emit,
        controller
      )
      if (!decision.approved) {
        return {
          content: '用户拒绝了这次操作。请不要重复尝试相同操作，改为向用户说明你的意图或换一种不影响本机的方式。',
          isError: true
        }
      }
    }

    try {
      const raw = await tool.execute(call.input, {
        conversationId,
        runId,
        workingDirectory,
        signal: controller.signal
      })
      if (call.name === 'todo_write') {
        emit({
          type: 'todo_update',
          runId,
          conversationId,
          messageId,
          items: getTodoItems(runId)
        })
      }
      if (typeof raw === 'string') return { content: raw, isError: false }
      return { content: raw.content, isError: raw.isError, image: raw.image }
    } catch (error) {
      return { content: `工具执行失败：${describeError(error)}`, isError: true }
    }
  }

  /**
   * MCP 远端工具执行：默认需用户确认（外部进程能力未知），确认一次后可用
   * 「总是允许」按工具永久放行，走同一套审批流。
   *
   * 许愿模式是无人值守的自动交付模式：这里不弹窗等 5 分钟，而是按服务白名单
   * 直接放行或直接拒绝，避免空转。
   */
  private async invokeMcpTool(
    runId: string,
    messageId: string,
    call: { id: string; name: string; input: unknown },
    conversationId: string,
    emit: Emitter,
    controller: AbortController
  ): Promise<{ content: string; isError: boolean }> {
    const wishActive = this.isWishMode(runId, conversationId)
    if (getSetting<boolean>('agent.readOnly', false) && !wishActive) {
      return { content: '当前是只读复查模式，不调用外部 MCP 服务。', isError: true }
    }
    const parsed = parseMcpToolName(call.name)
    if (!parsed) return { content: `未知 MCP 工具：${call.name}`, isError: true }

    // 免审批路径：永久放行名单，或许愿模式下的服务级白名单。
    const autoApprovedServers = getSetting<string[]>('agent.wish.mcpAutoApproveServers', [])
    const wishMcpAuto = isWishMcpAutoApproved(
      call.name,
      wishActive,
      getSetting<boolean>('agent.wish.allowMcp', true),
      autoApprovedServers
    )
    if (!this.isAutoApproved(call.name) && !wishMcpAuto) {
      if (wishActive) {
        // 无人值守：不弹窗空转，直接拒绝并给出可执行的下一步。
        return {
          content:
            `许愿模式未放行 MCP 服务 ${parsed.serverId}（工具 ${call.name}）。` +
            '请在 设置 → 许愿模式 → MCP 免审批服务 中勾选该服务，或切回建造者模式逐次确认。',
          isError: true
        }
      }
      const decision = await this.requestApproval(
        runId,
        conversationId,
        messageId,
        call,
        { name: call.name, approvalReason: '将调用外部 MCP 服务进程，能力由该服务决定。' },
        emit,
        controller
      )
      if (!decision.approved) {
        return {
          content: '用户拒绝了这次外部服务调用。请不要重复尝试相同调用，改用本地方式或向用户说明。',
          isError: true
        }
      }
    }

    return mcpManager.callTool(parsed.serverId, parsed.toolName, call.input, controller.signal)
  }

  /** git 直调（worktree 隔离用），失败返回 null 由调用方回落原地跑。 */  private async git(args: string[], cwd: string): Promise<string | null> {
    try {
      const { stdout } = await execFileAsync('git', args, { cwd, windowsHide: true, timeout: 30_000 })
      return String(stdout ?? '').trim()
    } catch {
      return null
    }
  }

  /**
   * 子任务隔离：git 仓库内建独立 worktree（分支 subagent-xxxx），只读/非 git/建失败
   * 一律回落原地跑。收尾时干净则回收，脏则保留分支与路径给人验收，绝不自动合。
   */
  private async isolateSubagent(
    scopeDir: string | null
  ): Promise<{ workDir: string; describe: string; finalize: () => Promise<string> } | null> {
    if (!scopeDir) return null
    const toplevel = await this.git(['rev-parse', '--show-toplevel'], scopeDir)
    if (!toplevel) return null
    const name = `subagent-${randomUUID().slice(0, 8)}`
    const workDir = join(tmpdir(), 'shangbo-subagent', name)
    if ((await this.git(['worktree', 'add', workDir, '-b', name], toplevel)) === null) return null
    const describe = `分支 ${name}（${workDir}）`
    return {
      workDir,
      describe,
      finalize: async (): Promise<string> => {
        const status = await this.git(['status', '--porcelain'], workDir)
        if (status !== null && !status) {
          await this.git(['worktree', 'remove', workDir, '--force'], toplevel)
          await this.git(['branch', '-D', name], toplevel)
          return `独立工作区干净，已回收（${describe}）。`
        }
        const stat = (await this.git(['diff', '--stat'], workDir)) ?? ''
        return `独立工作区有改动，已保留待验收：${describe}\n${stat.slice(0, 2000)}`
      }
    }
  }

  /** spawn_subagent 的实际执行：组装子循环上下文，审批流与停止信号全部继承父回合。 */
  private async runSubagentCall(
    runId: string,
    messageId: string,
    call: { id: string; name: string; input: unknown },
    conversationId: string,
    parentWorkingDir: string | null,
    emit: Emitter,
    controller: AbortController,
    onNotify?: (text: string) => void,
    onUsage?: (promptTokens: number, completionTokens: number, requests: number) => void
  ): Promise<{ content: string; isError: boolean }> {
    const rawTask = (call.input as { task?: unknown } | null)?.task
    const task = typeof rawTask === 'string' ? rawTask.slice(0, 200) : ''
    emit({ type: 'subagent_start', runId, conversationId, messageId, toolUseId: call.id, task })
    try {
      const conversation = repo.getConversation(conversationId)
      const resolved = resolveTarget(conversation?.providerId, conversation?.model)
      // 子任务模型：设置页可指定，为空则跟随父会话；非法值回落跟随，不炸轮。
      const subTarget = resolveSubagentTarget(resolved.providerId, resolved.model)
      const effort = getSetting<string>('agent.effort', 'high')
      const subEffort = resolveEffort(subTarget.model, effort)
      const readOnly = getSetting<boolean>('agent.readOnly', false)
      const stuckCfg = getSetting<number>('agent.stuckLimit', 3)
      const stuckLimit = typeof stuckCfg === 'number' && stuckCfg > 0 ? stuckCfg : 3
      const result = await runSubagent(
        call.input,
        {
          model: subTarget.model,
          providerId: subTarget.providerId,
          workingDirectory: parentWorkingDir,
          readOnly,
          maxTokens: subEffort.maxTokens,
          reasoningEffort: subEffort.reasoningEffort,
          stuckLimit,
          signal: controller.signal,
          schemas: toolRegistry.schemas({ readOnly }),
          stream: (req, signal, providerId) => streamWithFallback(req, signal, providerId),
          invokeTool: (subCall, workDir) =>
            this.invokeTool(runId, messageId, subCall, conversationId, workDir ?? parentWorkingDir, emit, controller),
          isolate: (scopeDir) => this.isolateSubagent(scopeDir),
          notify: onNotify
        }
      )
      // 子循环若进了 worktree，后续同回合工具仍跑在原目录：隔离只属于那一个子任务。
      // 子任务用量合并进父轮：否则 spawn 的消耗账面永远免费
      if (result.usage) {
        onUsage?.(result.usage.promptTokens, result.usage.completionTokens, result.usage.requests)
      }
      emit({ type: 'subagent_done', runId, conversationId, messageId, toolUseId: call.id, task, isError: result.isError })
      return result
    } catch (error) {
      if (controller.signal.aborted) return { content: '子任务被用户停止。', isError: true }
      const content = `子任务执行失败：${describeError(error)}`
      emit({ type: 'subagent_done', runId, conversationId, messageId, toolUseId: call.id, task, isError: true })
      return { content, isError: true }
    }
  }

  private requestApproval(
    runId: string,
    conversationId: string,
    messageId: string,
    call: { id: string; name: string; input: unknown },
    tool: {
      name: string
      approvalReason?: string
      severity?: 'normal' | 'critical'
      autoApprovable?: boolean
    },
    emit: Emitter,
    controller: AbortController
  ): Promise<ApprovalDecision> {
    return this.approvalBroker.request(runId, conversationId, messageId, call, tool, emit, controller)
  }

  private isAutoApproved(toolName: string): boolean {
    return this.approvalBroker.isAutoApproved(toolName)
  }

  private isWishMode(runId: string, conversationId: string): boolean {
    // 优先用本轮已判定的模式：auto 模式在开跑时已确定，审批必须复用。
    const effective = this.runModes.get(runId)
    if (effective) return effective === 'wish' && getSetting<boolean>('agent.wish.enabled', true)
    const conversation = repo.getConversation(conversationId)
    return isWishModeActive(conversation?.mode ?? null, {
      wishEnabled: getSetting<boolean>('agent.wish.enabled', true),
      autoApproveWorkspace: getSetting<boolean>('agent.wish.autoApproveWorkspace', true),
      defaultMode: getSetting<string>('agent.mode', 'auto')
    })
  }

  /**
   * 许愿模式的“工作区内免审批”。
   *
   * 这不是无限制放行：只对读写类工具与工作区内的命令生效；密钥库、数据库、
   * 工作区外绝对路径、目录穿越与环境变量逃逸仍会落回审批或直接被工具层拒绝。
   * 硬红线（删 .git / 删库 / 擦盘）在调用本函数之前已被拦截，永远不会走到这里。
   */
  private isWishAutoApproved(
    runId: string,
    toolName: string,
    input: unknown,
    conversationId: string,
    workingDirectory: string | null
  ): boolean {
    return isWishAutoApproved(
      toolName,
      input,
      this.isWishMode(runId, conversationId),
      getSetting<boolean>('agent.wish.autoApproveWorkspace', true),
      workingDirectory
    )
  }

  private grantAutoApprove(toolName: string): void {
    this.approvalBroker.grantAutoApprove(toolName)
  }
}

/**
 * 子任务模型解析：`agent.subagent.target` 为空即跟随父会话；
 * 否则按 `${providerId}::${model}` 拆出，provider 不可用时回落跟随。
 */
export function resolveSubagentTarget(
  parentProviderId: string,
  parentModel: string
): { providerId: string; model: string } {
  const raw = getSetting<string>('agent.subagent.target', '').trim()
  if (!raw) return { providerId: parentProviderId, model: parentModel }
  const sep = raw.indexOf('::')
  if (sep <= 0 || sep >= raw.length - 2) return { providerId: parentProviderId, model: parentModel }
  const providerId = raw.slice(0, sep)
  const model = raw.slice(sep + 2)
  try {
    const resolved = resolveTarget(providerId, model)
    return { providerId: resolved.providerId, model: resolved.model }
  } catch {
    return { providerId: parentProviderId, model: parentModel }
  }
}

export const agentRuntime = new AgentRuntime()
