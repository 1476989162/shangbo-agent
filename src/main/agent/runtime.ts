import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import { promisify } from 'node:util'
import { createHash } from 'node:crypto'
import log from 'electron-log/main'
import * as repo from '../db/repo'
import { getSetting, setSetting } from '../settings'
import { auditCommandSecurity, toolRegistry } from '../tools'
import { clearTodoItems, getTodoItems } from '../tools/todo'
import { canonicalParamString } from '../../shared/remote'
import { eventBus, type EventSubscriber } from '../events/bus'
import { resolveFirstByteTimeoutMs, streamWithFallback } from '../providers/gateway'
import { routingOrder } from '../providers/store'
import {
  buildContext,
  buildSummaryTranscript,
  clampSummary,
  estimateTokens,
  hydrateContextImages,
  summaryCovers,
  toLLMMessages
} from './context'
import { DEFAULT_MAX_OUTPUT_TOKENS, resolveEffort } from './effort'
import { callSignature, detectStuck, type ToolRecord } from './loopGuard'
import { runSubagent, SPAWN_SUBAGENT_SCHEMA, SPAWN_TOOL_NAME } from './subagent'
import { mcpManager, parseMcpToolName } from '../mcp/manager'
import { deleteImageFile } from '../storage/images'
import type {
  AgentEvent,
  AgentSendRequest,
  ApprovalDecision,
  ContentBlock,
  ContextStatics,
  Conversation,
  Message,
  MessageStatus,
  SendPayload,
  Usage
} from '../../shared/types'
import { textOf, type LLMMessage } from '../providers/types'
import { matchReviewIntent, REVIEW_PLAYBOOK } from './playbooks'
import { listLessons, markLessonsUsed } from '../autonomous/store'
import {
  commandStaysInsideWorkspace,
  isPathAutoApprovable,
  isPathInsideResolved,
  isPathInside,
  touchesPrivateData
} from './commandGuard'

// 保持原有导出路径：wish.test.ts 等既有调用方无需改动
export { commandStaysInsideWorkspace } from './commandGuard'

export type Emitter = (event: AgentEvent) => void

/** 单次工具执行结果：截图类工具额外带图回传给模型。 */
export interface ToolOutcome {
  content: string
  isError: boolean
  image?: { mimeType: string; dataUrl: string }
}

const execFileAsync = promisify(execFile)

/** 审批弹窗超时：用户 5 分钟不点按拒绝处理。 */
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000
const MAX_OUTPUT_TOKENS = DEFAULT_MAX_OUTPUT_TOKENS
/** 思考过程只用于界面展示，不回传模型；封顶避免超长思考撑爆落库与界面。 */
const MAX_REASONING_CHARS = 8_000
/** 上轮思考耗尽预算后的续写指令：本轮不再思考，直接输出。 */
const SKIP_THINKING_SUFFIX = '\n\n（上轮思考过长被截断：本轮不要再思考，直接输出正文或工具调用。）'
const BUDGET_KEY = 'agent.contextBudgetTokens'
const AUTO_APPROVE_KEY = 'tools.autoApprove'
const WISH_AUTO_APPROVE_KEY = 'agent.wish.autoApproveWorkspace'

const DEFAULT_SYSTEM_PROMPT = `你是「尚搏 Agent」，运行在用户本机的个人助理，用中文回答，先给结论。

硬规则：
- 先读再改：改现有文件前先 read_file，优先 patch_file 局部改，一次只写一个文件。
- 先找再翻：定位文件/代码优先 search_files，不要逐层 list_directory。
- 不猜不重复：缺信息就调工具；用户拒绝的操作不再试同一种。`

const DEFAULT_BUDGET_TOKENS = 32_000

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 合并相邻的同类块，使流式增量落库后仍是一段完整文本而不是上千个碎片。 */
function appendBlock(blocks: ContentBlock[], block: ContentBlock): void {
  const last = blocks[blocks.length - 1]
  if (block.type === 'text' && last?.type === 'text') {
    last.text += block.text
    return
  }
  if (block.type === 'reasoning' && last?.type === 'reasoning') {
    if (last.text.length >= MAX_REASONING_CHARS) return
    const merged = last.text + block.text
    last.text = merged.length > MAX_REASONING_CHARS ? `${merged.slice(0, MAX_REASONING_CHARS)}…（思考过长，显示已截断）` : merged
    return
  }
  blocks.push(block)
}

/**
 * 流式增量归一化。
 *
 * 除了标准“真增量”网关，还有一些兼容网关会把累计全文当 delta 重发；
 * 如果直接 append，就会出现“结论：是结论：是我的问题…”这种结巴。
 * 该函数把累计快照转成真实新增后缀，并保留正常重复字词。
 */
function normalizeIncomingDelta(incoming: string, previous: string): { delta: string; snapshot: string } {
  if (!incoming) return { delta: '', snapshot: previous }
  if (!previous) return { delta: incoming, snapshot: incoming }
  if (incoming === previous) return { delta: '', snapshot: previous }
  if (incoming.startsWith(previous)) {
    return { delta: incoming.slice(previous.length), snapshot: incoming }
  }
  return { delta: incoming, snapshot: previous + incoming }
}

function resolveTarget(
  preferredProviderId: string | null | undefined,
  preferredModel: string | null | undefined
): { providerId: string; model: string; providerName: string } {
  const order = routingOrder(preferredProviderId)
  if (order.length === 0) {
    throw new Error('没有可用的模型供应商：请到「设置 → 模型供应商」填入 API Key 并启用。')
  }
  const provider = order[0]
  const model = preferredModel?.trim() || provider.models[0]
  if (!model) {
    throw new Error(`供应商「${provider.name}」还没有配置模型名，请在设置中补充或点击「拉取模型列表」。`)
  }
  return { providerId: provider.id, model, providerName: provider.name }
}

