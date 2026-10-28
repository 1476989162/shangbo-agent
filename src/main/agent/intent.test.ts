import { describe, expect, it } from 'vitest'
import { buildTaskContract, classifyIntent, matchTaskPlaybook } from './intent'

describe('自然语言意图分类', () => {
  it('交付型说法判为许愿模式', () => {
    expect(classifyIntent('把这个项目做完并自己跑通验收，不用问我').mode).toBe('wish')
    expect(classifyIntent('修复登录报错，直到测试通过').mode).toBe('wish')
    expect(classifyIntent('把重构做完，端到端跑一遍').mode).toBe('wish')
  })

  it('动作 + 工程对象判为建造者', () => {
    expect(classifyIntent('帮我把登录页的报错修一下').mode).toBe('builder')
    expect(classifyIntent('实现一个导出 Excel 的脚本').mode).toBe('builder')
    expect(classifyIntent('检查 src/main/agent/runtime.ts 的审批逻辑').mode).toBe('builder')
  })

  it('纯提问判为问答', () => {
    expect(classifyIntent('Vue3 和 React 的区别是什么？').mode).toBe('chat')
    expect(classifyIntent('这个函数是做什么的').mode).toBe('chat')
    expect(classifyIntent('你好').mode).toBe('chat')
  })

  it('长描述倾向建造者，短句兜底问答', () => {
    expect(
      classifyIntent(
        '现在这个模块在切换会话的时候会偶发卡住，日志里没有明显异常，我想让你看看整体链路并给出一个可靠的改法'
      ).mode
    ).toBe('builder')
    expect(classifyIntent('今天几号').mode).toBe('chat')
  })

  it('任务契约包含目标、完成判定与提问边界', () => {
    const contract = buildTaskContract('实现导出功能并跑通测试', 'builder', {
      workingDirectory: 'G:\\repo'
    })
    expect(contract).toContain('【任务契约】')
    expect(contract).toContain('目标：实现导出功能并跑通测试')
    expect(contract).toContain('完成判定')
    expect(contract).toContain('只有三种情况才提问')
    expect(contract).toContain('G:\\repo')
  })

  it('排障任务命中排障打法，普通问答命中解释打法', () => {
    expect(matchTaskPlaybook('这个报错怎么修', 'builder')).toContain('排障打法')
    expect(matchTaskPlaybook('解释一下事件循环', 'chat')).toContain('解释打法')
  })
})
