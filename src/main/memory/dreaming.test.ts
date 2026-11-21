import { describe, expect, it } from 'vitest'
import {
  accumulateClues,
  applyTimeWindow,
  classifyFeedback,
  decideProactive,
  decideProactiveDetailed,
  extractDirectRule,
  learnFromFeedback
} from './dreaming'

describe('Dreaming：主动提醒决策', () => {
  it('quiet hours 只记录不打扰', () => {
    const d = decideProactive(
      { itemKey: 'k1', kind: 'delivery', hour: 23 },
      { remindersToday: 0, judgedToday: [], rules: {} }
    )
    expect(d.action).toBe('follow-up')
  })

  it('同一事项一天只判一次', () => {
    const d = decideProactive(
      { itemKey: 'k1', kind: 'delivery', hour: 10 },
      { remindersToday: 0, judgedToday: ['k1'], rules: {} }
    )
    expect(d.action).toBe('stay-silent')
  })

  it('已学规则优先', () => {
    const d = decideProactive(
      { itemKey: 'k2', kind: 'client-reply', hour: 10 },
      { remindersToday: 0, judgedToday: [], rules: { 'client-reply': 'tell-now' } }
    )
    expect(d.action).toBe('tell-now')
  })

  it('超 5 条转跟进', () => {
    const d = decideProactive(
      { itemKey: 'k3', kind: 'meeting-change', hour: 10 },
      { remindersToday: 5, judgedToday: [], rules: {} }
    )
    expect(d.action).toBe('follow-up')
  })
})

describe('Dreaming：反馈分类与两次成规则', () => {
  it('早点告诉我 → tell-now', () => {
    expect(classifyFeedback('早点告诉我啊，这个很急').action).toBe('tell-now')
  })

  it('没必要 → stay-silent', () => {
    expect(classifyFeedback('这个没必要推给我').action).toBe('stay-silent')
  })

  it('同类线索见 2 次晋升为规则', () => {
    const s1 = accumulateClues([], 'vendor-invoice', 'tell-now')
    expect(s1.promoted).toBeNull()
    const s2 = accumulateClues(s1.clues, 'vendor-invoice', 'tell-now')
    expect(s2.promoted).toEqual({ kind: 'vendor-invoice', action: 'tell-now' })
    expect(s2.clues.length).toBe(0)
  })
})

describe('Dreaming：直接指令一步成规 + 时段规则（Stage 2）', () => {
  it('中文「以后这类…立刻告诉我」一次成规，无需等第二条线索', () => {
    const text = '以后这类消息都立刻告诉我'
    expect(classifyFeedback(text)).toMatchObject({ action: 'tell-now', direct: true })
    expect(extractDirectRule(text, 'vendor-invoice', 10)).toEqual({
      kind: 'vendor-invoice',
      action: 'tell-now'
    })
    const learned = learnFromFeedback([], text, 'vendor-invoice', 10)
    expect(learned.direct).toBe(true)
    expect(learned.rule).toEqual({ kind: 'vendor-invoice', action: 'tell-now' })
  })

  it('英文 from now on / whenever ... tell me right away 同样一步成规', () => {
    const rule = extractDirectRule(
      "From now on, whenever there's an invoice, tell me right away",
      'vendor-invoice',
      10
    )
    expect(rule).toEqual({ kind: 'vendor-invoice', action: 'tell-now' })
  })

  it('「以后别再提醒我」成静默规则；深夜 21 点后降级为 follow-up 绝不直达 silent', () => {
    expect(extractDirectRule('以后别再提醒我这类', 'delivery', 10)).toEqual({
      kind: 'delivery',
      action: 'stay-silent'
    })
    expect(applyTimeWindow('stay-silent', 23)).toBe('follow-up')
    expect(applyTimeWindow('stay-silent', 10)).toBe('stay-silent')
    expect(classifyFeedback('以后晚上别推给我').action).toBe('follow-up')
    expect(extractDirectRule('以后晚上别推给我', 'delivery', 23)).toBeNull()
  })

  it('普通吐槽仍走 Clue × 2；点赞不学', () => {
    const first = learnFromFeedback([], '早点告诉我', 'delivery', 10)
    expect(first.direct).toBe(false)
    expect(first.rule).toBeNull()
    expect(first.clues[0].seen).toBe(1)
    const second = learnFromFeedback(first.clues, '早点告诉我', 'delivery', 10)
    expect(second.rule).toEqual({ kind: 'delivery', action: 'tell-now' })
    expect(learnFromFeedback([], '收到，谢谢', 'delivery', 10).rule).toBeNull()
  })

  it('决策带结构化 bucket，调用方无需匹配自然语言 reason', () => {
    const ctx = { remindersToday: 0, judgedToday: [], rules: {} }
    expect(decideProactiveDetailed({ itemKey: 'k', kind: 'delivery', hour: 23 }, ctx).bucket).toBe('quiet-hours')
    expect(
      decideProactiveDetailed({ itemKey: 'k', kind: 'delivery', hour: 10 }, { ...ctx, remindersToday: 6 }).bucket
    ).toBe('daily-cap')
    expect(
      decideProactiveDetailed({ itemKey: 'k', kind: 'delivery', hour: 10 }, { ...ctx, judgedToday: ['k'] }).bucket
    ).toBe('already-judged')
    expect(
      decideProactiveDetailed(
        { itemKey: 'k', kind: 'delivery', hour: 10 },
        { ...ctx, rules: { delivery: 'tell-now' } }
      ).bucket
    ).toBe('rule')
  })
})
