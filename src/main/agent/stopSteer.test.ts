import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent, Message } from '../../shared/types'

/* 卡死终止修复 + 队列插话指导：
   - abort 看门狗：hang 住超时强制收尾发 run_end
   - abortConversationRuns：中断本轮 + 清空排队 + 审批按拒绝
   - steerRunningRound：排队消息转指导，注入正在跑回合 */

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
      path.push(current)
      cursor = current.parentId
    }
    return path.reverse()
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
const drain = (ms = 300): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))
const waitFor = async (predicate: () => boolean, timeoutMs = 1000): Promise<void> => {
  const deadline = Date.now() + timeoutMs
  while (!predicate() && Date.now() < deadline) {
    await tick()
  }
}

describe('停止整个会话 abortConversationRuns', () => {
  let runtime: InstanceType<typeof import('./runtime').AgentRuntime>

  beforeEach(async () => {
    vi.resetModules()
    conversations.clear()
    inserted = []
    updatedStatus = new Map()
    leafByConversation = new Map()
    seq = 0
    conversations.set('c1', { id: 'c1', title: '会话1', systemPrompt: null, workingDir: null })
    const { AgentRuntime } = await import('./runtime')
    runtime = new AgentRuntime()
  })

  function collector(): { events: AgentEvent[]; emit: (event: AgentEvent) => void } {
    const events: AgentEvent[] = []
    return { events, emit: (event) => events.push(event) }
  }

  it('中断本轮 + 清空排队：下一条不再自动接力', async () => {
    const { events, emit } = collector()
    runtime.send({ conversationId: 'c1', parentMessageId: null, content: '问题1' }, emit)
    runtime.send({ conversationId: 'c1', parentMessageId: null, content: '问题2' }, emit)
    await tick()
    expect(runtime.queueLength('c1')).toBe(1)

    const result = runtime.abortConversationRuns('c1')
    expect(result.abortedRun).toBeTruthy()
    expect(result.clearedQueued).toBe(1)
    expect(runtime.queueLength('c1')).toBe(0)

    // 等原轮收尾（abort 后按 aborted 结束），确认没有新 run_start 接力
    await drain(300)
    const starts = events.filter((e) => e.type === 'run_start')
    expect(starts).toHaveLength(1)
    // run_end 必达：界面不再永久"正在跑"
    expect(events.some((e) => e.type === 'run_end')).toBe(true)
  })

  it('被清掉的排队消息标记为 aborted', async () => {
    const { emit } = collector()
    runtime.send({ conversationId: 'c1', parentMessageId: null, content: '问题1' }, emit)
    const queued = runtime.send({ conversationId: 'c1', parentMessageId: null, content: '排队' }, emit)
    void queued
    await tick()
    runtime.abortConversationRuns('c1')
    const statuses = [...updatedStatus.values()]
    expect(statuses).toContain('aborted')
  })

  it('空闲会话调用返回零值不报错', () => {
    const result = runtime.abortConversationRuns('c1')
    expect(result.abortedRun).toBeNull()
    expect(result.clearedQueued).toBe(0)
  })
})

describe('队列插话指导 steerRunningRound', () => {
  let runtime: InstanceType<typeof import('./runtime').AgentRuntime>

  beforeEach(async () => {
    vi.resetModules()
    conversations.clear()
    inserted = []
    updatedStatus = new Map()
    leafByConversation = new Map()
    seq = 0
    conversations.set('c1', { id: 'c1', title: '会话1', systemPrompt: null, workingDir: null })
    const { AgentRuntime } = await import('./runtime')
    runtime = new AgentRuntime()
  })

  function collector(): { events: AgentEvent[]; emit: (event: AgentEvent) => void } {
    const events: AgentEvent[] = []
    return { events, emit: (event) => events.push(event) }
  }

  it('排队消息转指导：摘队列 + 暂存 + 界面收到回执', async () => {
    const { emit } = collector()
    runtime.send({ conversationId: 'c1', parentMessageId: null, content: 'A 的问题' }, emit)
    await tick()
    // A 跑中时连发 B
    runtime.send({ conversationId: 'c1', parentMessageId: null, content: '别删 node_modules' }, emit)
    // 等异步落库完成；固定 5ms 在高负载 CI 上不足以稳定等到 B
    await waitFor(() =>
      inserted.some((m) =>
        m.blocks.some((b) => b.type === 'text' && b.text === '别删 node_modules')
      )
    )
    expect(runtime.queueLength('c1')).toBe(1)

    const bUser = inserted.find((m) =>
      m.blocks.some((b) => b.type === 'text' && b.text === '别删 node_modules')
    )
    expect(bUser).toBeDefined()
    const ok = runtime.steerRunningRound('c1', bUser!.id)
    expect(ok).toBe(true)
    // 队列已摘
    expect(runtime.queueLength('c1')).toBe(0)
    // 指导已暂存
    expect(runtime.takeSteeringNotes('c1')).toEqual(['别删 node_modules'])
    // 取走后清空
    expect(runtime.takeSteeringNotes('c1')).toEqual([])
  })

  it('无在跑回合时返回 false（指导无处投递）', async () => {
    const ok = runtime.steerRunningRound('c1', 'm-nope')
    expect(ok).toBe(false)
  })
})
