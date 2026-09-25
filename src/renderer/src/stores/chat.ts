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

  const activeRunId = ref<string | null>(null)
  const streamingMessageId = ref<string | null>(null)
  const approval = ref<ApprovalRequest | null>(null)
  const lastError = ref<string | null>(null)

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

    return path
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

  /* ---------------------------------------------------------------- */
  /* 事件流                                                            */
  /* ---------------------------------------------------------------- */

  function findMessage(id: string): Message | undefined {
    return messages.value.find((message) => message.id === id)
  }

  function handleEvent(event: AgentEvent): void {
    switch (event.type) {
      case 'run_start': {
        activeRunId.value = event.runId
        streamingMessageId.value = event.assistantMessageId

        const conversationId = activeConversationId.value ?? ''

        if (pendingSend && !findMessage(event.userMessageId)) {
          messages.value.push({
            id: event.userMessageId,
            conversationId,
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
            conversationId,
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

      case 'message_done': {
        const message = findMessage(event.messageId)
        if (message) message.status = event.status
        activeLeafId.value = event.messageId
        streamingMessageId.value = null
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
    activeConversationId.value = id
    const payload = await window.shangbo.conversation.messages(id)
    messages.value = payload.messages
    activeLeafId.value = payload.activeLeafId
    lastError.value = null
    approval.value = null
  }

  async function createConversation(): Promise<void> {
    const conversation = await window.shangbo.conversation.create()
    conversations.value.unshift(conversation)
    activeConversationId.value = conversation.id
    messages.value = []
    activeLeafId.value = null
    lastError.value = null
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

  async function send(content: string): Promise<void> {
    const text = content.trim()
    if (!text || isStreaming.value) return

    let conversationId = activeConversationId.value
    if (!conversationId) {
      await createConversation()
      conversationId = activeConversationId.value
    }
    if (!conversationId) return

    lastError.value = null
    pendingSend = { parentId: activeLeafId.value, content: text }

    try {
      const { runId } = await window.shangbo.chat.send({
        conversationId,
        parentMessageId: activeLeafId.value,
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

  async function bootstrap(): Promise<void> {
    window.shangbo.chat.onEvent(handleEvent)
    await Promise.all([loadProviders(), refreshConversations()])
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
    availableModels,
    usableProviders,
    activeRunId,
    streamingMessageId,
    approval,
    lastError,
    isStreaming,
    activeConversation,
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
    decideApproval,
    dismissError
  }
})