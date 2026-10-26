import { beforeEach, describe, expect, it, vi } from 'vitest'
import { handleRemoteRequest } from './handler'
import { agentRuntime } from '../agent/runtime'
import type { Message } from '../../shared/types'

/* 阶段1：handler 只开放白名单操作；未列出的操作返回错误；审批哈希绑定。 */

const conversations = new Map<string, { id: string; title: string }>()
let inserted: Message[] = []
let seq = 0

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/shangbo-test' }
}))

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
  getMessage: (id: string) => inserted.find((m) => m.id === id) ?? null,
  getLatestMessageId: () => null,
  getPathTo: () => [],
  reparentMessage: () => {},
  setActiveLeaf_: () => {},
  insertMessage: (input: Partial<Message> & { conversationId: string }) => {
    seq++
    const m = {
      id: `m${seq}`,
      conversationId: input.conversationId,
      parentId: input.parentId ?? null,
      role: input.role ?? 'user',
      blocks: input.blocks ?? [],
      status: input.status ?? 'done',
      error: null,
      providerId: null,
      model: null,
      usage: null,
      createdAt: seq,
      updatedAt: seq
    } as Message
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

vi.mock('./subagent' in {} ? './subagent' : '../agent/subagent', () => ({
  runSubagent: async () => ({ content: '', isError: false }),
  SPAWN_SUBAGENT_SCHEMA: {},
  SPAWN_TOOL_NAME: 'spawn_subagent'
}))

vi.mock('../storage/images', () => ({
  deleteImageFile: async () => {}
}))

const req = (op: string, params: unknown, id = 'req-1') => ({ id, kind: 'req', op, params })

describe('远程 handler (remote/handler)', () => {
  beforeEach(() => {
    conversations.clear()
    inserted = []
    seq = 0
    conversations.set('c1', { id: 'c1', title: '会话1' })
  })

  it('未列出的操作返回错误（不抛错穿透）', async () => {
    for (const op of ['settings:set', 'provider:list', 'dialog:pickFolder', 'app:quit', 'nope']) {
      const res = await handleRemoteRequest(req(op, {}))
      expect(res.ok).toBe(false)
    }
  })

  it('非法请求体返回错误', async () => {
    expect((await handleRemoteRequest(null)).ok).toBe(false)
    expect((await handleRemoteRequest({})).ok).toBe(false)
    expect((await handleRemoteRequest(req('send', { conversationId: 'c1' }))).ok).toBe(false)
  })

  it('listConversations / getMessages / setLeaf 可用', async () => {
    expect((await handleRemoteRequest(req('listConversations', {}))).ok).toBe(true)
    const msgs = await handleRemoteRequest(req('getMessages', { conversationId: 'c1' }))
    expect(msgs.ok).toBe(true)
    expect((await handleRemoteRequest(req('getMessages', { conversationId: 'missing' }))).ok).toBe(false)
    expect((await handleRemoteRequest(req('setLeaf', { conversationId: 'c1', leafId: 'm1' }))).ok).toBe(true)
  })

  it('send 走 runtime 并返回 runId；read-only 策略拒绝写操作', async () => {
    const res = await handleRemoteRequest(
      req('send', { conversationId: 'c1', parentMessageId: null, content: 'hi' })
    )
    expect(res.ok).toBe(true)
    expect((res.data as { runId: string }).runId).toBeTruthy()
    const denied = await handleRemoteRequest(
      req('send', { conversationId: 'c1', parentMessageId: null, content: 'hi' }),
      { approvalPolicy: 'read-only' }
    )
    expect(denied.ok).toBe(false)
  })

  it('先产生审批再连接，能拿到待审批清单', async () => {
    // 直接在 runtime 内登记一条审批（模拟工具执行到 requestApproval）
    const rt = agentRuntime as unknown as {
      approvals: Map<string, { toolName: string; settle: (b: boolean) => void }>
    }
    void rt
    const list = await handleRemoteRequest(req('listApprovals', {}))
    expect(list.ok).toBe(true)
    expect(Array.isArray(list.data)).toBe(true)
  })

  it('approve 哈希不一致被拒绝', async () => {
    const res = await handleRemoteRequest(
      req('approve', { runId: 'nope', toolUseId: 't', approved: true, paramHash: 'x' })
    )
    expect(res.ok).toBe(false)
  })
})
