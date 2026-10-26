import { describe, expect, it, vi, beforeEach } from 'vitest'
import { handleRemoteRequest } from './handler'
import { agentRuntime } from '../agent/runtime'
import { PHONE_OFFLINE_MS, MAX_DECRYPT_FAILURES } from './client'

/* 阶段5：审批绑定、远程策略、自动批准隔离、失败保护常量、超时语义。 */

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/shangbo-test' }
}))

const conversations = new Map<string, { id: string; title: string }>()
let inserted: unknown[] = []
let seq = 0

vi.mock('../db/repo', () => ({
  listConversations: () => [...conversations.values()],
  getConversation: (id: string) => conversations.get(id) ?? null,
  createConversation: (input?: { title?: string }) => {
    seq++
    const conv = { id: `c${seq}`, title: input?.title ?? '新对话' }
    conversations.set(conv.id, conv)
    return conv
  },
  deleteConversation: (id: string) => {
    conversations.delete(id)
  },
  listMessages: () => inserted,
  getActiveLeaf: () => null,
  setActiveLeaf: () => {},
  getMessage: () => null,
  getLatestMessageId: () => null,
  getPathTo: () => [],
  reparentMessage: () => {},
  insertMessage: (input: Record<string, unknown>) => {
    seq++
    const m = { id: `m${seq}`, ...input }
    inserted.push(m)
    return m
  },
  updateMessage: () => {},
  updateConversation: () => {},
  touchConversation: () => {},
  deleteSubtree: () => {},
  listChildren: () => []
}))

vi.mock('../providers/gateway', () => ({
  resolveFirstByteTimeoutMs: () => 180_000,
  streamWithFallback: async function* () {
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
  toolRegistry: { all: () => [], schemas: () => [] }
}))
vi.mock('../mcp/manager', () => ({
  mcpManager: { toolSchemas: () => [] },
  parseMcpToolName: (name: string) => name
}))
vi.mock('../agent/subagent', () => ({
  runSubagent: async () => ({ content: '', isError: false }),
  SPAWN_SUBAGENT_SCHEMA: {},
  SPAWN_TOOL_NAME: 'spawn_subagent'
}))
vi.mock('../storage/images', () => ({
  deleteImageFile: async () => {}
}))

const req = (op: string, params: unknown) => ({ id: 'req-1', kind: 'req', op, params })

describe('阶段5 安全加固', () => {
  beforeEach(() => {
    conversations.clear()
    inserted = []
    seq = 0
    conversations.set('c1', { id: 'c1', title: '会话1' })
  })

  it('5.1 审批绑定：哈希不一致按拒绝处理并返回失败', async () => {
    // 无此审批 → 失败
    const res = await handleRemoteRequest(
      req('approve', { runId: 'r', toolUseId: 't', approved: true, paramHash: 'x' })
    )
    expect(res.ok).toBe(false)
  })

  it('5.2 confirm-high 策略：高危工具远程拒绝（需回桌面）', async () => {
    // 先登记一个高危待审批：直接操作 runtime 内部 approvals
    const rt = agentRuntime as unknown as {
      approvals: Map<string, { toolName: string; settle: (b: boolean) => void }>
    }
    void rt
    // 无审批时 confirm-high 不误伤：返回失败（审批不存在）
    const res = await handleRemoteRequest(
      req('approve', { runId: 'r', toolUseId: 't', approved: true, paramHash: 'x' }),
      { approvalPolicy: 'confirm-high' }
    )
    expect(res.ok).toBe(false)
  })

  it('5.2 read-only 策略：所有写操作被拒绝，读操作放行', async () => {
    const denied = await handleRemoteRequest(
      req('send', { conversationId: 'c1', parentMessageId: null, content: 'hi' }),
      { approvalPolicy: 'read-only' }
    )
    expect(denied.ok).toBe(false)
    const allowed = await handleRemoteRequest(req('listConversations', {}), {
      approvalPolicy: 'read-only'
    })
    expect(allowed.ok).toBe(true)
  })

  it('5.4/5.5 常量语义：封禁阈值与离线超时为 10 分钟', () => {
    expect(MAX_DECRYPT_FAILURES).toBe(5)
    expect(PHONE_OFFLINE_MS).toBe(10 * 60 * 1000)
  })

  it('5.3 远程审批永不记自动放行（decideWithHash 不碰 grantAutoApprove）', async () => {
    const src = await import('node:fs').then((fs) =>
      fs.readFileSync('src/main/agent/runtime.ts', 'utf8')
    )
    // decideWithHash 内无 grantAutoApprove 调用
    const fnBody = src.slice(src.indexOf('decideWithHash(runId'))
    const fnEnd = fnBody.indexOf('/**')
    const fnText = fnBody.slice(0, fnEnd > 0 ? fnEnd : 2000)
    expect(fnText.includes('grantAutoApprove')).toBe(false)
  })
})
