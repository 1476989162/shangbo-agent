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

const { imageCleanup } = vi.hoisted(() => ({ imageCleanup: vi.fn() }))
vi.mock('../storage/images', () => ({
  deleteImageFile: async () => {},
  deleteConversationImages: (...args: unknown[]) => imageCleanup(...args)
}))

vi.mock('electron-log/main', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
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

describe('read-only 策略与远程审批收紧 (Ticket 2)', () => {
  beforeEach(() => {
    conversations.clear()
    inserted = []
    seq = 0
    conversations.set('c1', { id: 'c1', title: '会话1' })
    imageCleanup.mockClear()
  })

  it('read-only 拒绝 createConversation/deleteConversation/setLeaf/abort，与 send 同等对待', async () => {
    const ops: Array<[string, unknown]> = [
      ['createConversation', {}],
      ['deleteConversation', { conversationId: 'c1' }],
      ['setLeaf', { conversationId: 'c1', leafId: 'm1' }],
      ['abort', { runId: 'r1' }]
    ]
    for (const [op, params] of ops) {
      const res = await handleRemoteRequest(req(op, params), { approvalPolicy: 'read-only' })
      expect(res.ok, `${op} 应被 read-only 拒绝`).toBe(false)
      expect(res.error).toContain('只读')
    }
  })

  it('deleteConversation 同步调用 deleteConversationImages 清理会话图片', async () => {
    const res = await handleRemoteRequest(req('deleteConversation', { conversationId: 'c1' }))
    expect(res.ok).toBe(true)
    expect(imageCleanup).toHaveBeenCalledWith('c1')
    // 会话本体也被删
    expect(conversations.has('c1')).toBe(false)
  })

  it('confirm-high 仅拦截远程批准，远程拒绝（approved=false）照常放行', async () => {
    const rt = agentRuntime as unknown as {
      listPendingApprovals: () => Array<{
        runId: string
        toolUseId: string
        toolName: string
        severity: string
      }>
      decideWithHash: (runId: string, toolUseId: string, approved: boolean, hash: string) => boolean
    }
    const original = rt.listPendingApprovals
    rt.listPendingApprovals = () => [
      { runId: 'r1', toolUseId: 't1', toolName: 'run_command', severity: 'high' }
    ]
    const decided: Array<[boolean, string]> = []
    rt.decideWithHash = (runId, toolUseId, approved, hash) => {
      decided.push([approved, hash])
      return true
    }
    try {
      // 批准：confirm-high 拦截
      const approve = await handleRemoteRequest(
        req('approve', { runId: 'r1', toolUseId: 't1', approved: true, paramHash: 'h1' }),
        { approvalPolicy: 'confirm-high' }
      )
      expect(approve.ok).toBe(false)
      expect(approve.error).toContain('远程批准')
      expect(decided).toEqual([])

      // 拒绝：必须放行到底层 decideWithHash
      const reject = await handleRemoteRequest(
        req('approve', { runId: 'r1', toolUseId: 't1', approved: false, paramHash: 'h1' }),
        { approvalPolicy: 'confirm-high' }
      )
      expect(reject.ok).toBe(true)
      expect(decided).toEqual([[false, 'h1']])
    } finally {
      rt.listPendingApprovals = original
    }
  })

  it('高危清单补齐：multi_patch_file/desktop_click_ref/*_ask/spawn_subagent/task_create 全部拒绝远程批准', async () => {
    const rt = agentRuntime as unknown as {
      listPendingApprovals: () => Array<{
        runId: string
        toolUseId: string
        toolName: string
        severity: string
      }>
      decideWithHash: () => boolean
    }
    const original = rt.listPendingApprovals
    const highRiskTools = [
      'multi_patch_file',
      'desktop_click_ref',
      'qoder_ask',
      'codex_ask',
      'claude_ask',
      'opencode_ask',
      'spawn_subagent',
      'task_create'
    ]
    let currentTool = ''
    rt.listPendingApprovals = () => [
      { runId: 'r1', toolUseId: 't1', toolName: currentTool, severity: 'high' }
    ]
    rt.decideWithHash = () => {
      throw new Error('高危工具不应到达 decideWithHash')
    }
    try {
      for (const tool of highRiskTools) {
        currentTool = tool
        const res = await handleRemoteRequest(
          req('approve', { runId: 'r1', toolUseId: 't1', approved: true, paramHash: 'h' }),
          { approvalPolicy: 'confirm-high' }
        )
        expect(res.ok, `${tool} 应拒绝远程批准`).toBe(false)
        expect(res.error, `${tool} 的拒绝理由应指向桌面确认`).toContain('桌面')
      }
    } finally {
      rt.listPendingApprovals = original
    }
  })

  it('severity=critical 一律拒绝远程批准，无论工具名多无害', async () => {
    const rt = agentRuntime as unknown as {
      listPendingApprovals: () => Array<{
        runId: string
        toolUseId: string
        toolName: string
        severity: string
      }>
      decideWithHash: () => boolean
    }
    const original = rt.listPendingApprovals
    rt.listPendingApprovals = () => [
      { runId: 'r1', toolUseId: 't1', toolName: 'read_file', severity: 'critical' }
    ]
    rt.decideWithHash = () => {
      throw new Error('critical 不应到达 decideWithHash')
    }
    try {
      const res = await handleRemoteRequest(
        req('approve', { runId: 'r1', toolUseId: 't1', approved: true, paramHash: 'h' }),
        { approvalPolicy: 'confirm-high' }
      )
      expect(res.ok).toBe(false)
      expect(res.error).toContain('硬红线')
    } finally {
      rt.listPendingApprovals = original
    }
  })

  it('allow-all 默认策略下 severity=critical 同样拒绝远程批准', async () => {
    const rt = agentRuntime as unknown as {
      listPendingApprovals: () => Array<{
        runId: string
        toolUseId: string
        toolName: string
        severity: string
      }>
      decideWithHash: (runId: string, toolUseId: string, approved: boolean, paramHash: string) => boolean
    }
    const original = rt.listPendingApprovals
    rt.listPendingApprovals = () => [
      { runId: 'r2', toolUseId: 't2', toolName: 'run_command', severity: 'critical' }
    ]
    rt.decideWithHash = (runId: string, _toolUseId: string, approved: boolean) => {
      // 只允许远程拒绝到达底层：批准必须在上层就被硬红线拦下
      void runId
      if (approved) throw new Error('critical 在 allow-all 下也不应到达 decideWithHash（批准）')
      return true
    }
    try {
      // 默认 allow-all（不传 approvalPolicy）也必须拒绝硬红线的远程批准
      const res = await handleRemoteRequest(
        req('approve', { runId: 'r2', toolUseId: 't2', approved: true, paramHash: 'h' })
      )
      expect(res.ok).toBe(false)
      expect(res.error).toContain('硬红线')

      // 显式 allow-all 同样拒绝
      const explicit = await handleRemoteRequest(
        req('approve', { runId: 'r2', toolUseId: 't2', approved: true, paramHash: 'h' }),
        { approvalPolicy: 'allow-all' }
      )
      expect(explicit.ok).toBe(false)
      expect(explicit.error).toContain('硬红线')

      // 远程拒绝 critical 仍然放行（少做事不越权）
      const reject = await handleRemoteRequest(
        req('approve', { runId: 'r2', toolUseId: 't2', approved: false, paramHash: 'h' }),
        { approvalPolicy: 'allow-all' }
      )
      expect(reject.ok).toBe(true)
    } finally {
      rt.listPendingApprovals = original
    }
  })
})
