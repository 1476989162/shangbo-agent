import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import type { AgentEvent, Conversation, Message } from '@shared/types'
import { useChatStore } from './chat'

type EventHandler = (event: AgentEvent) => void

function makeConversation(id = 'c1'): Conversation {
  return {
    id,
    title: 'test',
    projectId: null,
    workingDir: null,
    providerId: null,
    model: null,
    systemPrompt: null,
    mode: null,
    createdAt: 1,
    updatedAt: 2,
    archivedAt: null
  }
}

function makeUserMessage(id = 'u1', conversationId = 'c1'): Message {
  return {
    id,
    conversationId,
    parentId: null,
    role: 'user',
    blocks: [{ type: 'text', text: 'hi' }],
    status: 'done',
    error: null,
    providerId: null,
    model: null,
    usage: null,
    createdAt: 1,
    updatedAt: 1
  }
}

interface MockHandles {
  captured: () => EventHandler | null
  chatApprove: ReturnType<typeof vi.fn>
  conversationSetLeaf: ReturnType<typeof vi.fn>
  chatOnEvent: ReturnType<typeof vi.fn>
  chatOffEvent: ReturnType<typeof vi.fn>
}

function installMock(options?: {
  settings?: Record<string, unknown>
  conversations?: Conversation[]
  messages?: Message[]
  activeLeafId?: string | null
}): MockHandles {
  let captured: EventHandler | null = null
  const chatOnEvent = vi.fn((handler: EventHandler) => {
    captured = handler
  })
  const chatOffEvent = vi.fn()
  const chatApprove = vi.fn(async () => true)
  const conversationSetLeaf = vi.fn(async () => true)
  const settings = options?.settings ?? {}
  const conversations = options?.conversations ?? [makeConversation()]
  const messages = options?.messages ?? []
  const activeLeafId = options?.activeLeafId ?? null

  const shangboMock = {
    conversation: {
      list: vi.fn(async () => conversations),
      create: vi.fn(),
      rename: vi.fn(),
      remove: vi.fn(),
      messages: vi.fn(async () => ({ messages, activeLeafId })),
      setLeaf: conversationSetLeaf,
      setWorkingDir: vi.fn(),
      setMode: vi.fn(),
      export: vi.fn()
    },
    chat: {
      send: vi.fn(),
      abort: vi.fn(),
      stopConversation: vi.fn(),
      steerQueued: vi.fn(),
      approve: chatApprove,
      regenerate: vi.fn(),
      editQueued: vi.fn(),
      cancelQueued: vi.fn(),
      runtimeState: vi.fn(async () => ({
        conversationId: conversations[0]?.id ?? 'c1',
        runId: null,
        streamingMessageId: null,
        queued: 0,
        todos: [],
        liveBlocks: [],
        approvals: []
      })),
      onEvent: chatOnEvent,
      offEvent: chatOffEvent
    },
    provider: {
      list: vi.fn(async () => []),
      upsert: vi.fn(),
      remove: vi.fn(),
      test: vi.fn(),
      fetchModels: vi.fn(),
      autopilotProbe: vi.fn(),
      autopilotVerify: vi.fn()
    },
    settings: {
      getAll: vi.fn(async () => settings),
      set: vi.fn(async () => true)
    },
    app: {
      info: vi.fn(async () => ({ username: 'Administrator' })),
      contextStatics: vi.fn(),
      getGitBranch: vi.fn(async () => ''),
      getGitDiff: vi.fn(),
      getGitStatus: vi.fn(),
      toggleDevTools: vi.fn(),
      openPath: vi.fn(),
      execCommand: vi.fn(),
      setWindowTheme: vi.fn(),
      hideWindow: vi.fn(),
      quit: vi.fn()
    },
    dialog: {
      pickFolder: vi.fn()
    }
  } as unknown as Record<string, unknown>
  const g = globalThis as unknown as { window?: Record<string, unknown> }
  if (!g.window) {
    g.window = {}
  }
  g.window.shangbo = shangboMock
  return {
    captured: () => captured,
    chatApprove,
    conversationSetLeaf,
    chatOnEvent,
    chatOffEvent
  }
}

beforeEach(() => {
  setActivePinia(createPinia())
})

describe('chat store bootstrap', () => {
  it('恢复持久化设置并防叠监听，dispose 幂等', async () => {
    const handles = installMock({
      settings: {
        'agent.effort': 'low',
        'agent.mode': 'builder',
        'agent.autonomy': 'trusted',
        'agent.autoApproveSoft': true,
        'agent.worktree': true,
        'agent.safety.actionClassifierLlm': true,
        'agent.safety.injectionLlm': true,
        'ui.viewMode': 'code'
      }
    })
    const store = useChatStore()
    await store.bootstrap()

    expect(store.effortLevel).toBe('low')
    expect(store.agentMode).toBe('builder')
    expect(store.autonomy).toBe('trusted')
    expect(store.autoApproveSoft).toBe(true)
    expect(store.worktreeEnabled).toBe(true)
    expect(store.actionClassifierLlm).toBe(true)
    expect(store.injectionLlm).toBe(true)
    expect(store.viewMode).toBe('code')
    expect(handles.chatOnEvent).toHaveBeenCalledTimes(1)
    expect(handles.chatOffEvent).not.toHaveBeenCalled()

    // 重复调用先退订再订阅，避免叠回调
    await store.bootstrap()
    expect(handles.chatOffEvent).toHaveBeenCalledTimes(1)
    expect(handles.chatOnEvent).toHaveBeenCalledTimes(2)

    // dispose 幂等：第二次调用不再触发 offEvent
    store.disposeChatListener()
    expect(handles.chatOffEvent).toHaveBeenCalledTimes(2)
    store.disposeChatListener()
    expect(handles.chatOffEvent).toHaveBeenCalledTimes(2)
  })
})

