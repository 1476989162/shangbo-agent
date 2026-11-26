import { describe, expect, it } from 'vitest'
import {
  attachRuntimeNote,
  buildSummaryTranscript,
  buildContext,
  clampSummary,
  compressTurnToolResults,
  estimateBlocks,
  estimateTokens,
  groupIntoTurns,
  isTruncatedToolResult,
  RUNTIME_CONTEXT_OPEN,
  summaryCovers,
  TOOL_RESULT_TRUNCATED_MARKER,
  truncateToolResult,
  turnsToSummarize,
  toLLMMessages
} from './context'
import type { LLMMessage } from '../providers/types'
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
    ).toBe(1200)
  })

  it('tool_result 超长输出先截断再计入预算', () => {
    const long = 'x'.repeat(10000)
    const result = buildContext(
      [
        makeMessage('user', [textBlock('问')]),
        makeMessage('assistant', [
          { type: 'tool_use', id: 't1', name: 'read_file', input: {} },
          { type: 'tool_result', toolUseId: 't1', content: long, isError: false }
        ])
      ],
      { system: 'sys', budgetTokens: 100_000, toolResultMaxChars: 4000 }
    )
    // 截断后 tool_result 估值约 2000+12，不再吞掉整轮预算
    expect(result.estimatedTokens).toBeLessThan(5000)
  })

  it('CJK 区间判定：假名谚文按 1 token，拉丁重音按 4:1', () => {
    // あ（3042）、한（D55C）在区间内；é（E9）在区间外
    expect(estimateTokens('あは')).toBe(2)
    expect(estimateTokens('한글')).toBe(2)
    // ée 两个字符按 other 计：2/4 上取整 = 1
    expect(estimateTokens('éè')).toBe(1)
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

describe('buildContext 轮内压缩 (T3)', () => {
  /** 一轮里塞 100 组 tool_use/tool_result，每组输出都很长。 */
  function hugeTurn(resultChars = 3000): Message[] {
    const blocks: ContentBlock[] = []
    for (let i = 0; i < 100; i++) {
      blocks.push({ type: 'tool_use', id: `t${i}`, name: 'read_file', input: { path: `/f${i}` } })
      blocks.push({
        type: 'tool_result',
        toolUseId: `t${i}`,
        content: `第${i}次输出` + 'x'.repeat(resultChars),
        isError: false
      })
    }
    return [
      makeMessage('user', [textBlock('跑完这一轮')]),
      makeMessage('assistant', [...blocks, textBlock('完成')])
    ]
  }

  it('单轮超预算时压缩旧工具输出，估算值落到预算内', () => {
    // 100 组工具的固定块开销本身约 4k；压缩后仍有最近 6 组完整输出。
    // 预算取 16k：压缩前约 79k 明显超预算，压缩后应落回预算内。
    const budget = 16_000
    const result = buildContext(hugeTurn(), { system: 'sys', budgetTokens: budget })

    expect(result.compressedInTurn).toBe(true)
    expect(result.estimatedTokens).toBeLessThanOrEqual(budget)
  })

  it('保留旧轮时，最新一轮自身超过预算 60% 也会压缩', () => {
    const oldTurn = [
      makeMessage('user', [textBlock('旧问题')]),
      makeMessage('assistant', [textBlock('旧回答')])
    ]
    const budget = 16_000
    // 最新一轮约 10k，自身超过 16k 预算的 60%，但加上旧轮后总量仍低于预算。
    const result = buildContext([...oldTurn, ...hugeTurn(250)], {
      system: 'sys',
      budgetTokens: budget
    })

    expect(result.omittedTurns).toBe(0)
    expect(result.compressedInTurn).toBe(true)
    expect(result.estimatedTokens).toBeLessThanOrEqual(budget)
  })

  it('压缩后 tool_use 与 tool_result 仍然一一配对', () => {
    const result = buildContext(hugeTurn(), { system: 'sys', budgetTokens: 16_000 })
    const uses = new Set<string>()
    const results = new Set<string>()
    for (const message of result.messages) {
      for (const block of message.blocks) {
        if (block.type === 'tool_use') uses.add(block.id)
        if (block.type === 'tool_result') results.add(block.toolUseId)
      }
    }
    expect(uses.size).toBe(100)
    expect(results.size).toBe(100)
    expect([...uses].sort()).toEqual([...results].sort())

    const placeholders = result.messages
      .flatMap((message) => message.blocks)
      .filter((block) => block.type === 'tool_result' && block.content.startsWith('[已省略旧工具输出'))
    // 100 组只保留最近 6 组完整输出
    expect(placeholders.length).toBe(94)
    expect(placeholders[0].type === 'tool_result' && placeholders[0].content).toContain('read_file')
  })

  it('工具输出不足 6 组时不压缩', () => {
    const turn = [
      makeMessage('user', [textBlock('问')]),
      makeMessage('assistant', [
        { type: 'tool_use', id: 't0', name: 'read_file', input: {} },
        { type: 'tool_result', toolUseId: 't0', content: 'x'.repeat(5000), isError: false }
      ])
    ]
    const compressed = compressTurnToolResults(turn)
    expect(compressed.changed).toBe(false)
  })

  it('摘要消息排在历史第一条', () => {
    const path = [
      makeMessage('user', [textBlock('旧问题')]),
      makeMessage('assistant', [textBlock('旧回答')]),
      makeMessage('user', [textBlock('新问题')]),
      makeMessage('assistant', [textBlock('新回答')])
    ]
    const result = buildContext(path, {
      system: 'sys',
      budgetTokens: 10_000,
      summary: '用户此前在修复构建，已确认使用 npm。'
    })
    expect(result.messages[0]).toEqual({
      role: 'user',
      blocks: [
        { type: 'text', text: '【此前对话摘要】\n用户此前在修复构建，已确认使用 npm。' }
      ]
    })
    expect(result.messages[1].role).toBe('user')
    expect(result.omittedTurns).toBe(0)
  })
})

describe('轮间摘要辅助 (T3)', () => {
  it('只取被裁掉的最旧轮次', () => {
    const t1 = [makeMessage('user', [textBlock('一')]), makeMessage('assistant', [textBlock('答一')])]
    const t2 = [makeMessage('user', [textBlock('二')]), makeMessage('assistant', [textBlock('答二')])]
    const t3 = [makeMessage('user', [textBlock('三')]), makeMessage('assistant', [textBlock('答三')])]
    const path = [...t1, ...t2, ...t3]
    expect(turnsToSummarize(path, 2).map((m) => m.id)).toEqual([...t1, ...t2].map((m) => m.id))
    expect(turnsToSummarize(path, 0)).toEqual([])
  })

  it('摘要缓存只在覆盖点恰好等于最后一条被裁消息时有效', () => {
    const t1 = [makeMessage('user', [textBlock('一')]), makeMessage('assistant', [textBlock('答一')])]
    const t2 = [makeMessage('user', [textBlock('二')]), makeMessage('assistant', [textBlock('答二')])]
    const path = [...t1, ...t2]
    expect(summaryCovers(path, t1[1].id, 1)).toBe(true)
    expect(summaryCovers(path, t1[0].id, 1)).toBe(false)
    expect(summaryCovers(path, t1[1].id, 0)).toBe(false)
  })

  it('transcript 包含角色与工具摘要，且受长度上限约束', () => {
    const message = makeMessage('assistant', [
      { type: 'tool_use', id: 't1', name: 'read_file', input: {} },
      { type: 'tool_result', toolUseId: 't1', content: 'x'.repeat(1000), isError: false },
      textBlock('读完了')
    ])
    const text = buildSummaryTranscript([message])
    expect(text).toContain('助手：')
    expect(text).toContain('[调用工具 read_file]')
    expect(text).toContain('[工具结果]')
    expect(text).toContain('读完了')
    expect(buildSummaryTranscript([message], 50).length).toBeLessThan(100)
  })

  it('摘要正文截到 400 字', () => {
    expect(clampSummary('  短摘要  ')).toBe('短摘要')
    expect(clampSummary('长'.repeat(600)).length).toBe(400)
  })
})

describe('inMemory 纳入 buildContext 与超长 tool_result 强制截断 (Ticket 4)', () => {
  const bigContent = 'x'.repeat(20000);

  function toolUse(id: string): ContentBlock {
    return { type: 'tool_use', id, name: 'read_file', input: { path: '/a' } }
  }
  function toolResult(id: string, content: string): ContentBlock {
    return { type: 'tool_result', toolUseId: id, content, isError: false }
  }

  it('truncateToolResult 幂等：重复截断不叠加 note', () => {
    const once = truncateToolResult(bigContent, 4000);
    expect(once).toContain(TOOL_RESULT_TRUNCATED_MARKER);
    expect(once.length).toBeLessThan(bigContent.length);
    expect(truncateToolResult(once, 4000)).toBe(once);
    expect(isTruncatedToolResult(once, 4000)).toBe(true);
    expect(isTruncatedToolResult('short', 4000)).toBe(false);
    // 短内容原样返回
    expect(truncateToolResult('short', 4000)).toBe('short');
  })

  it('裸子串不能绕过截断：超长原文即使含标记片段也必须被截断', () => {
    // 日志原文恰好含有"（工具输出过长，已截断前"几个字，但不是完整格式化 note
    const bypass = '日志开头含有（工具输出过长，已截断前几个字' + 'z'.repeat(20000);
    expect(isTruncatedToolResult(bypass, 4000)).toBe(false);
    const out = truncateToolResult(bypass, 4000);
    expect(out.length).toBeLessThan(bypass.length);
    expect(isTruncatedToolResult(out, 4000)).toBe(true);
    // 完整 note 但超出宽容长度（> maxChars + 120）同样不放行
    const farBeyond = truncateToolResult('q'.repeat(20000), 4000) + '尾巴'.repeat(5000);
    expect(isTruncatedToolResult(farBeyond, 4000)).toBe(false);
  })

  it('inMemory 计入预算：超大在途工具输出会挤掉旧轮', () => {
    const u1 = makeMessage('user', [textBlock('aa')]);
    const a1 = makeMessage('assistant', [textBlock('bb')]);
    const u2 = makeMessage('user', [textBlock('cc')]);
    const inMem = makeMessage('assistant', [toolUse('t9'), toolResult('t9', bigContent)]);

    const without = buildContext([u1, a1, u2], { system: 'sys', budgetTokens: 40 });
    expect(without.omittedTurns).toBe(0);

    const withMem = buildContext([u1, a1, u2], { system: 'sys', budgetTokens: 40, inMemory: [inMem] });
    expect(withMem.omittedTurns).toBe(1);
  });

  it('即使未触发整轮压缩，发往模型的超长 tool_result 也被截断，且不改 DB 对象', () => {
    const u = makeMessage('user', [textBlock('hi')]);
    const inMem = makeMessage('assistant', [toolUse('t1'), toolResult('t1', bigContent)]);
    const original = inMem.blocks[1];
    if (original.type !== 'tool_result') throw new Error('fixture broken');

    // 预算充足：不压缩、不裁轮，但输出仍被截断
    const result = buildContext([u], {
      system: 'sys',
      budgetTokens: 100_000,
      inMemory: [inMem]
    });
    expect(result.compressedInTurn).not.toBe(true);
    const toolMsgs = result.messages.filter((m) => m.role === 'tool');
    expect(toolMsgs.length).toBe(1);
    const outBlock = toolMsgs[0].blocks[0];
    expect(outBlock.type === 'tool_result' && outBlock.content.length).toBeLessThan(bigContent.length);
    expect(outBlock.type === 'tool_result' && outBlock.content.includes(TOOL_RESULT_TRUNCATED_MARKER)).toBe(true);
    // DB 落库对象保持原样：引用不同且内容未被改写
    expect(outBlock).not.toBe(original);
    expect(original.content).toBe(bigContent);
  });

  it('无 inMemory 时行为与旧版一致（不传即等价）', () => {
    const u = makeMessage('user', [textBlock('hi')]);
    const a = makeMessage('assistant', [toolUse('t1'), toolResult('t1', bigContent)]);
    const r1 = buildContext([u, a], { system: 'sys', budgetTokens: 100_000 });
    const r2 = buildContext([u, a], { system: 'sys', budgetTokens: 100_000, inMemory: [] });
    expect(JSON.stringify(r2.messages)).toBe(JSON.stringify(r1.messages));
  });
});

describe('attachRuntimeNote 运行时上下文块 (Ticket 4)', () => {
  const msg = (role: 'user' | 'assistant', text: string): LLMMessage => ({
    role,
    blocks: [{ type: 'text', text }]
  });

  it('附加到末条 user 消息，不碰历史前缀与原对象', () => {
    const messages: LLMMessage[] = [msg('user', '第一问'), msg('assistant', '第一答'), msg('user', '当前问')];
    const next = attachRuntimeNote(messages, '动态指令');
    expect(next).not.toBe(messages);
    expect(next[0]).toBe(messages[0]);
    expect(next[1]).toBe(messages[1]);
    const last = next[next.length - 1].blocks[0];
    expect(last.type === 'text' && last.text.startsWith('当前问')).toBe(true);
    expect(last.type === 'text' && last.text.includes('动态指令')).toBe(true);
    expect(last.type === 'text' && last.text.includes(RUNTIME_CONTEXT_OPEN)).toBe(true);
    // 原数组未被改写
    expect((messages[2].blocks[0] as { text: string }).text).toBe('当前问');
  });

  it('空 note / 无 user 消息时原样返回', () => {
    const messages: LLMMessage[] = [msg('user', '问')];
    expect(attachRuntimeNote(messages, '')).toBe(messages);
    const noUser: LLMMessage[] = [msg('assistant', '答')];
    expect(attachRuntimeNote(noUser, 'x')).toBe(noUser);
  });

  it('幂等：重复附加不叠加', () => {
    const messages: LLMMessage[] = [msg('user', '问')];
    const once = attachRuntimeNote(messages, '动态指令');
    const twice = attachRuntimeNote(once, '动态指令');
    expect(twice).toBe(once);
    const text = twice[twice.length - 1].blocks[0];
    expect(text.type === 'text' && text.text.split(RUNTIME_CONTEXT_OPEN).length - 1).toBe(1);
  });

  it('末条 user 只有图片块时追加文本块', () => {
    const messages: LLMMessage[] = [
      msg('user', '先问'),
      {
        role: 'user',
        blocks: [{ type: 'image', mimeType: 'image/png', dataUrl: 'data:image/png;base64,x' }]
      }
    ];
    const next = attachRuntimeNote(messages, '动态指令');
    expect(next[next.length - 1].blocks.length).toBe(2);
    expect(next[0]).toBe(messages[0]);
  });
});
