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

  it('删除动词永不自动，即使 verdict 是 auto', () => {
    const auto = verdict('auto')
    expect(fastClassifyAction(auto, 'rmdir /s /q build')?.decision).toBe('ask')
    expect(fastClassifyAction(auto, 'npm test')?.decision).toBe('allow')
  })

  it('soft 不可自动时返回 null，让调用方决定是否调 LLM', () => {
    expect(fastClassifyAction(verdict('soft'))).toBeNull()
  })
})

describe('parseActionLlmOutput 只认 JSON', () => {
  it('合法 JSON 按结论返回', () => {
    expect(parseActionLlmOutput('{"decision":"block","reason":"外发密钥"}').decision).toBe('block')
  })

  it('非法输出一律按 ask 处理', () => {
    expect(parseActionLlmOutput('你好').decision).toBe('ask')
    expect(parseActionLlmOutput('{"decision":"allow-all"}').decision).toBe('ask')
  })
})