describe('chat store 事件流转', () => {
  it('text/reasoning/tool/result/message_done/run_end/run_error 更新流式消息与运行态', async () => {
    const handles = installMock()
    const store = useChatStore()
    await store.bootstrap()
    const emit = handles.captured()
    expect(emit).not.toBeNull()
    const onEvent = emit as EventHandler

    onEvent({
      type: 'run_start',
      runId: 'r1',
      conversationId: 'c1',
      userMessageId: 'u1',
      assistantMessageId: 'a1',
      userMessage: makeUserMessage('u1', 'c1')
    })
    expect(store.isStreaming).toBe(true)
    expect(store.activeLeafId).toBe('a1')

    onEvent({ type: 'text_delta', runId: 'r1', conversationId: 'c1', messageId: 'a1', text: 'hello ' })
    onEvent({ type: 'text_delta', runId: 'r1', conversationId: 'c1', messageId: 'a1', text: 'world' })
    onEvent({ type: 'reasoning_delta', runId: 'r1', conversationId: 'c1', messageId: 'a1', text: '思考中' })
    const streaming = store.messages.find((m) => m.id === 'a1')
    expect(streaming?.blocks).toEqual([
      { type: 'text', text: 'hello world' },
      { type: 'reasoning', text: '思考中' }
    ])

    onEvent({
      type: 'tool_use',
      runId: 'r1',
      conversationId: 'c1',
      messageId: 'a1',
      toolUseId: 't1',
      name: 'read',
      input: { path: 'a.txt' }
    })
    onEvent({
      type: 'tool_result',
      runId: 'r1',
      conversationId: 'c1',
      messageId: 'a1',
      toolUseId: 't1',
      content: 'ok',
      isError: false
    })
    expect(streaming?.blocks.some((b) => b.type === 'tool_use')).toBe(true)
    expect(streaming?.blocks.some((b) => b.type === 'tool_result')).toBe(true)

    onEvent({ type: 'message_done', runId: 'r1', conversationId: 'c1', messageId: 'a1', status: 'done' })
    expect(streaming?.status).toBe('done')
    expect(store.runsByConversation.c1?.streamingMessageId).toBeNull()

    onEvent({ type: 'run_end', runId: 'r1', conversationId: 'c1', queued: 0 })
    expect(store.isStreaming).toBe(false)
    expect(store.runsByConversation.c1).toBeUndefined()

    // 错误路径：新开一轮后报错
    onEvent({
      type: 'run_start',
      runId: 'r2',
      conversationId: 'c1',
      userMessageId: 'u2',
      assistantMessageId: 'a2',
      userMessage: makeUserMessage('u2', 'c1')
    })
    onEvent({ type: 'run_error', runId: 'r2', conversationId: 'c1', messageId: 'a2', error: 'boom' })
    expect(store.lastError).toBe('boom')
    expect(store.messages.find((m) => m.id === 'a2')?.status).toBe('error')
  })
})

describe('chat store 审批与分支', () => {
  it('approval_required 写入审批，decideApproval 清空并调用 chat.approve', async () => {
    const handles = installMock()
    const store = useChatStore()
    await store.bootstrap()
    const onEvent = handles.captured() as EventHandler

    onEvent({
      type: 'approval_required',
      runId: 'r1',
      conversationId: 'c1',
      messageId: 'a1',
      toolUseId: 't1',
      name: 'run_command',
      input: { command: 'npm test' },
      reason: '需要确认',
      severity: 'normal',
      autoApprovable: true
    })
    expect(store.approval?.toolUseId).toBe('t1')

    await store.decideApproval(false)
    expect(store.approval).toBeNull()
    expect(handles.chatApprove).toHaveBeenCalledWith({
      runId: 'r1',
      toolUseId: 't1',
      approved: false,
      alwaysAllow: false
    })
  })

  it('自动同意只放行普通审批，硬红线仍弹窗；switchBranch 更新叶子并调 setLeaf', async () => {
    const handles = installMock()
    const store = useChatStore()
    await store.bootstrap()
    const onEvent = handles.captured() as EventHandler
    await store.setAutoApproveSoft(true)

    // 普通审批被自动放行，不写入 approval
    onEvent({
      type: 'approval_required',
      runId: 'r1',
      conversationId: 'c1',
      messageId: 'a1',
      toolUseId: 't-auto',
      name: 'read',
      input: {},
      reason: '普通读文件',
      severity: 'normal',
      autoApprovable: true
    })
    expect(store.approval).toBeNull()
    expect(handles.chatApprove).toHaveBeenCalledWith({
      runId: 'r1',
      toolUseId: 't-auto',
      approved: true,
      alwaysAllow: false
    })

    // 硬红线即使开了自动同意也要弹窗
    handles.chatApprove.mockClear()
    onEvent({
      type: 'approval_required',
      runId: 'r1',
      conversationId: 'c1',
      messageId: 'a1',
      toolUseId: 't-critical',
      name: 'run_command',
      input: { command: 'rm -rf' },
      reason: '硬红线',
      severity: 'critical',
      autoApprovable: false
    })
    expect(store.approval?.toolUseId).toBe('t-critical')
    expect(handles.chatApprove).not.toHaveBeenCalled()

    // 分支切换
    await store.switchBranch('leaf-x')
    expect(store.activeLeafId).toBe('leaf-x')
    expect(handles.conversationSetLeaf).toHaveBeenCalledWith('c1', 'leaf-x')
  })
})
