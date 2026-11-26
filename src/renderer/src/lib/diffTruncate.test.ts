import { describe, expect, it } from 'vitest'
import { GIT_DIFF_MAX_CHARS, GIT_DIFF_MAX_LINES, truncateGitDiff } from './diffTruncate'

describe('truncateGitDiff 超大 diff 保护', () => {
  it('空 diff 返回空结果', () => {
    expect(truncateGitDiff('')).toEqual({ lines: [], totalLines: 0, truncated: false })
  })

  it('小 diff 原样通过', () => {
    const text = ['diff --git a/1 b/1', '+add', '-del'].join('\n')
    const result = truncateGitDiff(text)
    expect(result.truncated).toBe(false)
    expect(result.lines).toHaveLength(3)
    expect(result.totalLines).toBe(3)
  })

  it('超行数截断并标记', () => {
    const text = Array.from({ length: GIT_DIFF_MAX_LINES + 500 }, (_, i) => ` line${i}`).join('\n')
    const result = truncateGitDiff(text)
    expect(result.truncated).toBe(true)
    expect(result.lines).toHaveLength(GIT_DIFF_MAX_LINES)
    expect(result.totalLines).toBe(GIT_DIFF_MAX_LINES + 500)
  })

  it('超字符数截断并标记', () => {
    const bigLine = `+${'x'.repeat(5000)}`
    const count = Math.ceil(GIT_DIFF_MAX_CHARS / 5000) + 10
    const text = Array.from({ length: count }, () => bigLine).join('\n')
    const result = truncateGitDiff(text)
    expect(result.truncated).toBe(true)
    expect(result.lines.length).toBeLessThan(count)
    expect(result.totalLines).toBe(count)
  })
})
