import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent, Message, TodoItem } from '../../shared/types'

const conversations = new Map<string, { id: string; title: string; systemPrompt: string | null; workingDir: string | null }>()
let inserted: Message[] = []
let leafByConversation = new Map<string, string>()
let seq = 0
let streamCalls = 0
let todoByRun = new Map<string, TodoItem[]>()
let executedRunId = ''

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
      yield {
        type: 'tool_use',
        id: 'todo-1',
        name: 'todo_write',
        input: { todos: [{ id: '1', content: '写集成测试', status: 'in_progress' }] }
      } as const
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
  getSetting: (_key: string, fallback: unknown) => fallback,
  setSetting: () => {}
}))

vi.mock('../tools/todo', () => ({
  getTodoItems: (runId: string) => todoByRun.get(runId) ?? [],
  clearTodoItems: (runId: string) => {
    todoByRun.delete(runId)
  }
}))

vi.mock('../tools', () => ({
  auditCommandSecurity: () => ({ isDangerous: false }),
  toolRegistry: {
    all: () => [],
    get: (name: string) =>
      name === 'todo_write'
        ? {
            name,
            requiresApproval: false,
            execute: async (input: { todos: TodoItem[] }, context: { runId: string }) => {
              executedRunId = context.runId
              todoByRun.set(context.runId, input.todos)
              return '已更新任务清单'
            }
          }
        : undefined,
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

describe('todo_write 运行时事件', () => {
  beforeEach(() => {
    vi.resetModules()
    conversations.clear()
    inserted = []
    leafByConversation = new Map()
    seq = 0
    streamCalls = 0
    todoByRun = new Map()
    executedRunId = ''
  })

  it('把 runId 传给工具，并在执行后广播 todo_update，收尾时清理内存', async () => {
    const { AgentRuntime } = await import('./runtime')
    const runtime = new AgentRuntime()
    conversations.set('c1', { id: 'c1', title: 't', systemPrompt: null, workingDir: null })
    const events: AgentEvent[] = []
    runtime.send(
      { conversationId: 'c1', parentMessageId: null, content: '维护清单' },
      (event) => events.push(event)
    )
    await new Promise((resolve) => setTimeout(resolve, 600))

    const start = events.find((event) => event.type === 'run_start')
    const todo = events.find((event) => event.type === 'todo_update')
    expect(start?.type).toBe('run_start')
    expect(executedRunId).toBe(start?.type === 'run_start' ? start.runId : '')
    expect(todo?.type).toBe('todo_update')
    if (todo?.type === 'todo_update') {
      expect(todo.items).toEqual([
        { id: '1', content: '写集成测试', status: 'in_progress' }
      ])
    }
    expect(events.some((event) => event.type === 'run_end')).toBe(true)
    expect(todoByRun.size).toBe(0)
  }, 10_000)
})
