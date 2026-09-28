import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import log from 'electron-log/main'
import * as repo from '../db/repo'
import { getSetting, setSetting } from '../settings'
import { auditCommandSecurity, toolRegistry } from '../tools'
import { streamWithFallback } from '../providers/gateway'
import { routingOrder } from '../providers/store'
import { buildContext, estimateTokens, hydrateContextImages, toLLMMessages } from './context'
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
  settle: (approved: boolean) => void
}

interface ActiveRun {
  controller: AbortController
  conversationId: string
}

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
      this.runs.delete(runId)
      // 推进队列前先记下还剩几项，这样 run_end 里的 queued 是「不含本轮」的准确值
      const queued = this.queueLength(conversationId)
      this.advanceQueue(conversationId)
      emit({ type: 'run_end', runId, conversationId, queued })
    }
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
      conversationId: item.conversationId
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
    const userMessage = this.persistUserMessage(payload)
    const busy = this.isRunning(payload.conversationId)
    const runId = randomUUID()

    return this.enqueue({
      runId,
      conversationId: payload.conversationId,
      userMessageId: userMessage.id,
      payload,
      emit,
      start: async (self) => {
        const controller = this.runs.get(runId)?.controller ?? new AbortController()
        // 读 self.payload 而非闭包捕获的入参：编辑排队消息改的是队列项，
        // 捕获入参会让编辑完全不生效
        await this.executeSend(runId, self.payload, userMessage, emit, controller)
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
    return this.enqueue({
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
    })
  }

  /** 停止：只中断正在跑的那一轮，队列里排着的保留（用户没说要丢弃）。 */
  abort(runId: string): void {
    this.runs.get(runId)?.controller.abort()
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

  /** 渲染进程回传的权限确认结果。 */
  decide(decision: ApprovalDecision): void {
    const key = `${decision.runId}:${decision.toolUseId}`
    const pending = this.approvals.get(key)
    if (!pending) return
    if (decision.approved && decision.alwaysAllow) {
      this.grantAutoApprove(pending.toolName)
    }
    pending.settle(decision.approved)
  }

  /* ---------------------------------------------------------------- */

  /** 落库一条用户消息并返回实体。排队与开跑共用，让 UI 在提交瞬间就能看到这条消息。 */
  private persistUserMessage(payload: AgentSendRequest): Message {
    const conversation = repo.getConversation(payload.conversationId)
    if (!conversation) throw new Error('会话不存在或已被删除')

    const parentId = payload.parentMessageId ?? repo.getActiveLeaf(conversation.id)
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
      blocks
    })
    repo.setActiveLeaf(conversation.id, userMessage.id)

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
   * 「规划 → 调用工具 → 观察 → 再规划」主循环。
   * 一条助手消息承载整轮的全部内容块（文本、工具调用、工具结果），
   * 这样界面上呈现为一个可折叠的助手回合，回传历史时再拆回协议要求的角色序列。
   */
  private async runModel(
    runId: string,
    conversation: Pick<Conversation, 'id' | 'systemPrompt' | 'workingDir'>,
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
    let requestCount = 0
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

    const agentMode = getSetting<string>('agent.mode', 'builder')
    if (agentMode === 'builder') {
      system += '\n\n【建造者】改代码必须调工具落盘、一次一个文件；优先 patch_file；写完有测试就自验。独立子任务（分模块侦察、独立文件改造）可 spawn_subagent 并行派，最后由你汇总结论。'
    } else {
      system += '\n\n【问答】给思路和核心片段即可。'
    }
    if (pluginDirectives.length > 0) system += `\n已启用技能：${pluginDirectives.join(' ')}`

    // 方法论注入：本轮是复查任务才给打法，平时不打扰。
    const triggerMessage = repo.getMessage(userMessage.id)
    if (triggerMessage && matchReviewIntent(textOf(triggerMessage.blocks))) {
      system += REVIEW_PLAYBOOK
    }

    const budget = getSetting<number>(BUDGET_KEY, DEFAULT_BUDGET_TOKENS)
    // Codex 式沙箱档：只读复查时模型根本看不到写工具，比逐个审批更彻底。
    const readOnly = getSetting<boolean>('agent.readOnly', false)
    if (readOnly) system += '\n\n【只读复查】只允许读取与搜索文件，禁止写入、修改与执行命令；输出问题清单即可，不要尝试改动。'
    // 保险丝灵敏度：连续几次打转就停，默认 3。
    const stuckCfg = getSetting<number>('agent.stuckLimit', 3)
    const effectiveStuckLimit = typeof stuckCfg === 'number' && stuckCfg > 0 ? stuckCfg : 3
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

    try {
      // 无步数上限：循环到模型不再调工具为止；防打转只靠行为保险丝（loopGuard），
      // 不靠数步数。想停随时点「停止」。
      for (;;) {
        if (controller.signal.aborted) {
          status = 'aborted'
          break
        }

        const persisted = repo.getActivePath(conversation.id)
        const context = buildContext(persisted, { system, budgetTokens: budget })
        // 裁剪完成后才读图片：被裁掉的历史轮次里的图永远不进内存
        await hydrateContextImages(context)
        // 裁剪发生时告诉模型，避免它以为看到了全部历史而编造。
        const effectiveSystem =
          context.omittedTurns > 0
            ? `${system}\n\n（最早 ${context.omittedTurns} 轮历史已省略，如需请向用户确认。）`
            : system

        // 持久化路径 + 本轮尚未落库的累积块，拼出这次请求的完整消息序列
        const inMemory: Message[] = [{ ...assistantMessage, blocks: [...blocks], role: 'assistant' }]
        const messages: LLMMessage[] = [...context.messages, ...toLLMMessages(inMemory)]

        const toolUses: { id: string; name: string; input: unknown }[] = []

        let stopReason = 'stop'
        for await (const chunk of streamWithFallback(
          {
            model: resolved.model,
            system: effectiveSystem,
            messages,
            tools: offeredSchemas,
            maxTokens: resolvedEffort.maxTokens,
            reasoningEffort: resolvedEffort.reasoningEffort
          },
          controller.signal,
          resolved.providerId
        )) {
          if (chunk.type === 'text') {
            appendBlock(blocks, { type: 'text', text: chunk.text })
            emit({
              type: 'text_delta',
              runId,
              conversationId: conversation.id,
              messageId: assistantMessage.id,
              text: chunk.text
            })
          } else if (chunk.type === 'reasoning') {
            appendBlock(blocks, { type: 'reasoning', text: chunk.text })
            emit({
              type: 'reasoning_delta',
              runId,
              conversationId: conversation.id,
              messageId: assistantMessage.id,
              text: chunk.text
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
            onNotify
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
            usage: this.composeUsage(lastUsage, turnPromptTokens, turnCompletionTokens, requestCount, stopReason)
          })
          break
        }

        // 阶段性落库，进程意外退出时仍能看到已完成的部分
        repo.updateMessage(assistantMessage.id, {
          blocks: [...blocks],
          usage: this.composeUsage(lastUsage, turnPromptTokens, turnCompletionTokens, requestCount, stopReason)
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
          const persistedNow = repo.getActivePath(conversation.id)
          const contextNow = buildContext(persistedNow, { system, budgetTokens: budget })
          await hydrateContextImages(contextNow)
          const inMemoryNow: Message[] = [{ ...assistantMessage, blocks: [...blocks], role: 'assistant' }]
          const continued: { id: string; name: string; input: unknown }[] = []
          let contStop = 'stop'
          // 续写沿用实际服务模型的档位映射，避免降级后用错上限。
          const contEffort = resolveEffort(servedModel, effort)
          for await (const chunk of streamWithFallback(
            {
              model: servedModel,
              system: system + SKIP_THINKING_SUFFIX,
              messages: [...contextNow.messages, ...toLLMMessages(inMemoryNow)],
              tools: offeredSchemas,
              maxTokens: contEffort.maxTokens,
              reasoningEffort: contEffort.reasoningEffort
            },
            controller.signal,
            servedProviderId
          )) {
            if (chunk.type === 'text') {
              appendBlock(blocks, { type: 'text', text: chunk.text })
              emit({ type: 'text_delta', runId, conversationId: conversation.id, messageId: assistantMessage.id, text: chunk.text })
            } else if (chunk.type === 'reasoning') {
              appendBlock(blocks, { type: 'reasoning', text: chunk.text })
              emit({ type: 'reasoning_delta', runId, conversationId: conversation.id, messageId: assistantMessage.id, text: chunk.text })
            } else if (chunk.type === 'tool_use') {
              continued.push({ id: chunk.id, name: chunk.name, input: chunk.input })
            } else if (chunk.type === 'stop') {
              contStop = chunk.reason
            } else if (chunk.type === 'usage') {
              lastUsage = chunk.usage
              turnPromptTokens += chunk.usage.promptTokens
              turnCompletionTokens += chunk.usage.completionTokens
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
            const result = await this.invokeTool(runId, assistantMessage.id, call, conversation.id, conversation.workingDir, emit, controller, onNotify)
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
              usage: this.composeUsage(lastUsage, turnPromptTokens, turnCompletionTokens, requestCount, contStop)
            })
            break
          }
          finalStopReason = contStop
          const gotText = blocks.some((b) => b.type === 'text' && b.text.trim().length > 0)
          truncatedByThinking = (contStop === 'length' || contStop === 'max_tokens') && !gotText
          repo.updateMessage(assistantMessage.id, {
            blocks: [...blocks],
            usage: this.composeUsage(lastUsage, turnPromptTokens, turnCompletionTokens, requestCount, contStop)
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
      usage: this.composeUsage(lastUsage, turnPromptTokens, turnCompletionTokens, requestCount, finalStopReason),
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
    finishReason?: string
  ): Usage | null {
    if (!lastUsage) {
      return finishReason ? { promptTokens: 0, completionTokens: 0, finishReason } : null
    }
    return {
      ...lastUsage,
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
    onNotify?: (text: string) => void
  ): Promise<ToolOutcome> {
    // 子智能体派发：不走静态注册表，直接进父回合的有界子循环。
    if (call.name === SPAWN_TOOL_NAME) {
      return this.runSubagentCall(runId, messageId, call, conversationId, workingDirectory, emit, controller, onNotify)
    }
    // MCP 远端工具：mcp__服务__工具，走服务进程转发。
    if (call.name.startsWith('mcp__')) {
      return this.invokeMcpTool(runId, messageId, call, conversationId, emit, controller)
    }
    const tool = toolRegistry.get(call.name)
    if (!tool) {
      return { content: `未知工具：${call.name}。可用工具：${toolRegistry.all().map((t) => t.name).join('、')}`, isError: true }
    }

    // 只读复查兜底：即使模型私自拼出写工具名，也不执行。
    if (getSetting<boolean>('agent.readOnly', false) && tool.requiresApproval) {
      return { content: '当前是只读复查模式，不执行写入与命令操作。如需修改请先关闭只读模式。', isError: true }
    }

    // Freebuff 安全护栏审计：针对命令执行和高危操作进行深度规则扫描
    let isSecurityCritical = false
    let securityAuditReason = ''
    if (call.name === 'run_command' && typeof (call.input as Record<string, unknown>)?.command === 'string') {
      const audit = auditCommandSecurity(String((call.input as Record<string, unknown>).command))
      if (audit.isDangerous) {
        isSecurityCritical = true
        securityAuditReason = audit.reason || '【Freebuff 安全护栏拦截】检测到高危系统级操作！'
      }
    }

    const needsApproval = (tool.requiresApproval && !this.isAutoApproved(call.name)) || isSecurityCritical
    if (needsApproval) {
      const decision = await this.requestApproval(
        runId,
        conversationId,
        messageId,
        call,
        {
          name: tool.name,
          approvalReason: isSecurityCritical ? securityAuditReason : tool.approvalReason
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

    // Computer Use 总闸：设置里关了就当不存在（清单过滤 + 这里兜底）。
    if (call.name.startsWith('computer_') && !getSetting<boolean>('agent.computerUse', true)) {
      return { content: '电脑控制未启用，请到设置里打开后再试。', isError: true }
    }

    try {
      const raw = await tool.execute(call.input, {
        conversationId,
        workingDirectory,
        signal: controller.signal
      })
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
    onNotify?: (text: string) => void
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

    emit({
      type: 'approval_required',
      runId,
      conversationId,
      messageId,
      toolUseId: call.id,
      name: call.name,
      input: call.input,
      reason: tool.approvalReason ?? '该操作会修改你的本机环境。'
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

      this.approvals.set(key, { toolName: tool.name, settle })
    })
  }

  private isAutoApproved(toolName: string): boolean {
    return getSetting<string[]>(AUTO_APPROVE_KEY, []).includes(toolName)
  }

  private grantAutoApprove(toolName: string): void {
    const current = getSetting<string[]>(AUTO_APPROVE_KEY, [])
    if (current.includes(toolName)) return
    setSetting(AUTO_APPROVE_KEY, [...current, toolName])
    log.info(`[agent] 已永久放行工具：${toolName}`)
  }
}

export const agentRuntime = new AgentRuntime()