interface PendingApproval {
  toolName: string
  conversationId: string
  messageId: string
  input: unknown
  paramHash: string
  reason: string
  createdAt: number
  settle: (approved: boolean) => void
}

/** 待审批清单项（手机连上时立刻下发，不含 settle）。 */
export interface PendingApprovalSnapshot {
  runId: string
  toolUseId: string
  conversationId: string
  messageId: string
  toolName: string
  input: unknown
  paramHash: string
  reason: string
  createdAt: number
  expiresAt: number
  remainingMs: number
}

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
  private approvals = new Map<string, PendingApproval>()
  /** 会话 id → 该会话的等待队列。同一会话严格串行，不同会话互不阻塞。 */
  private queues = new Map<string, QueuedRun[]>()
  /** 会话 id → 中途指导（steer）：排队消息转指导后暂存，主循环每轮开跑前取走拼进系统提示。 */
  private steeringNotes = new Map<string, string[]>()

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
   * 统一的生命周期包装：失败发 run_error，结束必发 run_end。
   *
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
    if (!this.runs.has(runId)) return
    this.runs.delete(runId)
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
        await this.executeSend(runId, self.payload, fresh, emit, controller)
      }
    }, busy ? { userMessage } : null)
  }

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
      start: async () => {
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
          emit,
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
    for (const [key, pending] of [...this.approvals]) {
      if (pending.conversationId === conversationId) {
        try {
          pending.settle(false)
        } catch {}
        this.approvals.delete(key)
      }
    }
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
    for (const [key, pending] of this.approvals) {
      const runId = key.split(':')[0]
      if (runIds.has(runId)) pending.settle(false)
    }
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
    const key = `${decision.runId}:${decision.toolUseId}`
    const pending = this.approvals.get(key)
    const toolName = pending?.toolName
    this.decideWithHash(decision.runId, decision.toolUseId, decision.approved, undefined)
    // 5.3：只有桌面本地审批的 alwaysAllow 才记自动放行；远程审批永不记入
    if (decision.approved && decision.alwaysAllow && toolName) {
      this.grantAutoApprove(toolName)
    }
  }

  /**
   * 带哈希绑定的审批裁决（阶段5：远程审批必须带 paramHash）。
   * - expectedParamHash 为 undefined 时为桌面本地审批，不做哈希校验（兼容现有调用）。
   * - 远程审批必须提供哈希且与创建时一致，否则按拒绝处理（防参数中途被替换）。
   * 返回 true 表示裁决被接受（批准或拒绝均已 settle），false 表示无此审批或哈希不一致。
   */
  decideWithHash(runId: string, toolUseId: string, approved: boolean, expectedParamHash?: string): boolean {
    const key = `${runId}:${toolUseId}`
    const pending = this.approvals.get(key)
    if (!pending) return false
    if (expectedParamHash !== undefined && expectedParamHash !== pending.paramHash) {
      log.warn(`[agent] 远程审批哈希不一致，已按拒绝处理：${key}`)
      pending.settle(false)
      return false
    }
    pending.settle(approved)
    return true
  }

  /** 当前所有待审批清单（手机连上时立刻下发）。 */
  listPendingApprovals(): PendingApprovalSnapshot[] {
    const now = Date.now()
    const out: PendingApprovalSnapshot[] = []
    for (const [key, pending] of this.approvals) {
      const sep = key.indexOf(':')
      const runId = key.slice(0, sep)
      const toolUseId = key.slice(sep + 1)
      const remainingMs = Math.max(0, pending.createdAt + APPROVAL_TIMEOUT_MS - now)
      out.push({
        runId,
        toolUseId,
        conversationId: pending.conversationId,
        messageId: pending.messageId,
        toolName: pending.toolName,
        input: pending.input,
        paramHash: pending.paramHash,
        reason: pending.reason,
        createdAt: pending.createdAt,
        expiresAt: pending.createdAt + APPROVAL_TIMEOUT_MS,
        remainingMs
      })
    }
    return out
  }

  /** 对工具参数计算稳定哈希（审批绑定用，与手机端 WebCrypto SHA-256 对应）。 */
  static paramHashOf(input: unknown): string {
    return createHash('sha256').update(canonicalParamString(input), 'utf8').digest('hex')
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
      status
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
   * 「规划 → 调用工具 → 观察 → 再规划」主循环。
   * 一条助手消息承载整轮的全部内容块（文本、工具调用、工具结果），
   * 这样界面上呈现为一个可折叠的助手回合，回传历史时再拆回协议要求的角色序列。
   */
  private async runModel(
    runId: string,
    conversation: Pick<Conversation, 'id' | 'systemPrompt' | 'workingDir' | 'mode'>,
    userMessage: Message,
    target: { providerId?: string | null; model?: string | null },
    emit: Emitter,
    controller: AbortController
  ): Promise<void> {
    const resolved = resolveTarget(
      target.providerId,
      target.model ?? repo.getConversation(conversation.id)?.model
    )

    const assistantMessage = repo.insertMessage({
      conversationId: conversation.id,
      parentId: userMessage.id,
      role: 'assistant',
      blocks: [],
      status: 'streaming',
      providerId: resolved.providerId,
      model: resolved.model
    })

    emit({
      type: 'run_start',
      runId,
      conversationId: conversation.id,
      userMessageId: userMessage.id,
      assistantMessageId: assistantMessage.id,
      userMessage
    })

    const blocks: ContentBlock[] = []
    // usage 口径说明：多步工具循环时上下文历史会逐步增长，每步请求都完整重发，
    // 把各步 promptTokens 相加当成"一次请求的输入"是虚的。因此分开记录：
    // lastUsage = 末次请求的真实规模（展示用），turnUsage = 整轮累计（成本口径），
    // requestCount 用于区分单请求与多步，让前端决定要不要展示双口径。
    let lastUsage: Usage | null = null
    let turnPromptTokens = 0
    let turnCompletionTokens = 0
    let turnCacheReadTokens = 0
    let turnCacheWriteTokens = 0
    let requestCount = 0
    // 流式通道快照：跨供应商/跨步共享同一份，确保累计全文不会被二次追加。
    let textStreamSnapshot = ''
    let reasoningStreamSnapshot = ''
    // 跨供应商降级后，实际服务的可能不是首选；最终落库以实际值为准。
    let servedProviderId = resolved.providerId
    let servedModel = resolved.model
    let status: MessageStatus = 'done'
    let errorText: string | null = null

    let finalStopReason = 'stop'

    // 回合内不变的系统提示只拼一次，避免每步重复读设置并膨胀上下文。
    const baseSystem = conversation.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT
    const customInstructions = getSetting<string>('agent.instructions', '').trim()
    const effort = getSetting<string>('agent.effort', 'high')
    // 真旋钮：档位按模型家族映射成 API 参数与输出上限，不再只改一句话。
    const resolvedEffort = resolveEffort(resolved.model, effort)
    let system = baseSystem
    if (customInstructions) system += `\n\n用户通用指导偏好：\n${customInstructions}`
    if (resolvedEffort.hint) system += resolvedEffort.hint
    if (conversation.workingDir) {
      system += `\n\n当前项目目录：${conversation.workingDir}。相对路径基于它解析，命令默认在它下执行。`
    }

    const plugins = getSetting<string[]>('agent.plugins', [
      'feature-dev',
      'commit-commands',
      'ralph-loop',
      'security-guidance'
    ])
    const pluginDirectives: string[] = []
    if (plugins.includes('feature-dev')) pluginDirectives.push('复杂改造先查结构、给规划再改。')
    if (plugins.includes('commit-commands')) pluginDirectives.push('用户要提交时先 git status/diff 再写语义化信息。')
    if (plugins.includes('ralph-loop')) pluginDirectives.push('改完代码有测试就跑，报错读栈自愈。')
    if (plugins.includes('security-guidance')) pluginDirectives.push('注意密钥/SQL注入/命令拼接风险。')
    if (plugins.includes('github')) pluginDirectives.push('GitHub 操作优先用本机 gh。')

    const agentMode =
      conversation.mode === 'wish' && !getSetting<boolean>('agent.wish.enabled', true)
        ? 'builder'
        : (conversation.mode ?? getSetting<string>('agent.mode', 'builder'))

    // 许愿闭环：把当前分支的真实 diff 作为“改动证据”注入，避免模型只凭记忆总结。
    if (
      agentMode === 'wish' &&
      conversation.workingDir &&
      getSetting<boolean>('agent.wish.enabled', true)
    ) {
      const diff = await this.git(['diff', '--stat'], conversation.workingDir)
      if (diff) {
        system += `\n\n【当前工作区改动】\n${diff.slice(0, 6000)}`
      }
    }
    if (agentMode === 'builder') {
      system += '\n\n【建造者】改代码必须调工具落盘、一次一个文件；优先 patch_file；写完有测试就自验。独立子任务（分模块侦察、独立文件改造）可 spawn_subagent 并行派，最后由你汇总结论。'
    } else if (agentMode === 'chat') {
      system += '\n\n【问答】给思路和核心片段即可。'
    } else if (agentMode === 'wish' && getSetting<boolean>('agent.wish.enabled', true)) {
      const acceptance = getSetting<string>('agent.wish.acceptance', '').trim()
      const verifyCommand = getSetting<string>('agent.wish.verifyCommand', '').trim()
      system += [
        '',
        '【许愿模式】你是自动交付者，不是咨询顾问。',
        '工作区内读写与命令无需等待用户确认；你必须自己规划、修改、运行验证、读取报错、修复并重跑，直到满足验收。',
        '不得声称“应该可以”或把验证留给用户。没有真实验证证据就不能宣布完成。',
        acceptance ? `默认验收标准：${acceptance}` : '',
        verifyCommand ? `默认验收命令：${verifyCommand}` : '',
        '最终必须输出：改动摘要、实际执行的验证命令与结果、剩余风险、回滚方式。',
        '硬边界：只改当前工作区；不读取密钥库/会话数据库；不执行擦盘、格式化、删系统目录等不可逆操作。'
      ]
        .filter(Boolean)
        .join('\n')
      const lessons = listLessons({ projectPath: conversation.workingDir, limit: 12 })
      if (lessons.length > 0) {
        system += `\n\n【已验证的项目经验（优先复用）】\n${lessons
          .map((lesson, index) => `${index + 1}. ${lesson.title}\n${lesson.content}`)
          .join('\n')}`
        markLessonsUsed(lessons.map((lesson) => lesson.id))
      }
    }
    if (pluginDirectives.length > 0) system += `\n已启用技能：${pluginDirectives.join(' ')}`

    // 方法论注入：本轮是复查任务才给打法，平时不打扰。
    const triggerMessage = repo.getMessage(userMessage.id)
    if (triggerMessage && matchReviewIntent(textOf(triggerMessage.blocks))) {
      system += REVIEW_PLAYBOOK
    }

    // 许愿任务要留出“改—跑—读错—再改”的空间；32k 预算常在长测试日志后把任务目标裁掉。
    const configuredBudget = getSetting<number>(BUDGET_KEY, DEFAULT_BUDGET_TOKENS)
    const budget =
      agentMode === 'wish' && getSetting<boolean>('agent.wish.enabled', true)
        ? Math.max(configuredBudget, 64_000)
        : configuredBudget
    // Codex 式沙箱档：只读复查时模型根本看不到写工具，比逐个审批更彻底。
    // 许愿模式本身是“自动交付”模式，不应被通用只读复查开关静默降级；
    // 用户若切到许愿模式，就明确表示要落盘和验证。
    const readOnly = agentMode !== 'wish' && getSetting<boolean>('agent.readOnly', false)
    if (readOnly) system += '\n\n【只读复查】只允许读取与搜索文件，禁止写入、修改与执行命令；输出问题清单即可，不要尝试改动。'
    // 保险丝灵敏度：连续几次打转就停，默认 3。
    const stuckCfg = getSetting<number>('agent.stuckLimit', 3)
    const effectiveStuckLimit = typeof stuckCfg === 'number' && stuckCfg > 0 ? stuckCfg : 3
    // 步数上限：防止模型换参试错无限烧 Token，默认 50 轮请求后暂停。loopGuard 只拦"打转"，
    // 正常干活 50 步也会触发——这是成本熔断，不是行为判断。到顶复用 guardNotice 提示用户。
    const maxStepsCfg =
      agentMode === 'wish' && getSetting<boolean>('agent.wish.enabled', true)
        ? getSetting<number>('agent.wishMaxSteps', 120)
        : getSetting<number>('agent.maxSteps', 50)
    const effectiveMaxSteps = typeof maxStepsCfg === 'number' && maxStepsCfg > 0 ? Math.floor(maxStepsCfg) : 50
    let stepCount = 0
    // 本轮已执行的工具序列，只用于打转检测，不回传模型。
    const toolHistory: ToolRecord[] = []
    const noteToolBatch = (
      items: { call: { name: string; input: unknown }; result: { isError: boolean } }[]
    ): string | null => {
      for (const item of items) {
        toolHistory.push({ sig: callSignature(item.call.name, item.call.input), isError: item.result.isError })
      }
      return detectStuck(toolHistory, effectiveStuckLimit)
    }
    let stoppedByGuard = false
    // 本轮发给模型的工具清单：本地读/写 + spawn + 已启用 MCP 服务的远端工具。
    // MCP 进程首次拉起可能慢（npx 拉包），之后常驻复用；单个服务起不来只跳过不炸轮。
    // Computer Use 工具只在设置开启时挂载（截图免审，其余键鼠操作逐次审批）。
    const computerOn = getSetting<boolean>('agent.computerUse', true)
    const offeredSchemas = [
      ...toolRegistry.schemas({ readOnly }).filter((t) => computerOn || !t.name.startsWith('computer_')),
      SPAWN_SUBAGENT_SCHEMA,
      ...(await mcpManager.toolSchemas())
    ]
    if (computerOn && !readOnly) {
      system += '\n\n【桌面操作】需要操作本机桌面应用时：先 computer_screenshot 看屏，按截图像素坐标 computer_click，必要时 computer_type / computer_press_key / computer_scroll。每次键鼠操作都要用户确认。'
    }
    // 进度通知：子任务起止落到父消息文本里，当下即可见。
    const onNotify = (text: string): void => {
      appendBlock(blocks, { type: 'text', text: `\n\n${text}` })
      emit({
        type: 'text_delta',
        runId,
        conversationId: conversation.id,
        messageId: assistantMessage.id,
        text: `\n\n${text}`
      })
    }

    // 工具 schema 常年 8000-15000 tokens，不计入预算等于预算虚高：这里一次估值（续写复用）
    const toolSchemaTokens = estimateTokens(JSON.stringify(offeredSchemas))
    const toolResultMaxCharsRaw = getSetting<number>('agent.toolResultMaxChars', 4000)
    const effectiveToolResultMaxChars =
      typeof toolResultMaxCharsRaw === 'number' && toolResultMaxCharsRaw > 0 ? toolResultMaxCharsRaw : 4000

    try {
      // 主循环：跑到模型不再调工具为止。防打转靠 loopGuard 行为保险丝，
      // 防无限烧 Token 靠 maxSteps 成本熔断。想停随时点「停止」。
      for (;;) {
        if (controller.signal.aborted) {
          status = 'aborted'
          break
        }
        // 成本熔断：超过 maxSteps 轮请求即暂停，提示用户回复"继续"接力
        if (stepCount >= effectiveMaxSteps) {
          stoppedByGuard = true
          const guardNotice = `\n\n_（已达到单轮步数上限（${effectiveMaxSteps} 步），先停下来请人看一眼，不要继续烧 Token。排除问题后回复「继续」。）_`
          appendBlock(blocks, { type: 'text', text: guardNotice })
          emit({
            type: 'text_delta',
            runId,
            conversationId: conversation.id,
            messageId: assistantMessage.id,
            text: guardNotice
          })
          break
        }
        stepCount++

        const persisted = repo.getPathTo(userMessage.id)
        // 工具 schema 常年 8000-15000 tokens，不计入预算等于预算虚高：这里复用 try 外一次估值
          // 轮间摘要（可选）：被裁掉的历史先换成语义摘要，避免模型直接“失忆”。
          // 摘要由当前模型异步生成，并缓存在 conversations.summary_json。
          const summarizeEnabled = getSetting<boolean>('agent.context.summarize', false)
          let cachedSummary: repo.ConversationSummary | null = null
          if (summarizeEnabled) {
            cachedSummary = repo.getConversationSummary(conversation.id)
            const probe = buildContext(persisted, {
              system,
              budgetTokens: budget,
              extraTokens: toolSchemaTokens,
              toolResultMaxChars: effectiveToolResultMaxChars
            })
            if (probe.omittedMessages?.length && probe.omittedMessages.length > 0) {
              const lastOmitted = probe.omittedMessages[probe.omittedMessages.length - 1]
              if (!cachedSummary || cachedSummary.coveredMessageId !== lastOmitted.id) {
                const transcript = buildSummaryTranscript(probe.omittedMessages)
                if (transcript.trim()) {
                  const text = await this.summarizeHistory(
                    transcript,
                    resolved.providerId,
                    controller.signal
                  )
                  if (text) {
                    cachedSummary = {
                      coveredMessageId: lastOmitted.id,
                      text,
                      updatedAt: Date.now()
                    }
                    repo.setConversationSummary(conversation.id, cachedSummary)
                  }
                }
              }
            }
          }
          const context = buildContext(persisted, {
          system,
          budgetTokens: budget,
          extraTokens: toolSchemaTokens,
            toolResultMaxChars: effectiveToolResultMaxChars,
            summary: cachedSummary?.text
        })
        // 裁剪完成后才读图片：被裁掉的历史轮次里的图永远不进内存
        await hydrateContextImages(context)
        // 裁剪发生时告诉模型，避免它以为看到了全部历史而编造。
        // 中途指导：用户在排队消息上点"指导当前轮"，下一轮请求即带上，不等前面的跑完
        const steering = this.takeSteeringNotes(conversation.id)
        const effectiveSystem =
          context.omittedTurns > 0 || steering.length > 0
            ? `${system}${
                context.omittedTurns > 0
                  ? `\n\n（最早 ${context.omittedTurns} 轮历史已省略，如需请向用户确认。）`
                  : ''
              }${
                steering.length > 0
                  ? `\n\n【用户中途指导（必须优先遵守，后续动作按此调整）】\n${steering.map((s, i) => `${i + 1}. ${s}`).join('\n')}`
                  : ''
              }`
            : system

        // 持久化路径 + 本轮尚未落库的累积块，拼出这次请求的完整消息序列
        const inMemory: Message[] = [{ ...assistantMessage, blocks: [...blocks], role: 'assistant' }]
        const messages: LLMMessage[] = [...context.messages, ...toLLMMessages(inMemory)]

        const toolUses: { id: string; name: string; input: unknown }[] = []

        let stopReason = 'stop'
        const firstByteTimeoutRaw = getSetting<number>('providers.firstByteTimeoutMs', 180_000)
        const firstByteTimeoutMs = resolveFirstByteTimeoutMs(firstByteTimeoutRaw)
        // Anthropic 提示词缓存默认开启；兼容网关不支持时可在设置里关掉
        const promptCache = getSetting<boolean>('provider.anthropic.promptCache', true)
        for await (const chunk of streamWithFallback(
          {
            model: resolved.model,
            system: effectiveSystem,
            messages,
            tools: offeredSchemas,
            maxTokens: resolvedEffort.maxTokens,
            reasoningEffort: resolvedEffort.reasoningEffort,
            promptCache
          },
          controller.signal,
          resolved.providerId,
          { firstByteTimeoutMs }
        )) {
          if (chunk.type === 'text') {
            const normalized = normalizeIncomingDelta(chunk.text, textStreamSnapshot)
            textStreamSnapshot = normalized.snapshot
            if (!normalized.delta) continue
            appendBlock(blocks, { type: 'text', text: normalized.delta })
            emit({
              type: 'text_delta',
              runId,
              conversationId: conversation.id,
              messageId: assistantMessage.id,
              text: normalized.delta
            })
          } else if (chunk.type === 'reasoning') {
            const normalized = normalizeIncomingDelta(chunk.text, reasoningStreamSnapshot)
            reasoningStreamSnapshot = normalized.snapshot
            if (!normalized.delta) continue
            appendBlock(blocks, { type: 'reasoning', text: normalized.delta })
            emit({
              type: 'reasoning_delta',
              runId,
              conversationId: conversation.id,
              messageId: assistantMessage.id,
              text: normalized.delta
            })
          } else if (chunk.type === 'tool_use') {
            toolUses.push({ id: chunk.id, name: chunk.name, input: chunk.input })
          } else if (chunk.type === 'stop') {
            stopReason = chunk.reason
          } else if (chunk.type === 'provider_switch') {
            servedProviderId = chunk.providerId
            servedModel = chunk.model
            emit({
              type: 'provider_switched',
              runId,
              conversationId: conversation.id,
              fromProviderName: chunk.fromProviderName,
              providerName: chunk.providerName,
              model: chunk.model,
              reason: chunk.reason
            })
          } else if (chunk.type === 'retry_status') {
            emit({
              type: 'retry_status',
              runId,
              conversationId: conversation.id,
              providerName: chunk.providerName,
              attempt: chunk.attempt,
              maxAttempts: chunk.maxAttempts,
              waitMs: chunk.waitMs,
              reason: chunk.reason
            })
          } else if (chunk.type === 'usage') {
            lastUsage = chunk.usage
            turnPromptTokens += chunk.usage.promptTokens
            turnCompletionTokens += chunk.usage.completionTokens
            turnCacheReadTokens += chunk.usage.cacheReadTokens ?? 0
            turnCacheWriteTokens += chunk.usage.cacheWriteTokens ?? 0
            requestCount++
            // 渲染端靠这个事件实时刷新 token 用量；只落库不发事件，UI 上的用量就永远是空的
            emit({
              type: 'usage',
              runId,
              conversationId: conversation.id,
              messageId: assistantMessage.id,
              usage: chunk.usage
            })
          }
        }

        finalStopReason = stopReason

        for (const call of toolUses) {
          blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input })
          emit({
            type: 'tool_use',
            runId,
            conversationId: conversation.id,
            messageId: assistantMessage.id,
            toolUseId: call.id,
            name: call.name,
            input: call.input
          })
        }

        if (toolUses.length === 0) {
          break
        }

        // 只读工具与 spawn 可并行（同一批 read_file/search 曾经要串行等很久）；
        // 需要审批的写操作保持串行，避免同时弹多个确认框。
        const canParallel = toolUses.every((call) => {
          if (call.name === SPAWN_TOOL_NAME) return true
          const tool = toolRegistry.get(call.name)
          return !!tool && !tool.requiresApproval && call.name !== 'run_command'
        })
        // 子任务不限个数并行：要速度不要省 Token，上限只剩深度 1 与行为保险丝。
        const invokeOne = (call: { id: string; name: string; input: unknown }): Promise<{
          call: { id: string; name: string; input: unknown }
          result: ToolOutcome
        }> => {
          return this.invokeTool(
            runId,
            assistantMessage.id,
            call,
            conversation.id,
            conversation.workingDir,
            emit,
            controller,
            onNotify,
            (promptTokens, completionTokens, requests) => {
              turnPromptTokens += promptTokens
              turnCompletionTokens += completionTokens
              requestCount += requests
            }
          ).then((result) => ({ call, result }))
        }

        type Settled = { call: { id: string; name: string; input: unknown }; result: ToolOutcome }
        let settled: Settled[]
        if (canParallel) {
          settled = await Promise.all(toolUses.map(invokeOne))
        } else {
          settled = []
          for (const call of toolUses) settled.push(await invokeOne(call))
        }

        for (const { call, result } of settled) {
          blocks.push({
            type: 'tool_result',
            toolUseId: call.id,
            content: result.content,
            isError: result.isError,
            ...(result.image ? { image: result.image } : {})
          })
          emit({
            type: 'tool_result',
            runId,
            conversationId: conversation.id,
            messageId: assistantMessage.id,
            toolUseId: call.id,
            content: result.content,
            isError: result.isError
          })
        }

        // 保险丝：打转就地暂停，不再浪费后面的步数。
        const stuckReason = noteToolBatch(settled)
        if (stuckReason) {
          stoppedByGuard = true
          const guardNotice = `\n\n_（${stuckReason}本轮已暂停，排除问题后回复「继续」。）_`
          appendBlock(blocks, { type: 'text', text: guardNotice })
          emit({
            type: 'text_delta',
            runId,
            conversationId: conversation.id,
            messageId: assistantMessage.id,
            text: guardNotice
          })
          repo.updateMessage(assistantMessage.id, {
            blocks: [...blocks],
            usage: this.composeUsage(lastUsage, turnPromptTokens, turnCompletionTokens, requestCount, stopReason, turnCacheReadTokens, turnCacheWriteTokens)
          })
          break
        }

        // 阶段性落库，进程意外退出时仍能看到已完成的部分
        repo.updateMessage(assistantMessage.id, {
          blocks: [...blocks],
          usage: this.composeUsage(lastUsage, turnPromptTokens, turnCompletionTokens, requestCount, stopReason, turnCacheReadTokens, turnCacheWriteTokens)
        })
      }

      // 思考耗尽预算：先自动续一次（跳过思考直接要正文），实在要不到才提示手动继续。
      // 否则下一轮会把同样的历史重想一遍，再次撞上 8192 上限。
      const hasText = blocks.some((b) => b.type === 'text' && b.text.trim().length > 0)
      const hasReasoning = blocks.some((b) => b.type === 'reasoning' && b.text.trim().length > 0)
      let truncatedByThinking =
        (finalStopReason === 'length' || finalStopReason === 'max_tokens') &&
        !hasText &&
        hasReasoning
      if (truncatedByThinking && !controller.signal.aborted) {
        for (let attempt = 0; attempt < 2 && truncatedByThinking; attempt++) {
          const persistedNow = repo.getPathTo(userMessage.id)
          const contextNow = buildContext(persistedNow, {
            system,
            budgetTokens: budget,
            extraTokens: toolSchemaTokens,
            toolResultMaxChars: effectiveToolResultMaxChars
          })
          await hydrateContextImages(contextNow)
          const inMemoryNow: Message[] = [{ ...assistantMessage, blocks: [...blocks], role: 'assistant' }]
          const continued: { id: string; name: string; input: unknown }[] = []
          let contStop = 'stop'
          // 续写沿用实际服务模型的档位映射，避免降级后用错上限。
          const contEffort = resolveEffort(servedModel, effort)
            const contPromptCache = getSetting<boolean>('provider.anthropic.promptCache', true)
          for await (const chunk of streamWithFallback(
            {
              model: servedModel,
              system: system + SKIP_THINKING_SUFFIX,
              messages: [...contextNow.messages, ...toLLMMessages(inMemoryNow)],
              tools: offeredSchemas,
              maxTokens: contEffort.maxTokens,
                reasoningEffort: contEffort.reasoningEffort,
                promptCache: contPromptCache
            },
            controller.signal,
            servedProviderId
          )) {
            if (chunk.type === 'text') {
              const normalized = normalizeIncomingDelta(chunk.text, textStreamSnapshot)
              textStreamSnapshot = normalized.snapshot
              if (!normalized.delta) continue
              appendBlock(blocks, { type: 'text', text: normalized.delta })
              emit({ type: 'text_delta', runId, conversationId: conversation.id, messageId: assistantMessage.id, text: normalized.delta })
            } else if (chunk.type === 'reasoning') {
              const normalized = normalizeIncomingDelta(chunk.text, reasoningStreamSnapshot)
              reasoningStreamSnapshot = normalized.snapshot
              if (!normalized.delta) continue
              appendBlock(blocks, { type: 'reasoning', text: normalized.delta })
              emit({ type: 'reasoning_delta', runId, conversationId: conversation.id, messageId: assistantMessage.id, text: normalized.delta })
            } else if (chunk.type === 'tool_use') {
              continued.push({ id: chunk.id, name: chunk.name, input: chunk.input })
            } else if (chunk.type === 'stop') {
              contStop = chunk.reason
            } else if (chunk.type === 'usage') {
              lastUsage = chunk.usage
              turnPromptTokens += chunk.usage.promptTokens
              turnCompletionTokens += chunk.usage.completionTokens
              turnCacheReadTokens += chunk.usage.cacheReadTokens ?? 0
              turnCacheWriteTokens += chunk.usage.cacheWriteTokens ?? 0
              requestCount++
              emit({ type: 'usage', runId, conversationId: conversation.id, messageId: assistantMessage.id, usage: chunk.usage })
            }
          }
          for (const call of continued) {
            blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input })
            emit({ type: 'tool_use', runId, conversationId: conversation.id, messageId: assistantMessage.id, toolUseId: call.id, name: call.name, input: call.input })
          }
          const contPairs: { call: { id: string; name: string; input: unknown }; result: ToolOutcome }[] = []
          for (const call of continued) {
            const result = await this.invokeTool(runId, assistantMessage.id, call, conversation.id, conversation.workingDir, emit, controller, onNotify,
              (promptTokens, completionTokens, requests) => {
                turnPromptTokens += promptTokens
                turnCompletionTokens += completionTokens
                requestCount += requests
              })
            blocks.push({ type: 'tool_result', toolUseId: call.id, content: result.content, isError: result.isError, ...(result.image ? { image: result.image } : {}) })
            emit({ type: 'tool_result', runId, conversationId: conversation.id, messageId: assistantMessage.id, toolUseId: call.id, content: result.content, isError: result.isError })
            contPairs.push({ call, result })
          }
          const contStuck = noteToolBatch(contPairs)
          if (contStuck) {
            stoppedByGuard = true
            const guardNotice = `\n\n_（${contStuck}本轮已暂停，排除问题后回复「继续」。）_`
            appendBlock(blocks, { type: 'text', text: guardNotice })
            emit({ type: 'text_delta', runId, conversationId: conversation.id, messageId: assistantMessage.id, text: guardNotice })
            finalStopReason = contStop
            repo.updateMessage(assistantMessage.id, {
              blocks: [...blocks],
              usage: this.composeUsage(lastUsage, turnPromptTokens, turnCompletionTokens, requestCount, contStop, turnCacheReadTokens, turnCacheWriteTokens)
            })
            break
          }
          finalStopReason = contStop
          const gotText = blocks.some((b) => b.type === 'text' && b.text.trim().length > 0)
          truncatedByThinking = (contStop === 'length' || contStop === 'max_tokens') && !gotText
          repo.updateMessage(assistantMessage.id, {
            blocks: [...blocks],
            usage: this.composeUsage(lastUsage, turnPromptTokens, turnCompletionTokens, requestCount, contStop, turnCacheReadTokens, turnCacheWriteTokens)
          })
        }
      }
      const stillTruncated =
        (finalStopReason === 'length' || finalStopReason === 'max_tokens') &&
        !blocks.some((b) => b.type === 'text' && b.text.trim().length > 0) &&
        blocks.some((b) => b.type === 'reasoning' && b.text.trim().length > 0)
      if (stillTruncated) {
        const truncationNotice =
          `\n\n⚠️ **【智能截断保护】** 大模型的思考推导过程耗尽了单次最大 Token 预算（${resolvedEffort.maxTokens} tokens），在输出正式正文前被中断。\n\n💡 **已为您就绪断点续写机制**：请点击下方「⚡ 智能继续生成」或发送「继续」，大模型将跳过思考直接无缝吐出剩余正文与代码。`
        appendBlock(blocks, { type: 'text', text: truncationNotice })
        emit({
          type: 'text_delta',
          runId,
          conversationId: conversation.id,
          messageId: assistantMessage.id,
          text: truncationNotice
        })
      }

      if (blocks.length === 0) {
        appendBlock(blocks, {
          type: 'text',
          text: '（模型返回了空回复。可能是当前模型不支持工具调用，请换一个模型或关闭工具后重试。）'
        })
      }
    } catch (error) {
      if (controller.signal.aborted) {
        status = 'aborted'
      } else {
        status = 'error'
        errorText = describeError(error)
        log.error('[agent] 生成失败', error)
        emit({
          type: 'run_error',
          runId,
          conversationId: conversation.id,
          messageId: assistantMessage.id,
          error: errorText
        })
      }
    }

    repo.updateMessage(assistantMessage.id, {
      blocks,
      status,
      error: errorText,
      usage: this.composeUsage(lastUsage, turnPromptTokens, turnCompletionTokens, requestCount, finalStopReason, turnCacheReadTokens, turnCacheWriteTokens),
      model: servedModel,
      providerId: servedProviderId
    })
    // 只有当 activeLeaf 仍停在本回合的起点（用户消息）时才推进到新回复。
    // 生成期间用户可能已切换分支，直接覆盖会悄悄改掉用户的选择。
    if (repo.getActiveLeaf(conversation.id) === userMessage.id) {
      repo.setActiveLeaf(conversation.id, assistantMessage.id)
    }
    repo.touchConversation(conversation.id)

    emit({
      type: 'message_done',
      runId,
      conversationId: conversation.id,
      messageId: assistantMessage.id,
      status
    })
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
      if (this.isWishMode(conversationId)) {
        return {
          content: '许愿模式只使用本地工作区工具，不调用外部 MCP 服务。',
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
      !this.isWishMode(conversationId)
    ) {
      return { content: '当前是只读复查模式，不执行写入与命令操作。如需修改请先关闭只读模式。', isError: true }
    }

    // Freebuff 安全护栏审计，按严重程度分级：
    // - CRITICAL（擦盘/格式化）直接拒绝、不弹窗——工具层自保同样硬拦，
    //   用户批准了也执行不了，先问再拒只会自相矛盾；
    // - HIGH（删库/注册表等）弹窗征求确认，批准后放行（工具层不拦）。
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

    const needsApproval =
      (tool.requiresApproval && !this.isAutoApproved(call.name)) || Boolean(securityConfirmReason)
    const wishAutoApproved = this.isWishAutoApproved(
      call.name,
      call.input,
      conversationId,
      workingDirectory
    )
    if (needsApproval && !wishAutoApproved) {
      // 无人值守时许愿模式不弹窗：高危系统操作与未知外部能力直接拒绝，
      // 避免任务在审批超时里空转 5 分钟，也避免把审批误当成“默认同意”。
      if (this.isWishMode(conversationId)) {
        return {
          content: securityConfirmReason
            ? `许愿模式拒绝未执行：${securityConfirmReason}`
            : `许愿模式不允许调用未授权的工具 ${call.name}。请改用工作区内的本地读写、补丁或命令工具。`,
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
          approvalReason: securityConfirmReason || tool.approvalReason
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
   */
  private async invokeMcpTool(
    runId: string,
    messageId: string,
    call: { id: string; name: string; input: unknown },
    conversationId: string,
    emit: Emitter,
    controller: AbortController
  ): Promise<{ content: string; isError: boolean }> {
    if (getSetting<boolean>('agent.readOnly', false)) {
      return { content: '当前是只读复查模式，不调用外部 MCP 服务。', isError: true }
    }
    const parsed = parseMcpToolName(call.name)
    if (!parsed) return { content: `未知 MCP 工具：${call.name}`, isError: true }

    if (!this.isAutoApproved(call.name)) {
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

  /** git 直调（worktree 隔离用），失败返回 null 由调用方回落原地跑。 */
  private async git(args: string[], cwd: string): Promise<string | null> {
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
      const effort = getSetting<string>('agent.effort', 'high')
      const subEffort = resolveEffort(resolved.model, effort)
      const readOnly = getSetting<boolean>('agent.readOnly', false)
      const stuckCfg = getSetting<number>('agent.stuckLimit', 3)
      const stuckLimit = typeof stuckCfg === 'number' && stuckCfg > 0 ? stuckCfg : 3
      const result = await runSubagent(
        call.input,
        {
          model: resolved.model,
          providerId: resolved.providerId,
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
    tool: { name: string; approvalReason?: string },
    emit: Emitter,
    controller: AbortController
  ): Promise<ApprovalDecision> {
    const key = `${runId}:${call.id}`
    const paramHash = AgentRuntime.paramHashOf(call.input)
    const reason = tool.approvalReason ?? '该操作会修改你的本机环境。'

    emit({
      type: 'approval_required',
      runId,
      conversationId,
      messageId,
      toolUseId: call.id,
      name: call.name,
      input: call.input,
      reason
    })

    return new Promise<ApprovalDecision>((resolve) => {
      const settle = (approved: boolean): void => {
        clearTimeout(timer)
        controller.signal.removeEventListener('abort', onAbort)
        this.approvals.delete(key)
        resolve({ runId, toolUseId: call.id, approved })
      }

      const timer = setTimeout(() => {
        log.warn(`[agent] 工具 ${call.name} 的确认超时，按拒绝处理`)
        settle(false)
      }, APPROVAL_TIMEOUT_MS)

      const onAbort = (): void => settle(false)
      controller.signal.addEventListener('abort', onAbort, { once: true })

      this.approvals.set(key, {
        toolName: tool.name,
        conversationId,
        messageId,
        input: call.input,
        paramHash,
        reason,
        createdAt: Date.now(),
        settle
      })
    })
  }

  private isAutoApproved(toolName: string): boolean {
    return getSetting<string[]>(AUTO_APPROVE_KEY, []).includes(toolName)
  }

  private isWishMode(conversationId: string): boolean {
    const conversation = repo.getConversation(conversationId)
    return (
      getSetting<boolean>('agent.wish.enabled', true) &&
      (conversation?.mode ?? getSetting<string>('agent.mode', 'builder')) === 'wish'
    )
  }

  /**
   * 许愿模式的“工作区内免审批”。
   *
   * 这不是无限制放行：只对读写类工具与工作区内的命令生效；密钥库、数据库、
   * 工作区外绝对路径、目录穿越与环境变量逃逸仍会落回审批或直接被工具层拒绝。
   */
  private isWishAutoApproved(
    toolName: string,
    input: unknown,
    conversationId: string,
    workingDirectory: string | null
  ): boolean {
    if (!getSetting<boolean>('agent.wish.autoApproveWorkspace', true)) return false
    if (!this.isWishMode(conversationId)) return false
    if (!workingDirectory) return false

    if (toolName === 'write_file' || toolName === 'patch_file' || toolName === 'read_file') {
      const rawPath = (input as { path?: unknown } | null)?.path
      if (typeof rawPath !== 'string' || !rawPath.trim()) return false
        return isPathAutoApprovable(workingDirectory, rawPath)
    }

    if (toolName === 'run_command') {
      const record = (input ?? {}) as { command?: unknown; cwd?: unknown }
      if (typeof record.command !== 'string' || !record.command.trim()) return false
      const cwd = typeof record.cwd === 'string' && record.cwd.trim() ? record.cwd : workingDirectory
      const resolvedCwd = isAbsolute(cwd) ? resolve(cwd) : resolve(workingDirectory, cwd)
      if (!isPathInside(workingDirectory, resolvedCwd)) return false
        if (!isPathInsideResolved(workingDirectory, resolvedCwd)) return false
      return (
        commandStaysInsideWorkspace(record.command, resolvedCwd) &&
        !touchesPrivateData(record.command)
      )
    }

    return false
  }

  private grantAutoApprove(toolName: string): void {
    const current = getSetting<string[]>(AUTO_APPROVE_KEY, [])
    if (current.includes(toolName)) return
    setSetting(AUTO_APPROVE_KEY, [...current, toolName])
    log.info(`[agent] 已永久放行工具：${toolName}`)
  }
}

export const agentRuntime = new AgentRuntime()
