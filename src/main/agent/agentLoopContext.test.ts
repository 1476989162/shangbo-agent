import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ContentBlock, Message } from '../../shared/types'

/* Ticket 4：agentLoop 长回合行为回归（集成级，用 mock 跑完整 runAgentLoop）。
 * 1. Wish 验收失败的 fixFeedback 必须以 user 角色注入下一轮，且不污染
 *    最终持久化的 assistant 正文。
 * 2. 思考截断续写执行完 continued 工具后，必须再请求一次模型，
 *    让工具结果回传给模型（而不是烂在 blocks 里）。
 */

vi.mock('electron', () => ({ app: { getPath: () => 'C:\\UserData\\shangbo-agent' } }))
vi.mock('electron-log/main', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

const { settingOverrides, streamScripts, updateCalls, inserted } = vi.hoisted(() => ({
  settingOverrides: {} as Record<string, unknown>,
  streamScripts: [] as Array<(req: any) => AsyncGenerator<any>>,
  updateCalls: [] as Array<{ id: string; patch: any }>,
  inserted: [] as unknown as any[]
}))

vi.mock('../settings', () => ({
  getSetting: (key: string, fallback: unknown) =>
    key in settingOverrides ? (settingOverrides as Record<string, unknown>)[key] : fallback
}))

vi.mock('../db/repo', () => ({
  getConversation: (id: string) => ({
    id,
    workingDir: 'C:\\tmp',
    mode: 'chat',
    model: null,
    systemPrompt: null
  }),
  insertMessage: (input: any) => {
    const m = { id: `m${inserted.length + 1}`, status: 'streaming', ...input }
    inserted.push(m)
    return m
  },
  getPathTo: (id: string) => {
    void id
    return (globalThis as any).__path ?? []
  },
  updateMessage: (id: string, patch: any) => {
    updateCalls.push({ id, patch })
  },
  getActiveLeaf: () => 'u1',
  setActiveLeaf: () => {},
  touchConversation: () => {},
  getConversationSummary: () => null,
  setConversationSummary: () => {}
}))

vi.mock('../mcp/manager', () => ({
  mcpManager: { toolSchemas: async () => [] }
}))

vi.mock('../autonomous/store', () => ({
  lessonForTask: () => undefined,
  listLessons: () => [],
  markLessonsUsed: () => {},
  upsertLesson: () => {}
}))

vi.mock('../tools', () => ({
  auditCommandSecurity: () => ({ isDangerous: false, reason: '' }),
  toolRegistry: { get: () => undefined, all: () => [], schemas: () => [] }
}))

vi.mock('../tools/todo', () => ({
  getTodoItems: () => []
}))

vi.mock('../providers/store', () => ({
  routingOrder: () => [{ id: 'p1', name: 'Mock', models: ['mock-model'] }]
}))

const streamMock = vi.fn(async function* (..._args: unknown[]) {
  const script = streamScripts.shift()
  if (script) yield* script({} as never)
})
vi.mock('../providers/gateway', () => ({
  // agentLoop 统一走网关真源判定推理模型；单测默认非推理模型
  isReasoningModel: () => false,
  streamWithFallback: (...args: unknown[]) => streamMock(...args)
}))

vi.mock('../skills/loader', () => ({
  getCachedSkillRouterPrompt: () => 'cached-router',
  buildSkillRouterPrompt: async () => '',
  scanAllSkillPacks: async () => []
}))

import { runAgentLoop } from './agentLoop'

function textBlock(text: string): ContentBlock {
  return { type: 'text', text }
}

function makeUserMessage(id: string, text: string): Message {
  return {
    id,
    conversationId: 'c1',
    parentId: null,
    role: 'user',
    blocks: [textBlock(text)],
    status: 'done',
    error: null,
    providerId: null,
    model: null,
    usage: null,
    usageMode: null,
    createdAt: 1,
    updatedAt: 1
  }
}

function baseSettings(): void {
  for (const k of Object.keys(settingOverrides)) delete settingOverrides[k as keyof typeof settingOverrides]
  Object.assign(settingOverrides, {
    'agent.wish.enabled': true,
    'agent.wish.autoVerify': true,
    'agent.wish.verifyRetries': 1,
    'agent.wish.evolve': false,
    'agent.context.summarize': false,
    'agent.readOnly': false,
    'agent.computerUse': false,
    'agent.mode': 'auto',
    'agent.plugins': [],
    'cowork.useMemory': false,
    'cowork.globalInstructions': '',
    'provider.anthropic.promptCache': true
  })
}

function baseHooks() {
  return {
    git: async () => null,
    summarizeHistory: async () => null,
    takeSteeringNotes: () => [] as string[],
    invokeTool: async () => ({ content: 'FILE-CONTENT', isError: false }),
    composeUsage: () => null
  }
}

const baseConversation = { id: 'c1', systemPrompt: null as string | null, workingDir: 'C:\\tmp', mode: 'chat' as const }

beforeEach(() => {
  streamScripts.length = 0
  updateCalls.length = 0
  inserted.length = 0
  streamMock.mockClear()
  baseSettings()
  ;(globalThis as any).__path = []
})

describe('Wish 验收失败反馈 (Ticket 4)', () => {
  it('fixFeedback 以 user 角色注入下一轮，且不污染最终 assistant 正文', async () => {
    Object.assign(settingOverrides, {
      'agent.wish.verifyCommand': '__nonexistent_cmd_xyz__'
    })
    const userMessage = makeUserMessage('u1', '做点事情')
    ;(globalThis as any).__path = [userMessage]

    // 第 1 次 stream：无输出无工具 → 走 wish 验收 → 命令执行失败
    streamScripts.push(async function* () {
      // 空：直接结束，让 toolUses 为空
    })
    // 第 2 次 stream：收到 user 反馈后正常收尾
    let secondRequestMessages: any[] | null = null
    streamScripts.push(async function* () {
      secondRequestMessages = (streamMock.mock.calls[1] as unknown as any[])[0].messages
      yield { type: 'text', text: '已修复' }
      yield { type: 'stop', reason: 'stop' }
    })

    const events: any[] = []
    await runAgentLoop(
      baseHooks() as any,
      'run-1',
      { ...baseConversation },
      userMessage,
      { providerId: 'p1', model: 'mock-model' },
      ((e: any) => events.push(e)) as any,
      new AbortController(),
      { effectiveMode: 'wish' }
    )

    // 下一轮请求里出现了 user 角色的失败反馈
    expect(secondRequestMessages).not.toBeNull()
    const feedbackMsgs = (secondRequestMessages as unknown as any[]).filter((m) => m.role === 'user')
    const feedbackTexts = feedbackMsgs.flatMap((m) =>
      m.blocks.filter((b: any) => b.type === 'text').map((b: any) => b.text)
    )
    expect(feedbackTexts.some((t: string) => t.includes('自动验收未通过'))).toBe(true)

    // 最终持久化的 assistant 正文里没有失败反馈（不污染）
    const lastUpdate = updateCalls[updateCalls.length - 1]
    const persistedTexts = (lastUpdate.patch.blocks as ContentBlock[])
      .filter((b) => b.type === 'text')
      .map((b) => (b as { text: string }).text)
      .join('\n')
    expect(persistedTexts).not.toContain('自动验收未通过')
  })
})

describe('思考截断续写回传工具结果 (Ticket 4)', () => {
  it('continued 工具执行后必须再请求一次模型', async () => {
    const userMessage = makeUserMessage('u1', '想一个难题')
    ;(globalThis as any).__path = [userMessage]

    // 第 1 次：只有 reasoning + max_tokens 截断 → 触发续写
    streamScripts.push(async function* () {
      yield { type: 'reasoning', text: '深度思考中' }
      yield { type: 'stop', reason: 'max_tokens' }
    })
    // 续写第 1 轮：只调工具不给正文
    streamScripts.push(async function* () {
      yield { type: 'tool_use', id: 'c1', name: 'read_file', input: {} }
      yield { type: 'stop', reason: 'stop' }
    })
    // 续写第 2 轮：必须能看到工具结果（由测试断言），然后给正文
    let thirdRequestMessages: any[] | null = null
    streamScripts.push(async function* () {
      thirdRequestMessages = (streamMock.mock.calls[2] as unknown as any[])[0].messages
      yield { type: 'text', text: '搞定了' }
      yield { type: 'stop', reason: 'stop' }
    })

    await runAgentLoop(
      baseHooks() as any,
      'run-2',
      { ...baseConversation },
      userMessage,
      { providerId: 'p1', model: 'mock-model' },
      (() => {}) as any,
      new AbortController(),
      { effectiveMode: 'chat' }
    )

    // 一共 3 次模型请求（首轮 + 续写两轮）：工具结果被回传了
    expect(streamMock).toHaveBeenCalledTimes(3)
    expect(thirdRequestMessages).not.toBeNull()
    const toolContents: string[] = []
    const toolUseIds: string[] = []
    for (const m of thirdRequestMessages as unknown as any[]) {
      for (const b of m.blocks ?? []) {
        if (b.type === 'tool_result') toolContents.push(b.content)
        if (b.type === 'tool_use') toolUseIds.push(b.id)
      }
    }
    expect(toolContents.some((c) => c.includes('FILE-CONTENT'))).toBe(true)
    // P0：同一 tool_use_id 绝不重复发送（重复会导致供应商 400）
    expect(toolUseIds.filter((id) => id === 'c1')).toHaveLength(1)
    expect(toolContents.filter((c) => c.includes('FILE-CONTENT'))).toHaveLength(1)

    // 最终落库同时包含工具结果与正文
    const lastUpdate = updateCalls[updateCalls.length - 1]
    const types = (lastUpdate.patch.blocks as ContentBlock[]).map((b) => b.type)
    expect(types).toContain('tool_result')
    expect(types).toContain('text')
  })

  it('续写同时输出前导正文 + 调工具时，仍会再次请求模型回传工具结果', async () => {
    const userMessage = makeUserMessage('u1', '想一个难题')
    ;(globalThis as any).__path = [userMessage]

    // 第 1 次：reasoning + 截断 → 触发续写
    streamScripts.push(async function* () {
      yield { type: 'reasoning', text: '深度思考中' }
      yield { type: 'stop', reason: 'max_tokens' }
    })
    // 续写第 1 轮：先给前导正文，又调了工具（旧逻辑见有正文就直接结束，工具结果烂掉）
    streamScripts.push(async function* () {
      yield { type: 'text', text: '前导结论' }
      yield { type: 'tool_use', id: 'c2', name: 'read_file', input: { path: '/a' } }
      yield { type: 'stop', reason: 'stop' }
    })
    // 续写第 2 轮：必须发生（把工具结果带回给模型），然后收尾
    let thirdRequestMessages: any[] | null = null
    streamScripts.push(async function* () {
      thirdRequestMessages = (streamMock.mock.calls[2] as unknown as any[])[0].messages
      yield { type: 'text', text: '最终答案' }
      yield { type: 'stop', reason: 'stop' }
    })

    await runAgentLoop(
      baseHooks() as any,
      'run-2b',
      { ...baseConversation },
      userMessage,
      { providerId: 'p1', model: 'mock-model' },
      (() => {}) as any,
      new AbortController(),
      { effectiveMode: 'chat' }
    )

    // 旧逻辑下只有 2 次请求（续写第 1 轮后直接结束）；修复后必须有第 3 次
    expect(streamMock).toHaveBeenCalledTimes(3)
    expect(thirdRequestMessages).not.toBeNull()
    const seen = { toolUse: 0, toolResult: 0 }
    for (const m of thirdRequestMessages as unknown as any[]) {
      for (const b of m.blocks ?? []) {
        if (b.type === 'tool_use' && b.id === 'c2') seen.toolUse++
        if (b.type === 'tool_result' && String(b.content).includes('FILE-CONTENT')) seen.toolResult++
      }
    }
    expect(seen).toEqual({ toolUse: 1, toolResult: 1 })
  })

  it('主循环中超长 tool_result 发给模型时已被截断且不重复，DB 保留原文', async () => {
    const userMessage = makeUserMessage('u1', '读个大文件')
    ;(globalThis as any).__path = [userMessage]
    const huge = 'X'.repeat(20000)

    // 第 1 次：调工具，返回超长结果
    streamScripts.push(async function* () {
      yield { type: 'tool_use', id: 't9', name: 'read_file', input: { path: '/big' } }
      yield { type: 'stop', reason: 'stop' }
    })
    // 第 2 次：检查发往模型的请求内容
    let secondRequestMessages: any[] | null = null
    streamScripts.push(async function* () {
      secondRequestMessages = (streamMock.mock.calls[1] as unknown as any[])[0].messages
      yield { type: 'text', text: '读完了' }
      yield { type: 'stop', reason: 'stop' }
    })
    const invoke = vi.fn(async () => ({ content: huge, isError: false }))
    const hooks = { ...baseHooks(), invokeTool: invoke }

    await runAgentLoop(
      hooks as any,
      'run-2c',
      { ...baseConversation },
      userMessage,
      { providerId: 'p1', model: 'mock-model' },
      (() => {}) as any,
      new AbortController(),
      { effectiveMode: 'chat' }
    )

    expect(secondRequestMessages).not.toBeNull()
    const flat = JSON.stringify(secondRequestMessages)
    // 发往模型的请求里没有 20000 字原文（已被截断），且截断标记恰好出现 1 次
    expect(flat.includes(huge)).toBe(false)
    const markerCount = flat.split('已截断前').length - 1
    expect(markerCount).toBe(1)
    // tool_use id=t9 在整个请求里恰好出现 1 次（P0：绝无重复发送）
    const useCount = (flat.match(/"id":"t9"/g) ?? []).length
    expect(useCount).toBe(1)

    // DB 持久化保留原文（截断只发生在发往模型的拷贝上）
    const lastUpdate = updateCalls[updateCalls.length - 1]
    const persistedContents = (lastUpdate.patch.blocks as ContentBlock[])
      .filter((b) => b.type === 'tool_result')
      .map((b) => (b as { content: string }).content)
    expect(persistedContents).toContain(huge)
  })
})
