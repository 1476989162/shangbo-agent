import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent, Message } from '../../shared/types'

/* AgentRuntime 依赖 electron 与 better-sqlite3，这里把两者都替换掉，
   只保留真实的队列与调度逻辑来验证——影子实现测不出真实回归。 */

const conversations = new Map<string, { id: string; title: string; systemPrompt: string | null; workingDir: string | null }>()
const inserted: Message[] = []
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
  // 上下文构建需要一条从叶子回溯的路径
  getActivePath: (conversationId: string) =>
    inserted.filter((m) => m.conversationId === conversationId),
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
    if (message) Object.assign(message, patch)
    return message ?? null
  },
  updateConversation: (id: string, patch: { title?: string }) => {
    const conv = conversations.get(id)
    if (conv && patch.title) conv.title = patch.title
  },
  touchConversation: () => {},
  listMessages: () => inserted
}))

vi.mock('../providers/gateway', () => ({
  streamWithFallback: async function* () {
    // 挂起直到被 abort，让测试能控制「这一轮跑多久」
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 50)
    })
    yield { type: 'stop', reason: 'end_turn' } as const
  }
}))

vi.mock('../providers/store', () => ({
  routingOrder: () => [{ id: 'p1', name: '测试供应商', models: ['m1'] }]
}))

vi.mock('../settings', () => ({
  // runtime 里按 getSetting(key, fallback) 取值，必须返回 fallback 而不是 undefined
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

/** 让出一帧，让微任务里的 execute 真正跑起来。 */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5))

describe('AgentRuntime 的同会话串行队列', () => {
  let runtime: InstanceType<typeof import('./runtime').AgentRuntime>

  beforeEach(async () => {
    vi.resetModules()
    conversations.clear()
    inserted.length = 0
    leafByConversation = new Map()
    seq = 0
    conversations.set('c1', { id: 'c1', title: '会话1', systemPrompt: '系统提示', workingDir: null })
    conversations.set('c2', { id: 'c2', title: '会话2', systemPrompt: '系统提示', workingDir: null })
    const { AgentRuntime } = await import('./runtime')
    runtime = new AgentRuntime()
  })

  /**
   * 每个测试一份独立的事件收集器。
   * 不能共用一个模块级数组：emitter 是闭包，会捕获变量而非值，
   * 上一轮测试遗留的异步任务会把事件写进下一轮的数组里。
   */
  function collector(): { events: AgentEvent[]; emit: (event: AgentEvent) => void } {
    const events: AgentEvent[] = []
    return { events, emit: (event) => events.push(event) }
  }

  /** 等所有已启动的轮次跑完（mock 每轮约 50ms）。 */
  const drain = (ms = 300): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms))

  it('会话空闲时立即开跑', async () => {
    const { events, emit } = collector()
    runtime.send({ conversationId: 'c1', parentMessageId: null, content: '问题1' }, emit)
    await tick()
    expect(events.some((e) => e.type === 'run_start')).toBe(true)
    expect(events.some((e) => e.type === 'run_queued')).toBe(false)
  })

  it('同会话第二个请求进入队列，不并发', async () => {
    const { events, emit } = collector()
    runtime.send({ conversationId: 'c1', parentMessageId: null, content: '问题1' }, emit)
    runtime.send({ conversationId: 'c1', parentMessageId: null, content: '问题2' }, emit)
    await tick()

    const starts = events.filter((e) => e.type === 'run_start')
    const queued = events.filter((e) => e.type === 'run_queued')
    expect(starts).toHaveLength(1)
    expect(queued).toHaveLength(1)
    if (queued[0].type === 'run_queued') expect(queued[0].position).toBe(1)
  })

  it('前一轮结束后自动接力下一轮', async () => {
    const { events, emit } = collector()
    runtime.send({ conversationId: 'c1', parentMessageId: null, content: '问题1' }, emit)
    runtime.send({ conversationId: 'c1', parentMessageId: null, content: '问题2' }, emit)

    // 每轮 mock 约 50ms，两轮串行需要留足时间
    await drain(400)

    const starts = events.filter((e) => e.type === 'run_start')
    expect(starts).toHaveLength(2)
    // 第二条先排队、真正轮到时才开跑，顺序不能乱
    const order = events.map((e) => e.type)
    expect(order.indexOf('run_queued')).toBeLessThan(order.lastIndexOf('run_start'))
  })

  it('不同会话互不阻塞，同时开跑', async () => {
    const { events, emit } = collector()
    runtime.send({ conversationId: 'c1', parentMessageId: null, content: 'A' }, emit)
    runtime.send({ conversationId: 'c2', parentMessageId: null, content: 'B' }, emit)
    await tick()

    const starts = events.filter((e) => e.type === 'run_start')
    expect(starts).toHaveLength(2)
    expect(events.some((e) => e.type === 'run_queued')).toBe(false)
  })

  it('排队消息立即落库，UI 能看到自己发了什么', async () => {
    const { emit } = collector()
    runtime.send({ conversationId: 'c1', parentMessageId: null, content: '问题1' }, emit)
    runtime.send({ conversationId: 'c1', parentMessageId: null, content: '排队的问题' }, emit)
    await tick()

    const texts = inserted
      .map((m) => m.blocks.find((b) => b.type === 'text'))
      .filter((b): b is { type: 'text'; text: string } => b?.type === 'text')
      .map((b) => b.text)
    expect(texts).toContain('排队的问题')
  })

  it('run_end 携带准确的排队数，UI 不会误判为空闲', async () => {
    const { events, emit } = collector()
    runtime.send({ conversationId: 'c1', parentMessageId: null, content: 'q1' }, emit)
    runtime.send({ conversationId: 'c1', parentMessageId: null, content: 'q2' }, emit)
    // 等第一轮真正跑完（mock 约 50ms），run_end 才会发出来
    await drain(150)

    const firstEnd = events.find((e) => e.type === 'run_end')
    if (firstEnd?.type !== 'run_end') throw new Error('应当有 run_end')
    // 第一轮结束时，后面还排着 1 条
    expect(firstEnd.queued).toBe(1)
  })

  it('队列排空后 run_end 报 0，运行态可以被清掉', async () => {
    const { events, emit } = collector()
    runtime.send({ conversationId: 'c1', parentMessageId: null, content: 'only' }, emit)
    await drain(150)

    const end = events.find((e) => e.type === 'run_end')
    if (end?.type !== 'run_end') throw new Error('应当有 run_end')
    expect(end.queued).toBe(0)
  })

  it('删除会话会清掉它的排队项', () => {
    const { emit } = collector()
    runtime.send({ conversationId: 'c1', parentMessageId: null, content: 'q1' }, emit)
    runtime.send({ conversationId: 'c1', parentMessageId: null, content: 'q2' }, emit)
    expect(runtime.queueLength('c1')).toBe(1)
    runtime.abortConversation('c1')
    expect(runtime.queueLength('c1')).toBe(0)
  })
})
