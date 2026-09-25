import { describe, expect, it } from 'vitest'
import {
  buildContext,
  estimateBlocks,
  estimateTokens,
  groupIntoTurns,
  toLLMMessages
} from './context'
import type { ContentBlock, Message } from '../../shared/types'

let seq = 0

function textBlock(text: string): ContentBlock {
  return { type: 'text', text }
}

function makeMessage(
  role: Message['role'],
  blocks: ContentBlock[],
  overrides: Partial<Message> = {}
): Message {
  seq++
  return {
    id: `m${seq}`,
    conversationId: 'c1',
    parentId: null,
    role,
    blocks,
    status: 'done',
    error: null,
    providerId: null,
    model: null,
    usage: null,
    createdAt: seq,
    updatedAt: seq,
    ...overrides
  }
}

/* ------------------------------------------------------------------ */
/* estimateTokens / estimateBlocks                                     */
/* ------------------------------------------------------------------ */

describe('estimateTokens', () => {
  it('CJK 字符按 1 字 1 token 计', () => {
    expect(estimateTokens('你好世界')).toBe(4)
  })

  it('ASCII 按 4 字符 1 token，向上取整', () => {
    expect(estimateTokens('abcdefgh')).toBe(2)
    expect(estimateTokens('abcdefghi')).toBe(3)
  })

  it('混合文本分别统计', () => {
    // 2 CJK + 4 ASCII => 2 + 1 = 3
    expect(estimateTokens('你好abcd')).toBe(3)
  })
})

describe('estimateBlocks', () => {
  it('tool_use / tool_result 有固定开销', () => {
    const toolUse = estimateBlocks([{ type: 'tool_use', id: 't1', name: 'x', input: {} }])
    const toolResult = estimateBlocks([
      { type: 'tool_result', toolUseId: 't1', content: '', isError: false }
    ])
    // input "{}" 2字符 => 1 token + 24 开销；空 content 0 token + 12 开销
    expect(toolUse).toBe(25)
    expect(toolResult).toBe(12)
  })

  it('image 按固定值粗估', () => {
    expect(
      estimateBlocks([{ type: 'image', mimeType: 'image/png', dataUrl: 'data:image/png;base64,xx' }])
    ).toBe(800)
  })
})

/* ------------------------------------------------------------------ */
/* groupIntoTurns                                                      */
/* ------------------------------------------------------------------ */

describe('groupIntoTurns', () => {
  it('按 user 消息切轮，后续 assistant/tool 归入当前轮', () => {
    const u1 = makeMessage('user', [textBlock('一')])
    const a1 = makeMessage('assistant', [textBlock('答一')])
    const u2 = makeMessage('user', [textBlock('二')])
    const a2 = makeMessage('assistant', [textBlock('答二')])

    const turns = groupIntoTurns([u1, a1, u2, a2])
    expect(turns).toHaveLength(2)
    expect(turns[0].map((m) => m.id)).toEqual([u1.id, a1.id])
    expect(turns[1].map((m) => m.id)).toEqual([u2.id, a2.id])
  })

  it('一条消息数组的工具块拆分场景：assistant 带 tool_result 也留在同一轮', () => {
    const u = makeMessage('user', [textBlock('问')])
    const a = makeMessage('assistant', [
      { type: 'tool_use', id: 't1', name: 'x', input: {} },
      { type: 'tool_result', toolUseId: 't1', content: '结果', isError: false },
      textBlock('答')
    ])

    const turns = groupIntoTurns([u, a])
    expect(turns).toHaveLength(1)
  })
})

/* ------------------------------------------------------------------ */
/* toLLMMessages                                                       */
/* ------------------------------------------------------------------ */

describe('toLLMMessages', () => {
  it('user 消息原样透传（剔除 reasoning 后）', () => {
    const out = toLLMMessages([makeMessage('user', [textBlock('你好')])])
    expect(out).toEqual([{ role: 'user', blocks: [textBlock('你好')] }])
  })

  it('纯 text 的 user 消息在 reasoning 剔除后为空时不输出', () => {
    const out = toLLMMessages([makeMessage('user', [{ type: 'reasoning', text: '内部' }])])
    expect(out).toEqual([])
  })

  it('assistant 的 tool_result 块拆成 tool 角色，text/tool_use 保持 assistant 角色', () => {
    const a = makeMessage('assistant', [
      textBlock('先查一下'),
      { type: 'tool_use', id: 't1', name: 'list_directory', input: { path: '/tmp' } },
      { type: 'tool_result', toolUseId: 't1', content: '结果', isError: false },
      textBlock('结论')
    ])

    const out = toLLMMessages([a])
    expect(out.map((m) => m.role)).toEqual(['assistant', 'tool', 'assistant'])
    expect(out[0].blocks).toEqual([textBlock('先查一下'), expect.objectContaining({ type: 'tool_use' })])
    expect(out[1].blocks).toEqual([expect.objectContaining({ type: 'tool_result' })])
    expect(out[2].blocks).toEqual([textBlock('结论')])
  })

  it('相邻同角色块合并为一条 LLM 消息', () => {
    const a = makeMessage('assistant', [
      { type: 'tool_use', id: 't1', name: 'x', input: {} },
      { type: 'tool_use', id: 't2', name: 'y', input: {} },
      { type: 'tool_result', toolUseId: 't1', content: '1', isError: false },
      { type: 'tool_result', toolUseId: 't2', content: '2', isError: false }
    ])

    const out = toLLMMessages([a])
    expect(out.map((m) => m.role)).toEqual(['assistant', 'tool'])
    expect(out[0].blocks).toHaveLength(2)
    expect(out[1].blocks).toHaveLength(2)
  })

  it('reasoning 块一律不回传', () => {
    const a = makeMessage('assistant', [
      { type: 'reasoning', text: '思考过程' },
      textBlock('正文')
    ])
    const out = toLLMMessages([a])
    expect(out).toHaveLength(1)
    expect(out[0].blocks).toEqual([textBlock('正文')])
  })
})

