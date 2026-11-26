import { describe, expect, it, vi } from 'vitest'
import {
  handleViewerLinkClick,
  highlighterReady,
  preloadHighlighter,
  resolveViewerRelPath
} from './markdown'

describe('resolveViewerRelPath Windows 绝对路径换算', () => {
  const root = 'G:\\projects\\demo'

  it('工程内绝对路径换算为相对路径（斜杠归一化）', () => {
    expect(resolveViewerRelPath('G:\\projects\\demo\\src\\a.ts', root)).toBe('src/a.ts')
    expect(resolveViewerRelPath('G:/projects/demo/src/a.ts', root)).toBe('src/a.ts')
  })

  it('盘符/大小写不一致时仍能匹配', () => {
    expect(resolveViewerRelPath('g:\\PROJECTS\\demo\\src\\a.ts', root)).toBe('src/a.ts')
  })

  it('工程外绝对路径拒绝换算（禁止硬截取盘符）', () => {
    expect(resolveViewerRelPath('G:\\other\\evil.ts', root)).toBeNull()
    expect(resolveViewerRelPath('D:\\projects\\demo\\src\\a.ts', root)).toBeNull()
  })

  it('未绑定 workingDir 时绝对路径拒绝换算', () => {
    expect(resolveViewerRelPath('G:\\projects\\demo\\src\\a.ts', null)).toBeNull()
    expect(resolveViewerRelPath('G:\\projects\\demo\\src\\a.ts', undefined)).toBeNull()
  })

  it('裸相对路径原样通过（边界由主进程二次校验）', () => {
    expect(resolveViewerRelPath('src/a.ts', root)).toBe('src/a.ts')
    expect(resolveViewerRelPath('.\\src\\a.ts', root)).toBe('src/a.ts')
  })

  it('空路径返回 null', () => {
    expect(resolveViewerRelPath('', root)).toBeNull()
  })
})

function fakeClick(href: string, kind: 'web' | 'file'): MouseEvent {
  const anchor = {
    getAttribute: (name: string): string | null => {
      if (name === 'data-viewer') return kind
      if (name === 'href') return href
      return null
    }
  }
  const target = { closest: (): unknown => anchor }
  return { target } as unknown as MouseEvent
}

describe('handleViewerLinkClick 点击委托', () => {
  const open = { openWeb: vi.fn(), openFile: vi.fn() }

  it('工程内绝对路径按 workingDir 换算后打开', () => {
    open.openFile.mockClear()
    const handled = handleViewerLinkClick(
      fakeClick('G:\\projects\\demo\\src\\a.ts', 'file'),
      open,
      'conv-1',
      'G:\\projects\\demo'
    )
    expect(handled).toBe(true)
    expect(open.openFile).toHaveBeenCalledWith('conv-1', 'src/a.ts')
  })

  it('工程外绝对路径不接管、不打开', () => {
    open.openFile.mockClear()
    const handled = handleViewerLinkClick(
      fakeClick('G:\\other\\evil.ts', 'file'),
      open,
      'conv-1',
      'G:\\projects\\demo'
    )
    expect(handled).toBe(false)
    expect(open.openFile).not.toHaveBeenCalled()
  })

  it('未绑定目录时不接管文件链接', () => {
    const handled = handleViewerLinkClick(fakeClick('G:\\x\\a.ts', 'file'), open, 'conv-1', null)
    expect(handled).toBe(false)
  })

  it('无会话时不接管', () => {
    const handled = handleViewerLinkClick(
      fakeClick('src/a.ts', 'file'),
      open,
      null,
      'G:\\projects\\demo'
    )
    expect(handled).toBe(false)
  })
})

describe('preloadHighlighter 按需 bundle', () => {
  it('shiki/core + 25 语言可初始化并高亮 TS', async () => {
    const highlighter = await preloadHighlighter()
    expect(highlighter).not.toBeNull()
    expect(highlighterReady.value).toBe(true)
    const html = highlighter!.codeToHtml('const x: number = 1', {
      lang: 'typescript',
      theme: 'github-light'
    })
    expect(html).toContain('shiki')
    expect(html).toContain('const')
  }, 60_000)
})
