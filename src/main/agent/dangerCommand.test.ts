import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent, Message } from '../../shared/types'

/* A-1 危险命令分级审批：
   - CRITICAL（擦盘/格式化）不弹窗直接拒绝，工具不执行；
   - HIGH（删库等）弹窗征求确认，用户批准后工具真的执行。
   与 queue.test.ts 相同手法：mock 掉 electron/db/网关，驱动真实 AgentRuntime。 */

const conversations = new Map<string, { id: string; title: string; systemPrompt: string | null; workingDir: string | null }>()
let inserted: Message[] = []
let leafByConversation = new Map<string, string>()
let seq = 0

/** 本次用例的审计结果与工具执行记录（hoisted：vi.mock 工厂里引用）。 */
const auditState = vi.hoisted(() => ({
  result: { isDangerous: false, severity: undefined as string | undefined, reason: '' }
}))
const executed = vi.hoisted(() => ({ tools: [] as string[] }))
const gatewayState = vi.hoisted(() => ({ requests: 0 }))

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
    gatewayState.requests++
    // 第一轮请求给出 run_command 工具调用，之后每轮直接结束
    if (gatewayState.requests === 1) {
      yield { type: 'tool_use', id: 't1', name: 'run_command', input: { command: 'echo pwned' } } as const
      yield { type: 'usage', usage: { promptTokens: 10, completionTokens: 5 } } as const
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

vi.mock('../tools', () => ({
  // 审计结果由测试用例注入；工具执行被记录而非真正跑 exec
  auditCommandSecurity: () => auditState.result,
  toolRegistry: {
    all: () => [],
    get: (name: string) =>
      name === 'run_command'
        ? {
            name,
            requiresApproval: true,
            approvalReason: '将在你的本机执行命令。',
            execute: async () => {
              executed.tools.push(name)
              return { content: '命令已执行', isError: false }
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
  hydrateImages: async (b: unknown) => b,
  deleteImageFile: async () => {}
}))

const drain = (ms = 300): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('run_command 危险命令分级（A-1）', () => {
  let runtime: InstanceType<typeof import('./runtime').AgentRuntime>
  let events: AgentEvent[]
  let emit: (event: AgentEvent) => void

  beforeEach(async () => {
    vi.resetModules()
    conversations.clear()
    inserted = []
    leafByConversation = new Map()
    seq = 0
    auditState.result = { isDangerous: false, severity: undefined, reason: '' }
    executed.tools = []
    gatewayState.requests = 0
    conversations.set('c1', { id: 'c1', title: '会话1', systemPrompt: null, workingDir: null })
    const { AgentRuntime } = await import('./runtime')
    runtime = new AgentRuntime()
    events = []
    // 收到审批请求时立即批准（microtask 等 approvals 注册完成后再 decide）
    emit = (event) => {
      events.push(event)
      if (event.type === 'approval_required') {
        const runId = event.runId
        const toolUseId = event.toolUseId
        queueMicrotask(() => {
          runtime.decide({ runId, toolUseId, approved: true })
        })
      }
    }
  })

  it('HIGH 级命令：弹窗审批，批准后工具真正执行', async () => {
    auditState.result = { isDangerous: true, severity: 'HIGH', reason: '检测到数据库删库操作' }
    runtime.send({ conversationId: 'c1', parentMessageId: null, content: '删库' }, emit)
    await drain()

    expect(events.some((e) => e.type === 'approval_required')).toBe(true)
    expect(executed.tools).toContain('run_command')
    const toolResult = events.find((e) => e.type === 'tool_result')
    expect(toolResult).toBeDefined()
    if (toolResult?.type === 'tool_result') {
      expect(toolResult.isError).toBe(false)
      expect(toolResult.content).toContain('命令已执行')
    }
  })

  it('CRITICAL 级命令：不弹窗、直接拒绝、工具不执行', async () => {
    auditState.result = { isDangerous: true, severity: 'CRITICAL', reason: '擦盘级破坏命令' }
    runtime.send({ conversationId: 'c1', parentMessageId: null, content: '擦盘' }, emit)
    await drain()

    expect(events.some((e) => e.type === 'approval_required')).toBe(false)
    expect(executed.tools).toHaveLength(0)
    const toolResult = events.find((e) => e.type === 'tool_result')
    expect(toolResult).toBeDefined()
    if (toolResult?.type === 'tool_result') {
      expect(toolResult.isError).toBe(true)
      expect(toolResult.content).toContain('已拦截')
    }
  })
})
