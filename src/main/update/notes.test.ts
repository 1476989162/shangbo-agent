import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { normalizeReleaseNotes, toPlainText } from './index'

const escapedFeedHtml = readFileSync('src/main/update/fixtures/github-atom-content.txt', 'utf8')

describe('release notes 纯文本化', () => {
  it('GitHub Atom feed 里被转义的 HTML 也能转成可读纯文本', () => {
    const out = toPlainText(escapedFeedHtml)!
    expect(out).not.toMatch(/<\/?[a-z][^>]*>/i)
    expect(out).not.toMatch(/&(lt|gt|amp|quot|#39);/i)
    expect(out).toContain('更新日志')
    expect(out).toContain('[0.5.3] - 2026-10-27')
    expect(out).toContain('- 正文结巴式重复')
    expect(out).toContain('chat:send')
  })

  it('未转义的 HTML 同样处理', () => {
    const out = toPlainText('<h2>[0.5.3]</h2><p>A &amp; B &lt;x&gt;</p><ul><li>one</li></ul>')!
    expect(out).not.toMatch(/<\/?(h[1-6]|p|ul|ol|li|div|span|a|strong|em|code|pre)\b[^>]*>/i)
    expect(out).toContain('[0.5.3]')
    expect(out).toContain('A & B <x>')
    expect(out).toContain('- one')
  })

  it('纯文本与数组形态都能处理', () => {
    expect(normalizeReleaseNotes({ releaseNotes: '  <b>hi</b>  ' } as any)).toBe('hi')
    expect(
      normalizeReleaseNotes({ releaseNotes: [{ version: '1.0.0', note: '&lt;p&gt;one&lt;/p&gt;' }] } as any)
    ).toBe('one')
    expect(normalizeReleaseNotes({ releaseNotes: [] } as any)).toBeUndefined()
  })
})
