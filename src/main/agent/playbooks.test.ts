import { describe, expect, it } from 'vitest'
import { matchReviewIntent, REVIEW_PLAYBOOK } from './playbooks'

describe('复查意图识别 (matchReviewIntent)', () => {
  it('命中中英文复查表达', () => {
    expect(matchReviewIntent('帮我 review 一下 lnbxwebapi/Services')).toBe(true)
    expect(matchReviewIntent('复查一下登录模块')).toBe(true)
    expect(matchReviewIntent('全仓巡检，输出问题清单')).toBe(true)
    expect(matchReviewIntent('audit the auth middleware')).toBe(true)
  })

  it('日常任务不误伤', () => {
    expect(matchReviewIntent('写一个登录函数')).toBe(false)
    expect(matchReviewIntent('今天天气怎么样')).toBe(false)
    expect(matchReviewIntent('')).toBe(false)
  })

  it('方法论包含停止条件与分级要求', () => {
    expect(REVIEW_PLAYBOOK).toContain('见好就收')
    expect(REVIEW_PLAYBOOK).toContain('分级')
    expect(REVIEW_PLAYBOOK).toContain('只查不修')
  })
})
