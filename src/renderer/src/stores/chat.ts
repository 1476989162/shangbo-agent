import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { shouldAutoApproveApproval } from '../components/approvalPresentation'
import { mergeLiveBlocks, shouldAdoptStreamingLeaf } from '../lib/runtimeSnapshot'
import type {
  AgentMode,
  AgentEvent,
  AutonomyLevel,
  ContentBlock,
  Conversation,
  ConversationRuntimeState,
  ImageAttachment,
  Message,
  Provider,
  TodoItem,
  UsageMode
} from '@shared/types'

export interface ApprovalRequest {
  runId: string
  toolUseId: string
  name: string
  input: unknown
  reason: string
  /** critical：硬红线，必须人工逐次确认，不允许“始终允许”。 */
  severity: 'normal' | 'critical'
  autoApprovable: boolean
}

/** 跨供应商降级通知：告诉用户实际回复来自哪家供应商/模型以及原因。 */
export interface SwitchNotice {
  fromProviderName: string
  providerName: string
  model: string
  reason: string
}

/** 限流/瞬态错误的自动重试状态，用于输入区上方的倒计时提示。 */
export interface RetryInfo {
  providerName: string
  attempt: number
  maxAttempts: number
  waitMs: number
  reason: string
}

/** 助手消息的分支导航信息（同一用户消息下的多个回复）。 */
export interface BranchInfo {
  index: number
  total: number
  prevId: string | null
  nextId: string | null
}

/**
 * 某个会话当前这一轮的信息。
 * 运行态按会话索引存，而不是全局单值——否则切走再切回来就看不到「正在运行」，
 * 且任何一个会话在跑都会锁死全局输入框。
 */
export interface ConversationRun {
  runId: string
  /** 正在流式输出的助手消息，用于渲染「生成中」状态 */
  streamingMessageId: string | null
  /** 该会话还有几个排队项 */
  queued: number
}

export type EffortLevel = 'minimal' | 'low' | 'medium' | 'high' | 'max'

export interface ProjectGroup {
  key: string
  name: string
  dir: string | null
  conversations: Conversation[]
}

function appendBlock(blocks: ContentBlock[], block: ContentBlock): void {
  const last = blocks[blocks.length - 1]
  if (block.type === 'text' && last?.type === 'text') {
    last.text += block.text
    return
  }
  if (block.type === 'reasoning' && last?.type === 'reasoning') {
    last.text += block.text
    return
  }
  blocks.push(block)
}

