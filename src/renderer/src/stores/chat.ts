import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import type { AgentEvent, ContentBlock, Conversation, Message, Provider } from '@shared/types'

export interface ApprovalRequest {
  runId: string
  toolUseId: string
  name: string
  input: unknown
  reason: string
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

  const activeRunId = ref<string | null>(null)
  const streamingMessageId = ref<string | null>(null)
  const approval = ref<ApprovalRequest | null>(null)
  const lastError = ref<string | null>(null)
  const switchNotice = ref<SwitchNotice | null>(null)
  const retryInfo = ref<RetryInfo | null>(null)

  // 仿 Claude Desktop 现代工程特性
  const viewMode = ref<'cowork' | 'code'>('cowork')
  const sidebarCollapsed = ref(false)
  const userName = ref('Administrator')
  const currentBranch = ref('main')
  const worktreeEnabled = ref(false)
  const bypassPermissions = ref(false)
  const collapsedProjects = ref<Record<string, boolean>>({})

  // 思考强度 (Effort)
  const effortLevel = ref<EffortLevel>('high')

  async function setEffortLevel(level: EffortLevel): Promise<void> {
    effortLevel.value = level
    await window.shangbo.settings.set('agent.effort', level)
  }

  // TRAE 工作流：双模式 (问答 Chat vs 建造者 Builder)
  const agentMode = ref<'builder' | 'chat'>('builder')

  async function setAgentMode(mode: 'builder' | 'chat'): Promise<void> {
    agentMode.value = mode
    await window.shangbo.settings.set('agent.mode', mode)
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

  // 历史导航栈 (← / →)
  const historyStack = ref<string[]>([])
  const historyIndex = ref(-1)
  let navigatingHistory = false

  /** 发送前记下用户消息的落点，用于在 run_start 事件到达时补出本地消息。 */
  let pendingSend: { parentId: string | null; content: string } | null = null

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

    return path.reverse()
  })

  const isStreaming = computed(() => activeRunId.value !== null)

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
      const isCurrentStreaming = activeRunId.value !== null && activeConversationId.value === conv.id
      const status: 'needs_input' | 'in_progress' | 'ready' = isCurrentStreaming
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

  function handleEvent(event: AgentEvent): void {
    // 事件流是全局广播的：只处理当前正在查看的会话，
    // 否则后台会话的流式输出会污染当前会话的消息列表和 activeLeaf。
    if ('conversationId' in event && event.conversationId !== activeConversationId.value) {
      // message_done / run_end / run_error 仍需刷新会话列表（标题、时间可能已更新）
      if (
        event.type === 'message_done' ||
        event.type === 'run_end' ||
        event.type === 'run_error'
      ) {
        void refreshConversations()
      }
      if (event.type === 'run_end' && event.runId === activeRunId.value) {
        activeRunId.value = null
        streamingMessageId.value = null
        approval.value = null
      }
      return
    }

    switch (event.type) {
      case 'run_start': {
        activeRunId.value = event.runId
        streamingMessageId.value = event.assistantMessageId

        if (pendingSend && !findMessage(event.userMessageId)) {
          messages.value.push({
            id: event.userMessageId,
            conversationId: event.conversationId,
            parentId: pendingSend.parentId,
            role: 'user',
            blocks: [{ type: 'text', text: pendingSend.content }],
            status: 'done',
            error: null,
            providerId: null,
            model: null,
            usage: null,
            createdAt: Date.now(),
            updatedAt: Date.now()
          })
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
        pendingSend = null
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
        if (bypassPermissions.value) {
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
          reason: event.reason
        }
        break
      }

      case 'usage': {
        const message = findMessage(event.messageId)
        if (message) message.usage = event.usage
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
        streamingMessageId.value = null
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
        activeRunId.value = null
        streamingMessageId.value = null
        approval.value = null
        retryInfo.value = null
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
    const payload = await window.shangbo.conversation.messages(id)
    messages.value = payload.messages
    activeLeafId.value = payload.activeLeafId
    lastError.value = null
    approval.value = null
    switchNotice.value = null
    retryInfo.value = null

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
  }): Promise<Conversation> {
    const conversation = await window.shangbo.conversation.create({
      title: options?.title ?? '新对话',
      workingDir: options?.workingDir ?? null,
      projectId: options?.projectId ?? null
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

  async function send(content: string, parentMessageId?: string | null): Promise<void> {
    const text = content.trim()
    if (!text || isStreaming.value) return

    let conversationId = activeConversationId.value
    if (!conversationId) {
      const newConv = await createConversation()
      conversationId = newConv.id
    }
    if (!conversationId) return

    lastError.value = null
    // 编辑重发时以被编辑消息的父节点为锚点，生成兄弟分支；正常发送以当前叶子为锚点
    const anchor = parentMessageId !== undefined ? parentMessageId : activeLeafId.value
    pendingSend = { parentId: anchor, content: text }
    switchNotice.value = null
    retryInfo.value = null

    try {
      const { runId } = await window.shangbo.chat.send({
        conversationId,
        parentMessageId: anchor,
        content: text,
        providerId: selectedProviderId.value || undefined,
        model: selectedModel.value || undefined
      })
      activeRunId.value = runId
    } catch (error) {
      pendingSend = null
      lastError.value = error instanceof Error ? error.message : String(error)
    }
  }

  async function stop(): Promise<void> {
    if (!activeRunId.value) return
    await window.shangbo.chat.abort(activeRunId.value)
  }

  async function regenerate(assistantMessageId: string): Promise<void> {
    if (isStreaming.value) return
    lastError.value = null
    pendingSend = null
    try {
      const { runId } = await window.shangbo.chat.regenerate(assistantMessageId)
      activeRunId.value = runId
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
      const mode = settings['agent.mode'] as 'builder' | 'chat' | undefined
      if (mode) agentMode.value = mode
      const savedHidden = settings['chat.hiddenModels'] as string[] | undefined
      if (Array.isArray(savedHidden)) hiddenModels.value = savedHidden
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
    availableModels,
    usableProviders,
    activeRunId,
    streamingMessageId,
    approval,
    lastError,
    switchNotice,
    retryInfo,
    isStreaming,
    activeConversation,
    viewMode,
    sidebarCollapsed,
    userName,
    currentBranch,
    worktreeEnabled,
    bypassPermissions,
    collapsedProjects,
    effortLevel,
    agentMode,
    setAgentMode,
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
    regenerate,
    switchBranch,
    setWorkingDir,
    exportConversation,
    decideApproval,
    dismissError,
    dismissSwitchNotice
  }
})