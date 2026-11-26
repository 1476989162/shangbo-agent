import { describe, expect, it } from 'vitest'
import { fastClassifyAction, parseActionLlmOutput } from './actionClassifier'
import type { SafetyVerdict } from './safety'

function verdict(tier: SafetyVerdict['tier']): SafetyVerdict {
  return { tier, category: 'workspace', reason: 'test', autoApprovable: tier !== 'hard' && tier !== 'blocked' }
}

describe('fastClassifyAction 规则通道', () => {
  it('blocked 直接拦，hard 落回确认', () => {
    expect(fastClassifyAction({ tier: 'blocked', category: 'disk', reason: 'x', autoApprovable: false })?.decision).toBe('block')
    expect(fastClassifyAction(verdict('hard'))?.decision).toBe('ask')
  })

  it('普通命令直接放行；soft 返回 null 让出给可选 LLM 复核（开关关闭时走常规链，不强制弹窗）', () => {
    expect(fastClassifyAction(verdict('auto'), 'rmdir /s /q build')?.decision).toBe('allow')
    expect(fastClassifyAction(verdict('soft'), 'rmdir /s /q ../outside')).toBeNull()
    expect(fastClassifyAction(verdict('soft'), 'python -X utf8 tools\\\\probe8se.py')).toBeNull()
  })
})

describe('parseActionLlmOutput 只认 JSON', () => {
  it('合法 JSON 按结论返回', () => {
    expect(parseActionLlmOutput('{"decision":"block","reason":"外发密钥"}').decision).toBe('block')
  })

  it('非法输出不再把普通操作升级为人工确认', () => {
    expect(parseActionLlmOutput('你好').decision).toBe('allow')
    expect(parseActionLlmOutput('{"decision":"allow-all"}').decision).toBe('allow')
  })
})
