import { describe, expect, it } from 'vitest'
import {
  formatTokensK,
  IMAGE_MIME_RE,
  resolveModelContextLimit
} from './composerPresentation'

describe('输入区展示逻辑', () => {
  it('按模型名推断上下文上限', () => {
    expect(resolveModelContextLimit('SenseNova-1M')).toBe(1_000_000)
    expect(resolveModelContextLimit('claude-sonnet-4')).toBe(200_000)
    expect(resolveModelContextLimit('gpt-4o')).toBe(128_000)
    expect(resolveModelContextLimit('unknown')).toBe(128_000)
  })

  it('格式化上下文用量', () => {
    expect(formatTokensK(999)).toBe('999')
    expect(formatTokensK(1_500)).toBe('1.5k')
    expect(formatTokensK(1_000_000)).toBe('1M')
  })

  it('只接受与主进程一致的图片 MIME', () => {
    expect(IMAGE_MIME_RE.test('image/png')).toBe(true)
    expect(IMAGE_MIME_RE.test('image/jpeg')).toBe(true)
    expect(IMAGE_MIME_RE.test('image/svg+xml')).toBe(false)
  })
})
