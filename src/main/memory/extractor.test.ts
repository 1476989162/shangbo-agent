import { describe, expect, it } from 'vitest'
import { extractWikiCandidates } from './extractor'

describe('后台 Wiki 候选提取（本地规则 Fast Path）', () => {
  it('从中文对话里提取联系人 / 客户 / 项目 / 决策四类结构化候选', () => {
    const text = '我叫李明，客户是 Acme，项目叫 Apollo。我们决定下周三上线，请以后回复都用中文。'
    const candidates = extractWikiCandidates(text)
    const kinds = candidates.map((c) => c.kind)
    expect(kinds).toContain('contact')
    expect(kinds).toContain('client')
    expect(kinds).toContain('project')
    expect(kinds).toContain('topic')
    expect(candidates.find((c) => c.kind === 'contact')?.title).toBe('李明')
    expect(candidates.find((c) => c.kind === 'client')?.title).toBe('Acme')
    expect(candidates.every((c) => c.body.length <= 300)).toBe(true)
    expect(candidates.every((c) => c.reason)).toBe(true)
  })

  it('英文措辞同样命中，且不产生噪声记忆', () => {
    const en = extractWikiCandidates('My name is Alex and we decided to ship on Friday.')
    expect(en.some((c) => c.kind === 'contact')).toBe(true)
    expect(en.some((c) => c.section === '决策')).toBe(true)
    expect(extractWikiCandidates('今天天气不错，随便聊聊')).toEqual([])
    expect(extractWikiCandidates('')).toEqual([])
  })

  it('候选数量有上限，避免长文本刷屏', () => {
    const long = Array.from({ length: 40 }, (_, i) => `我叫用户${i}，客户是客户${i}`).join('。')
    expect(extractWikiCandidates(long).length).toBeLessThanOrEqual(8)
  })
})
