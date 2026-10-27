import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent, Message } from '../../shared/types'

const conversations = new Map<string, { id: string; title: string; systemPrompt: string | null; workingDir: string | null }>()
let inserted: Message[] = []
let leafByConversation = new Map<string, string>()
let seq = 0
let streamCalls = 0
let activeReads = 0
let maxActiveReads = 0
const executionOrder: string[] = []
const finishedOrder: string[] = []

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
  getActivePath: (c: string) => inserted.filter((m) => m.conversationId === c),
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
    streamCalls++
    if (streamCalls === 1) {
      yield { type: 'tool_use', id: 'w', name: 'write_file', input: { path: 'x' } } as const
      yield { type: 'tool_use', id: 'r1', name: 'read_file', input: { path: 'a' } } as const
      yield { type: 'tool_use', id: 'r2', name: 'search_files', input: { filename: 'b' } } as const
      yield { type: 'tool_use', id: 'r3', name: 'list_directory', input: { path: '.' } } as const
    } else {
      yield { type: 'text', text: '完成' } as const
    }
    yield { type: 'stop', reason: 'stop' } as const
  }
}))

vi.mock('../providers/store', () => ({
  routingOrder: () => [{ id: 'p1', name: '测试供应商', models: ['m1'] }]
}))

vi.mock('../settings', () => ({
  getSetting: (key: string, fallback: unknown) => {
    if (key === 'agent.toolConcurrency') return 4
    if (key === 'tools.autoApprove') return ['write_file']
    return fallback
  },
  setSetting: () => {}
}))

vi.mock('../tools', () => ({
  auditCommandSecurity: () => ({ isDangerous: false }),
  toolRegistry: {
    all: () => [],
    get: (name: string) => {
      const requiresApproval = name === 'write_file'
      return {
        name,
        requiresApproval,
        execute: async () => {
          executionOrder.push(name)
          if (name === 'read_file' || name === 'search_files' || name === 'list_directory') {
            activeReads++
            maxActiveReads = Math.max(maxActiveReads, activeReads)
            await new Promise((resolve) => setTimeout(resolve, 25))
            activeReads--
          }
          finishedOrder.push(name)
          return name
        }
      }
    },
    schemas: () => []
  }
}))

vi.mock('../mcp/manager', () => ({
  mcpManager: { toolSchemas: async () => [] },
  parseMcpToolName: (n: string) => null
}))

vi.mock('./subagent', () => ({
  runSubagent: async () => ({ content: '', isError: false }),
  SPAWN_SUBAGENT_SCHEMA: {},
  SPAWN_TOOL_NAME: 'spawn_subagent'
}))

vi.mock('../storage/images', () => ({
  hydrateImages: async (b: unknown) => b
}))

describe('AgentRuntime 工具并发', () => {
  beforeEach(() => {
    vi.resetModules()
    conversations.clear()
    inserted = []
    leafByConversation = new Map()
    seq = 0
    streamCalls = 0
    activeReads = 0
    maxActiveReads = 0
    executionOrder.length = 0
    finishedOrder.length = 0
  })

  it('只读工具并发执行，写工具随后串行，事件按原调用顺序回填', async () => {
    const { AgentRuntime } = await import('./runtime')
    const runtime = new AgentRuntime()
    conversations.set('c1', { id: 'c1', title: 't', systemPrompt: null, workingDir: null })
    const events: AgentEvent[] = []
    runtime.send(
      { conversationId: 'c1', parentMessageId: null, content: '并发读取' },
      (event) => events.push(event)
    )
    await new Promise((resolve) => setTimeout(resolve, 900))

    expect(maxActiveReads).toBe(3)
    expect(finishedOrder.slice(0, 3).sort()).toEqual(['list_directory', 'read_file', 'search_files'])
    // 测试环境里写工具需要审批，未被自动放行时不会真正 execute；
    // 关键是读工具已并发完成，且事件仍按原调用顺序回填。
    expect(finishedOrder[3]).toBe('write_file')
    expect(executionOrder[0]).not.toBe('write_file')

    const toolResults = events.filter(
      (event): event is Extract<AgentEvent, { type: 'tool_result' }> => event.type === 'tool_result'
    )
    expect(toolResults.map((event) => event.toolUseId)).toEqual(['w', 'r1', 'r2', 'r3'])
    expect(events.some((event) => event.type === 'run_end')).toBe(true)
  }, 10_000)
})