export const useChatStore = defineStore('chat', () => {
  const conversations = ref<Conversation[]>([])
  const activeConversationId = ref<string | null>(null)
  const messages = ref<Message[]>([])
  const activeLeafId = ref<string | null>(null)

  const providers = ref<Provider[]>([])
  const selectedProviderId = ref('')
  const selectedModel = ref('')

  // 模型可见性设置：记录被隐藏的模型标识符列表（格式为 `${providerId}::${model}` 或 `${model}`）
  const hiddenModels = ref<string[]>([])

  // 运行态按会话索引，而不是全局单值。
  // 早期用单个 activeRunId，导致切到别的会话就看不到「正在运行」，
  // 而且任何一个会话在跑都会锁死全局输入框。
  const runsByConversation = ref<Record<string, ConversationRun>>({})
  const streamingMessageId = ref<string | null>(null)
  const approval = ref<ApprovalRequest | null>(null)
  const lastError = ref<string | null>(null)
  const switchNotice = ref<SwitchNotice | null>(null)
  const retryInfo = ref<RetryInfo | null>(null)
  /** 会话 id → 最近一次任务清单；切会话后仍能看到后台会话的进度。 */
  const todosByConversation = ref<Record<string, TodoItem[]>>({})
  const todoItems = computed(() =>
    activeConversationId.value ? todosByConversation.value[activeConversationId.value] ?? [] : []
  )

  const activeRunId = computed(
    () => (activeConversationId.value ? (runsByConversation.value[activeConversationId.value]?.runId ?? null) : null)
  )
  const streamingMessageOfCurrent = computed(() =>
    activeConversationId.value
      ? (runsByConversation.value[activeConversationId.value]?.streamingMessageId ?? null)
      : null
  )
  /** 当前会话是否正在跑（含排队）——输入区据此显示「排队」而非「发送」。 */
  const isStreaming = computed(() => activeRunId.value !== null)
  /** 侧边栏列表用：某会话是否在跑，不受当前选中哪个会话影响。 */
  function isConversationRunning(conversationId: string): boolean {
    return runsByConversation.value[conversationId] !== undefined
  }
  function queuedCountOf(conversationId: string): number {
    return runsByConversation.value[conversationId]?.queued ?? 0
  }

  // 仿 Claude Desktop 现代工程特性
  /**
   * 协同 / 代码视图：只影响系统提示倾向与界面排版，不改变审批权限。
   * 落库到 ui.viewMode，重启后保持上次选择；旧版是纯内存 ref，重启就丢。
   */
  const viewMode = ref<UsageMode>('cowork')

  async function setViewMode(mode: UsageMode): Promise<void> {
    if (viewMode.value === mode) return
    viewMode.value = mode
    try {
      await window.shangbo.settings.set('ui.viewMode', mode)
    } catch (error) {
      // 持久化失败不该拦住切换，本次会话内仍然生效
      lastError.value = error instanceof Error ? error.message : String(error)
    }
  }
  const sidebarCollapsed = ref(false)
  const userName = ref('Administrator')
  const currentBranch = ref('main')
  const worktreeEnabled = ref(false)
  /**
   * 自治等级（主进程持久化）：决定工作区内/常规软风险操作是否免确认。
   * 硬红线（删 .git、删库、格式化磁盘）不受它影响，永远人工确认或直接拒绝。
   */
  const autonomy = ref<AutonomyLevel>('balanced')

  async function setAutonomy(level: AutonomyLevel): Promise<void> {
    autonomy.value = level
    await window.shangbo.settings.set('agent.autonomy', level)
  }

  function cycleAutonomy(): void {
    const order: AutonomyLevel[] = ['strict', 'balanced', 'trusted']
    const next = order[(order.indexOf(autonomy.value) + 1) % order.length]
    void setAutonomy(next)
  }

  /**
   * 渲染层「自动同意常规审批」开关。
   * 只对普通审批生效；主进程标记为 critical 的硬红线永远弹窗，不受此开关影响。
   */
  const autoApproveSoft = ref(false)

  async function setAutoApproveSoft(value: boolean): Promise<void> {
    autoApproveSoft.value = value
    await window.shangbo.settings.set('agent.autoApproveSoft', value)
  }

  function toggleAutoApproveSoft(): void {
    void setAutoApproveSoft(!autoApproveSoft.value)
  }
  const collapsedProjects = ref<Record<string, boolean>>({})

  // 思考强度 (Effort)
  const effortLevel = ref<EffortLevel>('high')

  async function setEffortLevel(level: EffortLevel): Promise<void> {
    effortLevel.value = level
    await window.shangbo.settings.set('agent.effort', level)
  }

  // TRAE 工作流：智能模式（自动判定）/ 问答 / 建造者 / 许愿
  const agentMode = ref<AgentMode>('auto')

  async function setAgentMode(mode: AgentMode): Promise<void> {
    agentMode.value = mode
    const conversationId = activeConversationId.value
    if (conversationId) {
      const updated = await window.shangbo.conversation.setMode(conversationId, mode)
      if (updated) {
        const index = conversations.value.findIndex((item) => item.id === updated.id)
        if (index >= 0) conversations.value[index] = updated
      }
    }
    await window.shangbo.settings.set('agent.mode', mode)
  }

  function cycleAgentMode(): void {
    const order: AgentMode[] = ['auto', 'builder', 'wish', 'chat']
    const next = order[(order.indexOf(agentMode.value) + 1) % order.length]
    void setAgentMode(next)
  }

  /**
   * Qoder / Cline 智能断点续写
   * 当检测到 Token 截断时，自动携带无缝上下文请求大模型接力输出剩余代码与正文
   */
  async function autoContinue(messageId?: string): Promise<void> {
    const prompt = '上一条回复由于达到单次输出 Token 上限被截断。请跳过思考过程，不要重复前面已输出的内容，紧接着刚才最后中断的地方直接输出剩余正文与代码。'
    await send(prompt)
  }

  function getModelKey(providerId: string, model: string): string {
    return `${providerId}::${model}`
  }

  function isModelHidden(providerId: string, model: string): boolean {
    const key = getModelKey(providerId, model)
    return hiddenModels.value.includes(key) || hiddenModels.value.includes(model)
  }

  async function toggleModelHidden(providerId: string, model: string): Promise<void> {
    const key = getModelKey(providerId, model)
    const exists = hiddenModels.value.indexOf(key)
    if (exists >= 0) {
      hiddenModels.value.splice(exists, 1)
    } else {
      // 同时也清理旧格式 model
      const oldIdx = hiddenModels.value.indexOf(model)
      if (oldIdx >= 0) {
        hiddenModels.value.splice(oldIdx, 1)
      } else {
        hiddenModels.value.push(key)
      }
    }
    await window.shangbo.settings.set('chat.hiddenModels', [...hiddenModels.value])
  }

  async function setModelHidden(providerId: string, model: string, hidden: boolean): Promise<void> {
    const key = getModelKey(providerId, model)
    const exists = hiddenModels.value.includes(key) || hiddenModels.value.includes(model)
    if (hidden && !exists) {
      hiddenModels.value.push(key)
      await window.shangbo.settings.set('chat.hiddenModels', [...hiddenModels.value])
    } else if (!hidden && exists) {
      hiddenModels.value = hiddenModels.value.filter((k) => k !== key && k !== model)
      await window.shangbo.settings.set('chat.hiddenModels', [...hiddenModels.value])
    }
  }

  async function showAllModels(): Promise<void> {
    hiddenModels.value = []
    await window.shangbo.settings.set('chat.hiddenModels', [])
  }

  /**
   * 批量设置某供应商下多个模型的显隐（P1供应商增强）。
   * 原来全选/全不选/只选免费是逐个 await setModelHidden，37个模型就是37次写；
   * 这里一次算好集合只写一次 settings，界面一次刷新。
   */
  async function setModelsHiddenBatch(
    providerId: string,
    models: string[],
    hidden: boolean
  ): Promise<void> {
    const keys = new Set(hiddenModels.value)
    for (const m of models) {
      const key = getModelKey(providerId, m)
      if (hidden) {
        keys.delete(m)
        keys.add(key)
      } else {
        keys.delete(key)
        keys.delete(m)
      }
    }
    hiddenModels.value = [...keys]
    await window.shangbo.settings.set('chat.hiddenModels', [...hiddenModels.value])
  }

  // 历史导航栈 (← / →)
  const historyStack = ref<string[]>([])
  const historyIndex = ref(-1)
  let navigatingHistory = false

  /**
   * 当前激活分支：从 activeLeafId 沿 parentId 回溯。
   * 消息全量都在 messages 里，切换分支只是改 activeLeafId，不重写任何数据。
   */
  const activePath = computed<Message[]>(() => {
    if (!activeLeafId.value) return []
    const byId = new Map(messages.value.map((message) => [message.id, message]))
    const path: Message[] = []
    let cursor: string | null = activeLeafId.value

    while (cursor) {
      const message: Message | undefined = byId.get(cursor)
      if (!message) break
      path.push(message)
      cursor = message.parentId
    }

    path.reverse()

    // 排队中的消息已经落库，但主进程还没为它创建助手节点——
    // 因此 activeLeafId 仍指向上一个助手消息，回溯时看不到它们。
    // 这里把「挂在路径末端、且尚无任何子回复」的用户消息补进来，
    // 否则用户提交后界面毫无反应，会以为消息没发出去。
    const replied = new Set(
      path.map((m) => m.id).filter((id) => byId.get(id)?.role === 'user')
    )
    for (const message of messages.value) {
      if (message.conversationId !== activeConversationId.value) continue
      if (message.role !== 'user') continue
      if (replied.has(message.id)) continue
      // 崩溃残留的排队消息已由主进程标记为 aborted（已取消），不再补进视图
      if (message.status === 'aborted') continue
      // 仅当它是当前路径末端的子节点时才补进来，避免把别的分支混进来
      if (message.parentId !== path[path.length - 1]?.id) continue
      path.push(message)
    }

    return path
  })

  const activeConversation = computed(
    () => conversations.value.find((item) => item.id === activeConversationId.value) ?? null
  )

  const usableProviders = computed(() =>
    providers.value.filter((provider) => provider.enabled && provider.hasApiKey)
  )

  const availableModels = computed(
    () => providers.value.find((provider) => provider.id === selectedProviderId.value)?.models ?? []
  )

  const canGoBack = computed(() => historyIndex.value > 0)
  const canGoForward = computed(() => historyIndex.value < historyStack.value.length - 1)

  function goBack(): void {
    if (!canGoBack.value) return
    navigatingHistory = true
    historyIndex.value--
    const targetId = historyStack.value[historyIndex.value]
    if (targetId) void openConversation(targetId)
    navigatingHistory = false
  }

  function goForward(): void {
    if (!canGoForward.value) return
    navigatingHistory = true
    historyIndex.value++
    const targetId = historyStack.value[historyIndex.value]
    if (targetId) void openConversation(targetId)
    navigatingHistory = false
  }

  function toggleProjectCollapse(key: string): void {
    collapsedProjects.value[key] = !collapsedProjects.value[key]
  }

  const projectGroups = computed<ProjectGroup[]>(() => {
    const map = new Map<string, ProjectGroup>()

    for (const conv of conversations.value) {
      const dir = conv.workingDir?.trim() || null
      const key = dir ? dir.toLowerCase() : '__general__'
      let group = map.get(key)
      if (!group) {
        let name = '通用项目'
        if (dir) {
          const parts = dir.split(/[\\/]/).filter(Boolean)
          name = parts[parts.length - 1] || dir
        }
        group = {
          key,
          name,
          dir,
          conversations: []
        }
        map.set(key, group)
      }
      group.conversations.push(conv)
    }

    const groups = Array.from(map.values())
    // 排序：通用项目排在最前面或最后面，按组内最新更新时间排序
    groups.sort((a, b) => {
      if (a.key === '__general__') return 1
      if (b.key === '__general__') return -1
      const aTime = a.conversations[0]?.updatedAt ?? 0
      const bTime = b.conversations[0]?.updatedAt ?? 0
      return bTime - aTime
    })
    return groups
  })

  const recentSessions = computed(() => {
    return conversations.value.slice(0, 10).map((conv) => {
      let projectName = '通用'
      if (conv.workingDir) {
        const parts = conv.workingDir.split(/[\\/]/).filter(Boolean)
        projectName = parts[parts.length - 1] || conv.workingDir
      }
      // 运行态按会话查，不再依赖「当前选中的恰好是它」
      const running = isConversationRunning(conv.id)
      const status: 'needs_input' | 'in_progress' | 'ready' = running
        ? 'in_progress'
        : approval.value && activeConversationId.value === conv.id
        ? 'needs_input'
        : 'ready'
      return {
        id: conv.id,
        title: conv.title,
        projectName,
        projectDir: conv.workingDir,
        updatedAt: conv.updatedAt,
        status
      }
    })
  })

  /* ---------------------------------------------------------------- */
  /* 事件流                                                            */
  /* ---------------------------------------------------------------- */

  function findMessage(id: string): Message | undefined {
    return messages.value.find((message) => message.id === id)
  }

  /** 写入/更新某会话的运行态。 */
  function setRun(conversationId: string, run: ConversationRun | null): void {
    const next = { ...runsByConversation.value }
    if (run) next[conversationId] = run
    else delete next[conversationId]
    runsByConversation.value = next
  }

  function getRun(conversationId: string): ConversationRun | null {
    return runsByConversation.value[conversationId] ?? null
  }

  function handleEvent(event: AgentEvent): void {
    // 事件流是全局广播的。关键点：不再因为「不是当前会话」就丢弃事件——
    // 运行态必须按会话记下，否则切走再切回来就看不出它还在跑（问题 1 的根因）。
    const isCurrent = !('conversationId' in event) || event.conversationId === activeConversationId.value

    if (!isCurrent) {
      // 后台会话：只维护它的运行态与标题时间，不碰当前视图的消息与 activeLeaf
      switch (event.type) {
        case 'run_start':
        case 'run_queued': {
          setRun(event.conversationId, {
            runId: event.runId,
            streamingMessageId: event.type === 'run_start' ? event.assistantMessageId : null,
            queued: event.type === 'run_queued' ? event.position : 0
          })
          void refreshConversations()
          break
        }
        case 'run_end': {
          if (event.queued > 0) {
            // 还有排队项：运行态不能清掉，否则切回来会以为空闲
            const current = getRun(event.conversationId)
            if (current) setRun(event.conversationId, { ...current, queued: event.queued })
          } else {
            setRun(event.conversationId, null)
          }
          void refreshConversations()
          break
        }
        case 'todo_update':
          // 后台会话也要记下任务清单：切回来后不必等一次 IPC 往返就能看到进度
          todosByConversation.value = {
            ...todosByConversation.value,
            [event.conversationId]: event.items
          }
          break
        case 'run_error':
        case 'message_done':
          void refreshConversations()
          break
      }
      return
    }

    switch (event.type) {
      case 'run_queued': {
        // 这条消息已落库、排在当前回合之后：照常显示，状态由 queued 表达
        setRun(event.conversationId, {
          runId: event.runId,
          streamingMessageId: null,
          queued: event.position
        })
        if (!findMessage(event.userMessageId)) messages.value.push(event.userMessage)
        void refreshConversations()
        break
      }

      case 'run_start': {
        setRun(event.conversationId, {
          runId: event.runId,
          streamingMessageId: event.assistantMessageId,
          queued: 0
        })

        if (!findMessage(event.userMessageId)) {
          // 直接采用主进程回传的消息实体：图片此时已带上 file 路径，
          // 渲染层能立刻显示出图片，不必自己猜内容或二次请求
          messages.value.push(event.userMessage)
        }

        if (!findMessage(event.assistantMessageId)) {
          messages.value.push({
            id: event.assistantMessageId,
            conversationId: event.conversationId,
            parentId: event.userMessageId,
            role: 'assistant',
            blocks: [],
            status: 'streaming',
            error: null,
            providerId: selectedProviderId.value || null,
            model: selectedModel.value || null,
            usage: null,
            createdAt: Date.now(),
            updatedAt: Date.now()
          })
        }

        activeLeafId.value = event.assistantMessageId
        break
      }

      case 'text_delta':
      case 'reasoning_delta': {
        const message = findMessage(event.messageId)
        if (!message) break
        if (event.type === 'text_delta') {
          appendBlock(message.blocks, { type: 'text', text: event.text })
        } else {
          appendBlock(message.blocks, { type: 'reasoning', text: event.text })
        }
        break
      }

      case 'tool_use': {
        const message = findMessage(event.messageId)
        message?.blocks.push({
          type: 'tool_use',
          id: event.toolUseId,
          name: event.name,
          input: event.input
        })
        break
      }

      case 'tool_result': {
        const message = findMessage(event.messageId)
        message?.blocks.push({
          type: 'tool_result',
          toolUseId: event.toolUseId,
          content: event.content,
          isError: event.isError
        })
        break
      }

      case 'approval_required': {
        const severity = event.severity ?? 'normal'
        // 自动同意开关只放行普通审批；critical 硬红线始终展示给你。
        if (shouldAutoApproveApproval({ severity }, autoApproveSoft.value)) {
          void window.shangbo.chat.approve({
            runId: event.runId,
            toolUseId: event.toolUseId,
            approved: true,
            alwaysAllow: false
          })
          break
        }
        approval.value = {
          runId: event.runId,
          toolUseId: event.toolUseId,
          name: event.name,
          input: event.input,
          reason: event.reason,
          severity,
          autoApprovable: event.autoApprovable ?? severity !== 'critical'
        }
        break
      }

      case 'usage': {
        const message = findMessage(event.messageId)
        if (message) message.usage = event.usage
        break
      }

      case 'todo_update': {
        // 按 conversationId 保存，后台会话的任务进度切回来后仍可见。
        todosByConversation.value = {
          ...todosByConversation.value,
          [event.conversationId]: event.items
        }
        break
      }

      case 'provider_switched': {
        switchNotice.value = {
          fromProviderName: event.fromProviderName,
          providerName: event.providerName,
          model: event.model,
          reason: event.reason
        }
        break
      }

      case 'retry_status': {
        retryInfo.value = {
          providerName: event.providerName,
          attempt: event.attempt,
          maxAttempts: event.maxAttempts,
          waitMs: event.waitMs,
          reason: event.reason
        }
        break
      }

      case 'message_done': {
        const message = findMessage(event.messageId)
        if (message) {
          message.status = event.status
          // 只在本回合的起点仍是激活叶子时才推进视图——生成期间用户切过分支的话，
          // 不把他的选择拽回新回复（与主进程对 activeLeaf 的保护保持同一语义）
          if (message.parentId && activeLeafId.value === message.parentId) {
            activeLeafId.value = event.messageId
          }
        }
        const run = getRun(event.conversationId)
        if (run) setRun(event.conversationId, { ...run, streamingMessageId: null })
        retryInfo.value = null
        void refreshConversations()
        break
      }

      case 'run_error': {
        lastError.value = event.error
        if (event.messageId) {
          const message = findMessage(event.messageId)
          if (message) {
            message.status = 'error'
            message.error = event.error
          }
        }
        break
      }

      case 'run_end': {
        // 还有排队项就不能清运行态——那样输入框会以为空闲，用户能重复排队
        if (event.queued > 0) {
          const run = getRun(event.conversationId)
          if (run) setRun(event.conversationId, { ...run, streamingMessageId: null })
        } else {
          setRun(event.conversationId, null)
        }
        approval.value = null
        retryInfo.value = null
        void refreshConversations()
        break
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* 动作                                                              */
  /* ---------------------------------------------------------------- */

  async function refreshConversations(): Promise<void> {
    conversations.value = await window.shangbo.conversation.list()
  }

  async function loadProviders(): Promise<void> {
    providers.value = await window.shangbo.provider.list()

    const settings = await window.shangbo.settings.getAll()
    selectedProviderId.value = (settings['chat.providerId'] as string) ?? ''
    selectedModel.value = (settings['chat.model'] as string) ?? ''

    // 首次使用或原选择已失效时，回落到第一个可用供应商
    const usable = usableProviders.value
    if (!usable.some((provider) => provider.id === selectedProviderId.value)) {
      const fallback = usable[0]
      selectedProviderId.value = fallback?.id ?? ''
      selectedModel.value = fallback?.models[0] ?? ''
    }
  }

  async function setTarget(providerId: string, model: string): Promise<void> {
    selectedProviderId.value = providerId
    selectedModel.value = model
    await window.shangbo.settings.set('chat.providerId', providerId)
    await window.shangbo.settings.set('chat.model', model)
  }

  /**
   * 切回会话后与主进程内存态对账。
   *
   * 这是「切走再切回来进度就没了」这个 bug 的收口点：
   * - 后台会话的流式增量事件在切走期间被丢弃，本地消息内容停在切走那一刻；
   * - 主进程只在工具批次边界落库，DB 里的正文可能比实际进度更旧；
   * - 挂起审批弹窗在 openConversation 里被清空，切回来就再也点不到。
   * 因此这里直接读主进程的权威快照，把运行态、实时正文、任务清单与审批补齐。
   */
  async function reconcileRuntime(conversationId: string): Promise<void> {
    let state: ConversationRuntimeState
    try {
      state = await window.shangbo.chat.runtimeState(conversationId)
    } catch {
      // 主进程不可用（旧版本 / 会话刚被删）时保持本地状态，不影响正常浏览
      return
    }
    // 等待期间用户可能又切走了，别把别的会话的状态写进来
    if (activeConversationId.value !== conversationId) return

    if (state.runId) {
      setRun(conversationId, {
        runId: state.runId,
        streamingMessageId: state.streamingMessageId,
        queued: state.queued
      })
    } else {
      // 主进程说它空闲：清掉可能残留的乐观运行态，否则输入框会一直显示「排队」
      setRun(conversationId, null)
    }

    // 任务清单：后台会话的进度切回来后仍要可见
    if (state.todos.length > 0) {
      todosByConversation.value = { ...todosByConversation.value, [conversationId]: state.todos }
    } else if (!state.runId) {
      const next = { ...todosByConversation.value }
      delete next[conversationId]
      todosByConversation.value = next
    }

    // 挂起审批：切走期间弹窗被清掉，这里恢复，否则这一轮会一直卡在等确认
    const pending = state.approvals[0]
    if (pending && !approval.value) {
      approval.value = {
        runId: pending.runId,
        toolUseId: pending.toolUseId,
        name: pending.name,
        input: pending.input,
        reason: pending.reason,
        severity: pending.severity,
        autoApprovable: pending.autoApprovable
      }
    }

    if (!state.streamingMessageId) return

    // 把实时正文补进那条仍在流式输出的助手消息里。
    // run_start 时主进程已把助手消息落库，openConversation 刚拉过一次，
    // 正常情况下它就在本地；万一不在（拉取与快照之间存在竞态）再补拉一次。
    let streaming = findMessage(state.streamingMessageId)
    if (!streaming) {
      const persisted = await window.shangbo.conversation.messages(conversationId)
      if (activeConversationId.value !== conversationId) return
      messages.value = persisted.messages
      streaming = messages.value.find((item) => item.id === state.streamingMessageId)
    }
    if (streaming) {
      streaming.blocks = mergeLiveBlocks(state.liveBlocks, streaming.blocks)
      streaming.status = 'streaming'
    }

    // 助手消息要等本轮结束才会被主进程指为 activeLeaf，切回来时视图路径里
    // 往往还没有它。这里按「当前叶子仍是它的父消息」补一次推进，
    // 用户在生成期间手动切过分支的话不动他的选择。
    if (streaming && shouldAdoptStreamingLeaf(state, activeLeafId.value, streaming.parentId)) {
      activeLeafId.value = state.streamingMessageId
    }
  }

  async function openConversation(id: string): Promise<void> {
    if (!navigatingHistory) {
      if (historyIndex.value < historyStack.value.length - 1) {
        historyStack.value = historyStack.value.slice(0, historyIndex.value + 1)
      }
      if (historyStack.value[historyIndex.value] !== id) {
        historyStack.value.push(id)
        historyIndex.value = historyStack.value.length - 1
      }
    }

    activeConversationId.value = id
    const conversation = conversations.value.find((c) => c.id === id)
    if (conversation?.mode) agentMode.value = conversation.mode
    const payload = await window.shangbo.conversation.messages(id)
    messages.value = payload.messages
    activeLeafId.value = payload.activeLeafId
    lastError.value = null
    approval.value = null
    switchNotice.value = null
    retryInfo.value = null

    // 关键：与主进程内存态对账。
    // 切走期间该会话的流式增量事件被丢弃、正文又只在工具批次边界落库，
    // 只读 DB 必然看到「还在跑但没有内容」。快照补齐运行态、实时内容、
    // 任务清单与挂起审批，用户切回来就能接着看到进度。
    await reconcileRuntime(id)

    // 更新分支信息
    const currentConv = conversations.value.find((c) => c.id === id)
    if (currentConv?.workingDir) {
      try {
        currentBranch.value = await window.shangbo.app.getGitBranch(currentConv.workingDir)
      } catch {
        currentBranch.value = 'main'
      }
    } else {
      currentBranch.value = 'main'
    }
  }

  async function createConversation(options?: {
    title?: string
    workingDir?: string | null
    projectId?: string | null
    mode?: AgentMode | null
  }): Promise<Conversation> {
    const conversation = await window.shangbo.conversation.create({
      title: options?.title ?? '新对话',
      workingDir: options?.workingDir ?? null,
      projectId: options?.projectId ?? null,
      mode: options?.mode ?? null
    })
    conversations.value.unshift(conversation)
    await openConversation(conversation.id)
    return conversation
  }

  async function pickFolderAndCreate(): Promise<void> {
    const dir = await window.shangbo.dialog.pickFolder()
    if (!dir) return
    const parts = dir.split(/[\\/]/).filter(Boolean)
    const name = parts[parts.length - 1] || dir
    await createConversation({
      title: `${name} 会话`,
      workingDir: dir
    })
  }

  async function removeConversation(id: string): Promise<void> {
    await window.shangbo.conversation.remove(id)
    conversations.value = conversations.value.filter((item) => item.id !== id)
    if (activeConversationId.value === id) {
      const next = conversations.value[0]
      if (next) await openConversation(next.id)
      else {
        activeConversationId.value = null
        messages.value = []
        activeLeafId.value = null
      }
    }
  }

  async function renameConversation(id: string, title: string): Promise<void> {
    const updated = await window.shangbo.conversation.rename(id, title)
    if (updated) {
      const index = conversations.value.findIndex((item) => item.id === id)
      if (index >= 0) conversations.value[index] = updated
    }
  }

  /**
   * 发送一条用户消息。会话正在跑时不再拒绝，而是交给主进程排队，
   * 用户因此可以在 AI 回复途中继续录入，提交后作为下一轮自动接力。
   */
  async function send(
    content: string,
    parentMessageId?: string | null,
    images?: ImageAttachment[]
  ): Promise<void> {
    const text = content.trim()
    const attachments = images ?? []
    if (!text && attachments.length === 0) return

    let conversationId = activeConversationId.value
    if (!conversationId) {
      const newConv = await createConversation()
      conversationId = newConv.id
    }
    if (!conversationId) return

    lastError.value = null
    // 编辑重发时以被编辑消息的父节点为锚点，生成兄弟分支；正常发送以当前叶子为锚点
    const anchor = parentMessageId !== undefined ? parentMessageId : activeLeafId.value
    switchNotice.value = null
    retryInfo.value = null

    try {
      const { runId } = await window.shangbo.chat.send({
        conversationId,
        parentMessageId: anchor,
        content: text,
        ...(attachments.length > 0 ? { images: attachments } : {}),
        providerId: selectedProviderId.value || undefined,
        model: selectedModel.value || undefined,
        viewMode: viewMode.value
      })
      // 先乐观占位：主进程很快会下发 run_start 或 run_queued 覆盖它
      setRun(conversationId, {
        runId,
        streamingMessageId: null,
        queued: isConversationRunning(conversationId) ? 1 : 0
      })
    } catch (error) {
      lastError.value = error instanceof Error ? error.message : String(error)
    }
  }

  /** 停止：只中断正在跑的那一轮，队列里排着的会继续接力执行。 */
  /** 该会话中处于排队状态（已落库但尚未开跑）的用户消息 id。 */
  function queuedUserMessageIds(conversationId: string): string[] {
    const replied = new Set<string>()
    for (const message of messages.value) {
      if (message.role === 'assistant' && message.parentId) replied.add(message.parentId)
    }
    return messages.value
      .filter(
        (m) =>
          m.conversationId === conversationId &&
          m.role === 'user' &&
          m.status !== 'aborted' &&
          !replied.has(m.id)
      )
      .map((m) => m.id)
  }

  /** 编辑一条排队中的消息：主进程改库后同步本地，避免界面与真实内容脱节。 */
  async function editQueued(userMessageId: string, content: string): Promise<boolean> {
    const conversationId = activeConversationId.value
    if (!conversationId) return false
    const ok = await window.shangbo.chat.editQueued(conversationId, userMessageId, content)
    if (!ok) {
      lastError.value = '这条消息已经开始生成，无法再编辑'
      return false
    }
    const message = findMessage(userMessageId)
    if (message) {
      // 保留图片块，只替换文本——图片是这条消息的一部分
      const images = message.blocks.filter((b) => b.type === 'image')
      message.blocks = [...images, { type: 'text', text: content.trim() }]
    }
    return true
  }

  /** 撤回一条排队中的消息：同时移除本地消息与主进程记录（含已落盘图片）。 */
  async function cancelQueued(userMessageId: string): Promise<boolean> {
    const conversationId = activeConversationId.value
    if (!conversationId) return false
    const ok = await window.shangbo.chat.cancelQueued(conversationId, userMessageId)
    if (!ok) {
      lastError.value = '撤回失败：这条消息可能已经开始生成'
      return false
    }
    const index = messages.value.findIndex((m) => m.id === userMessageId)
    if (index >= 0) messages.value.splice(index, 1)
    // 运行态里的排队计数也要跟着减，否则会一直显示「还有 1 条排队」
    const run = getRun(conversationId)
    if (run && run.queued > 0) {
      setRun(conversationId, { ...run, queued: run.queued - 1 })
    }
    return true
  }

  /**
   * 停止：中断正在跑的 + 清空该会话排队（彻底停下）。
   * 以往只 abort 单轮，队列里排着的会自动接力，看起来像"停不掉"。
   */
  async function stop(): Promise<void> {
    const conversationId = activeConversationId.value
    if (!conversationId) return
    try {
      const result = await window.shangbo.chat.stopConversation(conversationId)
      // 本地运行态立即清理，不等 run_end（看门狗兜底时 run_end 可能延迟 90s）
      setRun(conversationId, null)
      if (result.clearedQueued > 0) {
        // 被清掉的排队消息本地标记为已取消，刷新视图
        const payload = await window.shangbo.conversation.messages(conversationId)
        messages.value = payload.messages
        activeLeafId.value = payload.activeLeafId
      }
    } catch {
      // 退回单轮 abort（兼容旧主进程）
      if (!activeRunId.value) return
      await window.shangbo.chat.abort(activeRunId.value)
    }
  }

  /**
   * 排队消息转"指导当前轮"：内容注入正在跑回合的上下文，下一轮工具循环即生效。
   * 成功后本地移除该排队消息（主进程已摘队列并标记）。
   */
  async function steerQueued(userMessageId: string): Promise<boolean> {
    const conversationId = activeConversationId.value
    if (!conversationId) return false
    try {
      const ok = await window.shangbo.chat.steerQueued(conversationId, userMessageId)
      if (!ok) {
        lastError.value = '当前没有正在执行的任务，指导无处投递（消息仍在排队）'
        return false
      }
      const index = messages.value.findIndex((m) => m.id === userMessageId)
      if (index >= 0) messages.value.splice(index, 1)
      const run = getRun(conversationId)
      if (run && run.queued > 0) setRun(conversationId, { ...run, queued: run.queued - 1 })
      return true
    } catch (error) {
      lastError.value = error instanceof Error ? error.message : String(error)
      return false
    }
  }

  /** 重新生成：同样走队列，不打断正在跑的回合。 */
  async function regenerate(assistantMessageId: string): Promise<void> {
    const target = findMessage(assistantMessageId)
    if (!target) return
    lastError.value = null
    try {
      const { runId } = await window.shangbo.chat.regenerate(assistantMessageId)
      setRun(target.conversationId, {
        runId,
        streamingMessageId: null,
        queued: isConversationRunning(target.conversationId) ? 1 : 0
      })
    } catch (error) {
      lastError.value = error instanceof Error ? error.message : String(error)
    }
  }

  /** 切换分支：把激活叶子指向某个兄弟节点。 */
  async function switchBranch(leafId: string): Promise<void> {
    if (!activeConversationId.value) return
    await window.shangbo.conversation.setLeaf(activeConversationId.value, leafId)
    activeLeafId.value = leafId
  }

  /** 绑定/解绑对话的项目目录；dir 为 null 时清除绑定。 */
  async function setWorkingDir(id: string, dir: string | null): Promise<void> {
    const updated = await window.shangbo.conversation.setWorkingDir(id, dir)
    if (updated) {
      const index = conversations.value.findIndex((item) => item.id === id)
      if (index >= 0) conversations.value[index] = updated
      if (dir) {
        try {
          currentBranch.value = await window.shangbo.app.getGitBranch(dir)
        } catch {
          currentBranch.value = 'main'
        }
      } else {
        currentBranch.value = 'main'
      }
    }
  }

  /** 导出当前会话的激活分支为 Markdown。 */
  async function exportConversation(): Promise<{
    ok: boolean
    canceled?: boolean
    path?: string
    message?: string
  }> {
    if (!activeConversationId.value) return { ok: false, message: '没有可导出的会话' }
    return window.shangbo.conversation.export(activeConversationId.value)
  }

  async function decideApproval(approved: boolean, alwaysAllow = false): Promise<void> {
    const current = approval.value
    if (!current) return
    approval.value = null
    await window.shangbo.chat.approve({
      runId: current.runId,
      toolUseId: current.toolUseId,
      approved,
      alwaysAllow
    })
  }

  function dismissError(): void {
    lastError.value = null
  }

  function dismissSwitchNotice(): void {
    switchNotice.value = null
  }

  async function bootstrap(): Promise<void> {
    window.shangbo.chat.onEvent(handleEvent)
    await Promise.all([loadProviders(), refreshConversations()])
    try {
      const info = await window.shangbo.app.info()
      if (info.username) userName.value = info.username
      const settings = await window.shangbo.settings.getAll()
      const effort = settings['agent.effort'] as EffortLevel | undefined
      if (effort) effortLevel.value = effort
      const mode = settings['agent.mode'] as AgentMode | undefined
      if (mode) agentMode.value = mode
      const savedAutonomy = settings['agent.autonomy'] as AutonomyLevel | undefined
      if (savedAutonomy) autonomy.value = savedAutonomy
      autoApproveSoft.value = (settings['agent.autoApproveSoft'] as boolean) ?? false
      const savedHidden = settings['chat.hiddenModels'] as string[] | undefined
      if (Array.isArray(savedHidden)) hiddenModels.value = savedHidden
      const savedViewMode = settings['ui.viewMode'] as UsageMode | undefined
      if (savedViewMode === 'cowork' || savedViewMode === 'code') viewMode.value = savedViewMode
    } catch {
      // 忽略
    }
    const first = conversations.value[0]
    if (first) await openConversation(first.id)
  }

  return {
    conversations,
    activeConversationId,
    messages,
    activeLeafId,
    activePath,
    providers,
    selectedProviderId,
    selectedModel,
    hiddenModels,
    isModelHidden,
    toggleModelHidden,
    setModelHidden,
    showAllModels,
    setModelsHiddenBatch,
    availableModels,
    usableProviders,
    activeRunId,
    runsByConversation,
    streamingMessageOfCurrent,
    isConversationRunning,
    queuedCountOf,
    approval,
    lastError,
    switchNotice,
    retryInfo,
    todoItems,
    isStreaming,
    activeConversation,
    viewMode,
    setViewMode,
    sidebarCollapsed,
    userName,
    currentBranch,
    worktreeEnabled,
    autonomy,
    setAutonomy,
    cycleAutonomy,
    autoApproveSoft,
    setAutoApproveSoft,
    toggleAutoApproveSoft,
    collapsedProjects,
    effortLevel,
    agentMode,
    setAgentMode,
    cycleAgentMode,
    autoContinue,
    canGoBack,
    canGoForward,
    projectGroups,
    recentSessions,
    setEffortLevel,
    goBack,
    goForward,
    toggleProjectCollapse,
    pickFolderAndCreate,
    bootstrap,
    refreshConversations,
    loadProviders,
    setTarget,
    openConversation,
    createConversation,
    removeConversation,
    renameConversation,
    send,
    stop,
    queuedUserMessageIds,
    editQueued,
    cancelQueued,
    steerQueued,
    regenerate,
    switchBranch,
    setWorkingDir,
    exportConversation,
    decideApproval,
    dismissError,
    dismissSwitchNotice
  }
})
