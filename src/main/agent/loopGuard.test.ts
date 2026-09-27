import { describe, expect, it } from 'vitest'
import { callSignature, detectStuck } from './loopGuard'

describe('防死循环保险丝 (detectStuck)', () => {
  it('正常干活不触发', () => {
    expect(
      detectStuck([
        { sig: 'read_file:a', isError: false },
        { sig: 'read_file:b', isError: false },
        { sig: 'search_files:c', isError: false }
      ])
    ).toBeNull()
  })

  it('连续 3 次失败触发', () => {
    const reason = detectStuck([
      { sig: 'read_file:a', isError: false },
      { sig: 'patch_file:x', isError: true },
      { sig: 'patch_file:x', isError: true },
      { sig: 'patch_file:x', isError: true }
    ])
    expect(reason).toContain('连续失败 3 次')
  })

  it('同一调用重复 3 次触发（即使没报错）', () => {
    const sig = callSignature('run_command', { command: 'npm test' })
    const reason = detectStuck([
      { sig, isError: false },
      { sig, isError: false },
      { sig, isError: false }
    ])
    expect(reason).toContain('重复 3 次')
  })

  it('记录不足或穿插成功不触发', () => {
    expect(detectStuck([{ sig: 'a', isError: true }])).toBeNull()
    expect(
      detectStuck([
        { sig: 'patch_file:x', isError: true },
        { sig: 'read_file:a', isError: false },
        { sig: 'patch_file:x', isError: true }
      ])
    ).toBeNull()
  })
})
