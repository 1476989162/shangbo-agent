import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent, Message } from '../../shared/types'

/* maxSteps 成本熔断：模型一直返回 tool_use 时，第 50 步（默认）停下。 */

const conversations = new Map<string, { id: string; title: string; systemPrompt: string | null; workingDir: string | null }>()
let inserted: Message[] = []
let leafByConversation = new Map<string, string>()
let seq = 0
let maxSteps = 50

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
  // runtime 逐轮调用它解析首字节超时，缺了会 TypeError 让整轮直接失败
  resolveFirstByteTimeoutMs: () => 180_000,
  streamWithFallback: async function* () {
    // 一直返回不同的 tool_use：loopGuard 不触发，只能靠 maxSteps 停
    for (let i = 0; i < 200; i++) {
      yield { type: 'tool_use', id: `t${i}`, name: 'read_file', input: { path: `/f${i}.txt` } } as const
      yield { type: 'usage', usage: { promptTokens: 10, completionTokens: 5 } } as const
    }
    yield { type: 'stop', reason: 'stop' } as const
  }
}))

vi.mock('../providers/store', () => ({
  routingOrder: () => [{ id: 'p1', name: '测试供应商', models: ['m1'] }]
}))

vi.mock('../settings', () => ({
  getSetting: (key: string, fallback: unknown) => (key === 'agent.maxSteps' ? maxSteps : fallback),
  setSetting: () => {}
}))

vi.mock('../tools', () => ({
  auditCommandSecurity: () => ({ isDangerous: false }),
  toolRegistry: {
    all: () => [],
    get: (name: string) =>
      name === 'read_file'
        ? { name, requiresApproval: false, execute: async () => ({ content: 'ok', isError: false }) }
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

describe('maxSteps 成本熔断', () => {
  beforeEach(async () => {
    vi.resetModules()
    conversations.clear()
    inserted = []
    leafByConversation = new Map()
    seq = 0
    maxSteps = 50
  })

  it('模型一直调工具时在 maxSteps 步停下', async () => {
    maxSteps = 5
    const { AgentRuntime } = await import('./runtime')
    const runtime = new AgentRuntime()
    conversations.set('c1', { id: 'c1', title: 't', systemPrompt: null, workingDir: null })
    const events: AgentEvent[] = []
    const emit = (e: AgentEvent): void => {
      events.push(e)
    }
    runtime.send({ conversationId: 'c1', parentMessageId: null, content: '一直干活' }, emit)
    await new Promise((r) => setTimeout(r, 1500))
    const texts = inserted
      .flatMap((m) => m.blocks)
      .filter((b) => b.type === 'text')
      .map((b) => (b.type === 'text' ? b.text : ''))
      .join('\n')
    expect(texts).toContain('单轮步数上限')
  }, 10000)
})
