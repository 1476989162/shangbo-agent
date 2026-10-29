import { describe, expect, it } from 'vitest'
import { buildWorkModeDirective } from './workMode'

const base = {
  workMode: 'code' as 'cowork' | 'code' | null,
  workingDirectory: 'G:\\proj',
  readOnly: false,
  conversationMode: 'builder' as const
}

describe('视图模式提示词', () => {
  it('没有记录视图模式时不注入任何指令', () => {
    expect(buildWorkModeDirective({ ...base, workMode: null })).toBe('')
  })

  it('协同视图强调边做边讲，且明确不许用建议代替执行', () => {
    const text = buildWorkModeDirective({ ...base, workMode: 'cowork' })
    expect(text).toContain('协同视图')
    expect(text).toContain('边做边讲')
    expect(text).toContain('不要用建议代替执行')
  })

  it('代码视图强调落盘与证据，不出现协同视图的措辞', () => {
    const text = buildWorkModeDirective(base)
    expect(text).toContain('代码视图')
    expect(text).toContain('patch_file')
    expect(text).toContain('文件:行号')
    expect(text).not.toContain('协同视图')
  })

  it('只读复查时代码视图不给“动手改文件”的指令', () => {
    const text = buildWorkModeDirective({ ...base, readOnly: true })
    expect(text).toContain('只读复查')
    expect(text).not.toContain('直接动手改文件')
  })

  it('chat 模式不被视图指令反向放开：协同与代码视图都不许动手', () => {
    const cowork = buildWorkModeDirective({ ...base, workMode: 'cowork', conversationMode: 'chat' })
    expect(cowork).not.toContain('不要用建议代替执行')
    const code = buildWorkModeDirective({ ...base, conversationMode: 'chat' })
    expect(code).toContain('纯讨论模式')
    expect(code).not.toContain('直接动手改文件')
  })

  it('未绑定工程目录时提示先确认目录，只读或纯讨论时不提', () => {
    const noDir = buildWorkModeDirective({ ...base, workingDirectory: null })
    expect(noDir).toContain('未绑定工程目录')
    expect(buildWorkModeDirective({ ...base, workingDirectory: null, readOnly: true })).not.toContain(
      '未绑定工程目录'
    )
    expect(
      buildWorkModeDirective({ ...base, workingDirectory: null, conversationMode: 'chat' })
    ).not.toContain('未绑定工程目录')
  })
})
