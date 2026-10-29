import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent, Message } from '../../shared/types'

/* 回归测试：「运行中的会话切走再切回来就看不到进度」。
   锁两点：
   1. 流式正文还没落库（DB 里是空块）时，运行态快照必须带上内存里的实时内容；
   2. 会话空闲时必须报 runId=null / 无实时内容，否则切回来会挂一条永远不动的空消息。 */

const conversations = new Map<string, { id: string; title: string; systemPrompt: string | null; workingDir: string | null }>()
let inserted: Message[] = []
let leafByConversation = new Map<string, string>()
let seq = 0
/** 流式放行开关：控制模型流何时结束，以便在「正在跑」的瞬间取快照。 */
let releaseStream: (() => void) | null = null

function makeMessage(conversationId: string, role: Message['role'], text: string): Message {
  seq++
  return {
    id: `m${seq}`,
    conversationId,
    parentId: leafByConversation.get(conversationId) ?? null,
    role,
    blocks: [{ type: 'text', text }],
    status: 'done',
    error: null,
    providerId: null,
    model: null,
    usage: null,
    createdAt: seq,
    updatedAt: seq
  }
}

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/shangbo-test' },
  protocol: { handle: () => {}, registerSchemesAsPrivileged: () => {} }
}))

vi.mock('../db/repo', () => ({
  getConversation: (id: string) => conversations.get(id) ?? null,
  getMessage: (id: string) => inserted.find((m) => m.id === id) ?? null,
  getActiveLeaf: (c: string) => leafByConversation.get(c) ?? null,
  getLatestMessageId: (c: string) => {
    const list = inserted.filter((m) => m.conversationId === c)
    return list.length > 0 ? list[list.length - 1].id : null
  },
  findStreamingAssistantMessageId: (c: string) => {
    const list = inserted.filter(
      (m) => m.conversationId === c && m.role === 'assistant' && m.status === 'streaming'
    )
    return list.length > 0 ? list[list.length - 1].id : null
  },
  getPathTo: (messageId: string) => {
    const start = inserted.find((m) => m.id === messageId)
    if (!start) return []
    const byId = new Map(inserted.map((m) => [m.id, m]))
    const path: Message[] = []
    let cursor: string | null = messageId
    while (cursor) {
      const current = byId.get(cursor)
      if (!current) break
      path.push(current)
      cursor = current.parentId
    }
    return path.reverse()
  },
  reparentMessage: (messageId: string, parentId: string | null) => {
    const message = inserted.find((m) => m.id === messageId)
    if (message) message.parentId = parentId
  },
  setActiveLeaf: (c: string, leaf: string) => {
    leafByConversation.set(c, leaf)
  },
  insertMessage: (input: Partial<Message> & { conversationId: string }) => {
    const m = makeMessage(input.conversationId, input.role ?? 'user', 'x')
    Object.assign(m, input)
    inserted.push(m)
    return m
  },
  updateMessage: (id: string, patch: Partial<Message>) => {
    const m = inserted.find((x) => x.id === id)
    if (m) Object.assign(m, patch)
    return m ?? null
  },
  updateConversation: () => {},
  touchConversation: () => {},
  listMessages: () => inserted,
  deleteSubtree: () => {}
}))

vi.mock('../providers/gateway', () => ({
  resolveFirstByteTimeoutMs: () => 180_000,
  streamWithFallback: async function* () {
    // 先吐一段正文（不落库），再等测试放行，模拟「正在流式输出」的中间态
    yield { type: 'text', text: '正在生成的内容' } as const
    await new Promise<void>((resolve) => {
      releaseStream = resolve
    })
    yield { type: 'stop', reason: 'stop' } as const
  }
}))

vi.mock('../providers/store', () => ({
  routingOrder: () => [{ id: 'p1', name: '测试供应商', models: ['m1'] }]
}))

vi.mock('../settings', () => ({
  getSetting: (_key: string, fallback: unknown) => fallback,
  setSetting: () => {}
}))