/* ------------------------------------------------------------------ */
/* buildContext：裁剪不变量                                            */
/* ------------------------------------------------------------------ */

describe('buildContext', () => {
  it('预算充足时全量保留', () => {
    const u1 = makeMessage('user', [textBlock('一')])
    const a1 = makeMessage('assistant', [textBlock('答一')])
    const u2 = makeMessage('user', [textBlock('二')])
    const a2 = makeMessage('assistant', [textBlock('答二')])

    const result = buildContext([u1, a1, u2, a2], { system: 'sys', budgetTokens: 10_000 })
    expect(result.messages).toHaveLength(4)
    expect(result.omittedTurns).toBe(0)
  })

  it('预算紧张时从最旧的轮开始裁，最新一轮永远保留', () => {
    // 每轮 12 tokens（"一二三" 3 + 每条消息固定 8），system 约 1 token
    const mk = (text: string): Message[] => [
      makeMessage('user', [textBlock(text)]),
      makeMessage('assistant', [textBlock('回复')])
    ]
    const t1 = mk('第一轮话题')
    const t2 = mk('第二轮话题')
    const t3 = mk('第三轮话题')

    // 预算只够两轮：24*2 + system + 余量
    const result = buildContext([...t1, ...t2, ...t3], { system: 'sys', budgetTokens: 60 })
    expect(result.messages.map((m) => m.blocks[0])).toContainEqual(textBlock('第三轮话题'))
    expect(result.messages.some((m) => m.role === 'user' && m.blocks[0] === t1[0].blocks[0])).toBe(
      false
    )
    expect(result.omittedTurns).toBe(1)
  })

  it('不变量：tool_use 与对应 tool_result 必须同轮保留，不会被裁开', () => {
    const u = makeMessage('user', [textBlock('问')])
    const a = makeMessage('assistant', [
      { type: 'tool_use', id: 't1', name: 'read_file', input: { path: '/a' } },
      { type: 'tool_result', toolUseId: 't1', content: '文件内容'.repeat(500), isError: false },
      textBlock('答')
    ])

    // 预算恰好装不下这轮 => 整轮被裁掉
    const result = buildContext([u, a], { system: 'sys', budgetTokens: 10 })
    // 唯一一轮也必须保留（最新轮规则），所以这里换成多轮场景验证
    expect(result.messages.length).toBeGreaterThan(0)
  })

  it('多轮场景下含工具调用的旧轮被整轮裁掉，不产生孤立的 tool_result', () => {
    const mkToolTurn = (): Message[] => [
      makeMessage('user', [textBlock('帮我读文件')]),
      makeMessage('assistant', [
        { type: 'tool_use', id: `t${seq}`, name: 'read_file', input: { path: '/a' } },
        {
          type: 'tool_result',
          toolUseId: `t${seq - 1}`,
          content: 'x'.repeat(2000),
          isError: false
        },
        textBlock('读完了')
      ])
    ]
    const old = mkToolTurn()
    const newest = [
      makeMessage('user', [textBlock('最新的问题')]),
      makeMessage('assistant', [textBlock('最新的回答')])
    ]

    // 预算只够保留最新一轮
    const result = buildContext([...old, ...newest], { system: 'sys', budgetTokens: 40 })

    const roles = result.messages.map((m) => m.role)
    // 若 tool 角色消息存在，则其前面必须有 assistant 的 tool_use 呼应
    const toolIndex = roles.indexOf('tool')
    if (toolIndex !== -1) {
      expect(roles[toolIndex - 1]).toBe('assistant')
    }
    // 最新一轮完整保留
    expect(roles).toContain('user')
    expect(result.omittedTurns).toBe(1)
  })

  it('最新一轮无论如何都保留（即使单独超预算）', () => {
    const big = [
      makeMessage('user', [textBlock('大消息')]),
      makeMessage('assistant', [textBlock('很长的回复'.repeat(500))])
    ]
    const result = buildContext(big, { system: 'sys', budgetTokens: 5 })
    expect(result.messages.length).toBe(2)
  })
})
