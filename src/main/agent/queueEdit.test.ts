import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent, Message } from '../../shared/types'

/* 排队消息的编辑与撤回。与 queue.test.ts 同样的手法：
   mock 掉 electron / db / 网关，直接驱动真实的 AgentRuntime。 */

const conversations = new Map<string, { id: string; title: string; systemPrompt: string | null; workingDir: string | null }>()
/** 每个测试一份独立存储：前一个测试遗留的异步回合会写进下一个测试的数组。 */
let inserted: Message[] = []
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

const deletedFiles: string[] = []

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/shangbo-test' },
  protocol: { handle: () => {}, registerSchemesAsPrivileged: () => {} }
}))

vi.mock('../storage/images', () => ({
  hydrateImages: async (b: unknown) => b,
  deleteImageFile: async (relative: string) => {
    deletedFiles.push(relative)
  }
}))

vi.mock('../db/repo', () => ({
  getConversation: (id: string) => conversations.get(id) ?? null,
  getMessage: (id: string) => inserted.find((m) => m.id === id) ?? null,
  getActiveLeaf: (c: string) => leafByConversation.get(c) ?? null,
  getActivePath: (c: string) => inserted.filter((m) => m.conversationId === c),
  setActiveLeaf: (c: string, leaf: string) => {
    leafByConversation.set(c, leaf)
  },
  insertMessage: (input: Partial<Message> & { conversationId: string }) => {
    const m = makeUserMessage(input.conversationId, 'x')
    Object.assign(m, input)
    inserted.push(m)
    return m
  },
  updateMessage: (id: string, patch: Partial<Message>) => {
    const m = inserted.find((x) => x.id === id)
    if (m) Object.assign(m, patch)
    return m ?? null
  },
  deleteSubtree: (id: string) => {
    const index = inserted.findIndex((m) => m.id === id)
    if (index >= 0) inserted.splice(index, 1)
  },
  updateConversation: (id: string, patch: { title?: string }) => {
    const c = conversations.get(id)
    if (c && patch.title) c.title = patch.title
  },
  touchConversation: () => {},
  listMessages: () => inserted
}))

vi.mock('../providers/gateway', () => ({
  streamWithFallback: async function* () {
    await new Promise<void>((r) => setTimeout(r, 50))
    yield { type: 'stop', reason: 'end_turn' } as const
  }
}))

vi.mock('../providers/store', () => ({
  routingOrder: () => [{ id: 'p1', name: '测试供应商', models: ['m1'] }]
}))

vi.mock('../settings', () => ({
  getSetting: (_k: string, fallback: unknown) => fallback,
  setSetting: () => {}
}))

vi.mock('../tools', () => ({
  auditCommandSecurity: () => ({ allowed: true }),
  toolRegistry: { all: () => [], schemas: () => [] }
}))

vi.mock('../mcp/manager', () => ({
  mcpManager: { listTools: () => [], tools: () => [], toolSchemas: () => [], allTools: () => [] },
  parseMcpToolName: (n: string) => n
}))

vi.mock('./subagent', () => ({
  runSubagent: async () => ({ content: '', isError: false }),
  SPAWN_SUBAGENT_SCHEMA: {},
  SPAWN_TOOL_NAME: 'spawn_subagent'
}))

