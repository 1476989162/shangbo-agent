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

  it('11-15回放：发布/处理/push/源程序不许判成只聊不做', () => {
    expect(classifyIntent('你发布一下').mode).toBe('builder')
    expect(classifyIntent('麻烦处理一下这个问题').mode).toBe('builder')
    expect(classifyIntent('麻烦重新设计一下').mode).toBe('builder')
    expect(classifyIntent('push 吧').mode).toBe('builder')
    expect(classifyIntent('麻烦你先git+push').mode).toBe('builder')
    expect(classifyIntent('你能修改源程序吗？').mode).toBe('builder')
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

  it('全自动契约收窄：wish 只拦删工作区/批量删/删库表/格式化，发布不再单独拦截', () => {
    const wish = buildTaskContract('把这个版本发布到线上', 'wish', { workingDirectory: 'G:\\repo' })
    expect(wish).toContain('只有以下情况才提问')
    expect(wish).toContain('删除工作目录/大量删除文件')
    expect(wish).toContain('发布/上线/对外发送不再单独拦截')
    const builder = buildTaskContract('把这个版本发布到线上', 'builder', { workingDirectory: 'G:\\repo' })
    expect(builder).toContain('只有三种情况才提问')
    expect(builder).toContain('对外发送/发布')
  })

  it('排障任务命中排障打法，普通问答命中解释打法', () => {
    expect(matchTaskPlaybook('这个报错怎么修', 'builder')).toContain('排障打法')
    expect(matchTaskPlaybook('解释一下事件循环', 'chat')).toContain('解释打法')
  })
})
