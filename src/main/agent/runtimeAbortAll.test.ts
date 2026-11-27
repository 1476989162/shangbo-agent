import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent, Message } from '../../shared/types'

/* abortAllRuns 全局急停：多会话正在跑 + 排队一次性清零 */

const conversations = new Map<string, { id: string; title: string; systemPrompt: string | null; workingDir: string | null }>()
let inserted: Message[] = []
let updatedStatus: Map<string, string> = new Map()
let leafByConversation = new Map<string, string>()
let seq = 0

function makeUserMessage(conversationId: string, text: string): Message {
  seq++
  return {
    id: `m${seq}`,
    conversationId,
    parentId: leafByConversation.get(conversationId) ?? null,
    role: 'user',
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
  getActiveLeaf: (conversationId: string) => leafByConversation.get(conversationId) ?? null,
  getLatestMessageId: (conversationId: string) => {
    const list = inserted.filter((m) => m.conversationId === conversationId)
    return list.length > 0 ? list[list.length - 1].id : null
  },
  getActivePath: (conversationId: string) =>
    inserted.filter((m) => m.conversationId === conversationId),
  getPathTo: (messageId: string) => {
    const start = inserted.find((m) => m.id === messageId)
    if (!start) return []
    const byId = new Map(inserted.map((m) => [m.id, m]))
    const path: Message[] = []
    let cursor: string | null = messageId
    while (cursor) {
      const current = byId.get(cursor)
      if (!current) break
      path.unshift(current)
      cursor = current.parentId
    }
    return path
  },
  reparentMessage: (messageId: string, parentId: string | null) => {
    const message = inserted.find((m) => m.id === messageId)
    if (message) message.parentId = parentId
  },
  setActiveLeaf: (conversationId: string, leafId: string) => {
    leafByConversation.set(conversationId, leafId)
  },
  insertMessage: (input: Partial<Message> & { conversationId: string }) => {
    const message = makeUserMessage(input.conversationId, 'x')
    Object.assign(message, input)
    inserted.push(message)
    return message
  },
  updateMessage: (id: string, patch: Partial<Message>) => {
    const message = inserted.find((m) => m.id === id)
    if (message) {
      Object.assign(message, patch)
      if (patch.status) updatedStatus.set(id, patch.status)
    }
    return message ?? null
  },
  updateConversation: () => {},
  touchConversation: () => {},
  listMessages: () => inserted,
  deleteSubtree: () => {},
  getUsageStats: () => ({})
}))

vi.mock('../providers/gateway', () => ({
  isReasoningModel: () => false,
  resolveFirstByteTimeoutMs: () => 180_000,
  streamWithFallback: async function* () {
    await new Promise<void>((resolve) => setTimeout(resolve, 50))
    yield { type: 'stop', reason: 'end_turn' } as const
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
  auditCommandSecurity: () => ({ allowed: true }),
  toolRegistry: { all: () => [], schemas: () => [] }
}))

vi.mock('../tools/todo', () => ({
  clearTodoItems: () => {},
  getTodoItems: () => []
}))

vi.mock('../mcp/manager', () => ({
  mcpManager: {
    listTools: () => [],
    tools: () => [],
    toolSchemas: () => [],
    allTools: () => []
  },
  parseMcpToolName: (name: string) => name
}))

vi.mock('./subagent', () => ({
  runSubagent: async () => ({ content: '', isError: false }),
  SPAWN_SUBAGENT_SCHEMA: {},
  SPAWN_TOOL_NAME: 'spawn_subagent'
}))

vi.mock('../storage/images', () => ({
  hydrateImages: async (blocks: unknown) => blocks
}))

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5))

describe('全局急停 abortAllRuns', () => {
  let runtime: InstanceType<typeof import('./runtime').AgentRuntime>

  beforeEach(async () => {
    vi.resetModules()
    conversations.clear()
    inserted = []
    updatedStatus = new Map()
    leafByConversation = new Map()
    seq = 0
    conversations.set('c1', { id: 'c1', title: '会话1', systemPrompt: null, workingDir: null })
    conversations.set('c2', { id: 'c2', title: '会话2', systemPrompt: null, workingDir: null })
    const { AgentRuntime } = await import('./runtime')
    runtime = new AgentRuntime()
  })

  function collector(): { events: AgentEvent[]; emit: (event: AgentEvent) => void } {
    const events: AgentEvent[] = []
    return { events, emit: (event) => events.push(event) }
  }

  it('中止多会话运行并清空各自排队', async () => {
    const { emit } = collector()
    runtime.send({ conversationId: 'c1', parentMessageId: null, content: 'c1 问题1' }, emit)
    runtime.send({ conversationId: 'c1', parentMessageId: null, content: 'c1 问题2' }, emit)
    runtime.send({ conversationId: 'c2', parentMessageId: null, content: 'c2 问题1' }, emit)
    runtime.send({ conversationId: 'c2', parentMessageId: null, content: 'c2 问题2' }, emit)
    await tick()
    expect(runtime.queueLength('c1')).toBe(1)
    expect(runtime.queueLength('c2')).toBe(1)

    const result = runtime.abortAllRuns()
    expect(result.abortedRuns).toBe(2)
    expect(result.clearedQueued).toBe(2)
    expect(runtime.queueLength('c1')).toBe(0)
    expect(runtime.queueLength('c2')).toBe(0)
    // 被清掉的排队消息按 aborted 落库
    expect([...updatedStatus.values()]).toContain('aborted')
  })

  it('空运行时返回零值不报错', () => {
    expect(runtime.abortAllRuns()).toEqual({ abortedRuns: 0, clearedQueued: 0 })
  })
})