const drain = (ms = 300): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('排队消息的编辑与撤回', () => {
  let runtime: InstanceType<typeof import('./runtime').AgentRuntime>

  beforeEach(async () => {
    vi.resetModules()
    conversations.clear()
    inserted = []
    deletedFiles.length = 0
    leafByConversation = new Map()
    seq = 0
    conversations.set('c1', { id: 'c1', title: '会话1', systemPrompt: '系统提示', workingDir: null })
    const { AgentRuntime } = await import('./runtime')
    runtime = new AgentRuntime()
  })

  const noop = (): void => {}

  it('撤回排队消息会删除其落库记录', async () => {
    runtime.send({ conversationId: 'c1', parentMessageId: null, content: '第一条' }, noop)
    runtime.send({ conversationId: 'c1', parentMessageId: null, content: '排队的那条' }, noop)

    const queued = inserted.find((m) => m.blocks.some((b) => b.type === 'text' && b.text === '排队的那条'))
    expect(queued).toBeDefined()

    const ok = await runtime.cancelQueuedMessage('c1', queued!.id)
    expect(ok).toBe(true)
    expect(inserted.some((m) => m.id === queued!.id)).toBe(false)
    // 队列里也确实少了一项
    expect(runtime.queueLength('c1')).toBe(0)
    // 等这一轮真正跑完，避免影响下一个测试
    await drain(150)
  })

  it('撤回排队消息会连带删除已落盘的图片', async () => {
    runtime.send({ conversationId: 'c1', parentMessageId: null, content: '第一条' }, noop)
    runtime.send(
      {
        conversationId: 'c1',
        parentMessageId: null,
        content: '带图的排队消息',
        images: [{ mimeType: 'image/png', file: 'c1/abc.png' }]
      },
      noop
    )

    const queued = inserted.find((m) => m.blocks.some((b) => b.type === 'text' && b.text === '带图的排队消息'))
    expect(queued).toBeDefined()

    await runtime.cancelQueuedMessage('c1', queued!.id)
    // 图片文件被清理，不留孤儿
    expect(deletedFiles).toContain('c1/abc.png')
    // 等这一轮真正跑完，避免影响下一个测试
    await drain(150)
  })

  it('撤回不存在的消息返回 false，不误删', async () => {
    const ok = await runtime.cancelQueuedMessage('c1', '不存在的id')
    expect(ok).toBe(false)
  })

  it('撤回时不会删掉别人的消息', async () => {
    runtime.send({ conversationId: 'c1', parentMessageId: null, content: '我的消息' }, noop)
    await runtime.cancelQueuedMessage('c2', inserted[0].id)
    expect(inserted.some((m) => m.blocks.some((b) => b.type === 'text' && b.text === '我的消息'))).toBe(true)
  })

  it('编辑排队消息会改库并保留图片块', async () => {
    runtime.send({ conversationId: 'c1', parentMessageId: null, content: '第一条' }, noop)
    runtime.send(
      {
        conversationId: 'c1',
        parentMessageId: null,
        content: '写错了',
        images: [{ mimeType: 'image/png', file: 'c1/x.png' }]
      },
      noop
    )

    const queued = inserted.find((m) => m.blocks.some((b) => b.type === 'text' && b.text === '写错了'))
    expect(queued).toBeDefined()

    const ok = runtime.editQueuedMessage('c1', queued!.id, '改好了')
    expect(ok).toBe(true)

    const after = inserted.find((m) => m.id === queued!.id)
    // 文本被替换
    expect(after!.blocks.some((b) => b.type === 'text' && b.text === '改好了')).toBe(true)
    expect(after!.blocks.some((b) => b.type === 'text' && b.text === '写错了')).toBe(false)
    // 图片块保留——它是这条消息的一部分，不该被编辑抹掉
    expect(after!.blocks.some((b) => b.type === 'image')).toBe(true)
    // 等这一轮真正跑完，避免影响下一个测试
    await drain(150)
  })

  it('编辑后真正执行的是新内容', async () => {
    const events: AgentEvent[] = []
    const emit = (e: AgentEvent): void => {
      events.push(e)
    }
    runtime.send({ conversationId: 'c1', parentMessageId: null, content: '第一条' }, emit)
    runtime.send({ conversationId: 'c1', parentMessageId: null, content: '原内容' }, emit)

    const queued = inserted.find((m) => m.blocks.some((b) => b.type === 'text' && b.text === '原内容'))
    runtime.editQueuedMessage('c1', queued!.id, '改后的内容')

    await drain(400)
    // 库里最终是新内容，说明开跑时用的是编辑后的 payload
    expect(inserted.some((m) => m.blocks.some((b) => b.type === 'text' && b.text === '改后的内容'))).toBe(true)
  })

  it('编辑空内容被拒绝', async () => {
    runtime.send({ conversationId: 'c1', parentMessageId: null, content: '第一条' }, noop)
    runtime.send({ conversationId: 'c1', parentMessageId: null, content: '排队' }, noop)
    const queued = inserted.find((m) => m.blocks.some((b) => b.type === 'text' && b.text === '排队'))
    expect(runtime.editQueuedMessage('c1', queued!.id, '   ')).toBe(false)
    // 等这一轮真正跑完，避免影响下一个测试
    await drain(150)
  })

  it('撤回后队列里剩下的项仍会正常执行', async () => {
    const events: AgentEvent[] = []
    const emit = (e: AgentEvent): void => {
      events.push(e)
    }
    runtime.send({ conversationId: 'c1', parentMessageId: null, content: 'A' }, emit)
    runtime.send({ conversationId: 'c1', parentMessageId: null, content: 'B撤回' }, emit)
    runtime.send({ conversationId: 'c1', parentMessageId: null, content: 'C保留' }, emit)

    const toCancel = inserted.find((m) => m.blocks.some((b) => b.type === 'text' && b.text === 'B撤回'))
    await runtime.cancelQueuedMessage('c1', toCancel!.id)

    await drain(400)
    // 被撤回的不该被执行，保留下来的应当接力跑完
    expect(inserted.some((m) => m.blocks.some((b) => b.type === 'text' && b.text === 'B撤回'))).toBe(false)
    expect(events.filter((e) => e.type === 'run_start').length).toBe(2)
  })
})