vi.mock('../tools', () => ({
  auditCommandSecurity: () => ({ isDangerous: false }),
  toolRegistry: { all: () => [], get: () => undefined, schemas: () => [] }
}))

vi.mock('../mcp/manager', () => ({
  mcpManager: { toolSchemas: async () => [] },
  parseMcpToolName: () => null
}))

vi.mock('./subagent', () => ({
  runSubagent: async () => ({ content: '', isError: false }),
  SPAWN_SUBAGENT_SCHEMA: {},
  SPAWN_TOOL_NAME: 'spawn_subagent'
}))

vi.mock('../storage/images', () => ({
  hydrateImages: async (b: unknown) => b
}))

const waitFor = async (predicate: () => boolean, timeoutMs = 2000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

describe('conversationRuntimeState 切回会话的运行态快照', () => {
  beforeEach(() => {
    vi.resetModules()
    conversations.clear()
    inserted = []
    leafByConversation = new Map()
    seq = 0
    releaseStream = null
  })

  it('流式正文未落库时，快照带上内存里的实时内容', async () => {
    const { AgentRuntime } = await import('./runtime')
    const runtime = new AgentRuntime()
    conversations.set('c1', { id: 'c1', title: 't', systemPrompt: null, workingDir: null })

    const events: AgentEvent[] = []
    runtime.send({ conversationId: 'c1', parentMessageId: null, content: '写点东西' }, (event) =>
      events.push(event)
    )

    const start = await new Promise<Extract<AgentEvent, { type: 'run_start' }>>((resolve) => {
      const timer = setInterval(() => {
        const found = events.find((e) => e.type === 'run_start')
        if (found?.type === 'run_start') {
          clearInterval(timer)
          resolve(found)
        }
      }, 5)
    })

    // 等流式正文进入内存（此时 DB 里的 assistant 消息 blocks 仍为空）
    await waitFor(() => events.some((e) => e.type === 'text_delta'))
    const persisted = inserted.find((m) => m.id === start.assistantMessageId)
    expect(persisted?.blocks).toEqual([])

    const snapshot = runtime.conversationRuntimeState('c1')
    expect(snapshot.runId).toBe(start.runId)
    expect(snapshot.streamingMessageId).toBe(start.assistantMessageId)
    // 关键断言：DB 空但快照有内容 —— 切回来就能看到进度，而不是一片空白
    expect(snapshot.liveBlocks).toEqual([{ type: 'text', text: '正在生成的内容' }])

    releaseStream?.()
    await waitFor(() => events.some((e) => e.type === 'run_end'))
  }, 10_000)

  it('空闲会话快照为 null，且不带实时内容', async () => {
    const { AgentRuntime } = await import('./runtime')
    const runtime = new AgentRuntime()
    conversations.set('c1', { id: 'c1', title: 't', systemPrompt: null, workingDir: null })

    const snapshot = runtime.conversationRuntimeState('c1')
    expect(snapshot.runId).toBeNull()
    expect(snapshot.streamingMessageId).toBeNull()
    expect(snapshot.liveBlocks).toEqual([])
    expect(snapshot.todos).toEqual([])
    expect(snapshot.approvals).toEqual([])
  })

  it('本轮收尾后实时副本被清理，避免残留内容被当成新进度', async () => {
    const { AgentRuntime } = await import('./runtime')
    const runtime = new AgentRuntime()
    conversations.set('c1', { id: 'c1', title: 't', systemPrompt: null, workingDir: null })

    const events: AgentEvent[] = []
    runtime.send({ conversationId: 'c1', parentMessageId: null, content: '写点东西' }, (event) =>
      events.push(event)
    )
    await waitFor(() => releaseStream !== null)
    releaseStream?.()
    await waitFor(() => events.some((e) => e.type === 'run_end'))

    const snapshot = runtime.conversationRuntimeState('c1')
    expect(snapshot.runId).toBeNull()
    expect(snapshot.liveBlocks).toEqual([])
  }, 10_000)
})
