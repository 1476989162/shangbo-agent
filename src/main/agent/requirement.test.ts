import { describe, expect, it } from 'vitest'
import { buildRequirementBrief, shouldPreorganize } from './requirement'

describe('需求预整理', () => {
  it('寒暄与极短问答跳过', () => {
    expect(buildRequirementBrief('你好', 'chat')).toBe('')
    expect(shouldPreorganize('今天几号', 'chat')).toBe(false)
  })

  it('建造任务输出目标/验收/执行顺序', () => {
    const brief = buildRequirementBrief('帮我把登录页的报错修一下，跑通测试', 'builder', {
      workingDirectory: 'G:\\repo',
    })
    expect(brief).toContain('【需求预整理】')
    expect(brief).toContain('目标：')
    expect(brief).toContain('验收标准：')
    expect(brief).toContain('建议执行顺序')
    expect(brief).toContain('G:\\repo')
  })

  it('风险信号显式标出', () => {
    const brief = buildRequirementBrief('把这个表清掉重导数据', 'builder')
    expect(brief).toContain('风险信号')
  })

  it('未指明范围时给出默认解释', () => {
    const brief = buildRequirementBrief('实现导出功能', 'builder')
    expect(brief).toContain('缺口与默认解释')
  })
})
