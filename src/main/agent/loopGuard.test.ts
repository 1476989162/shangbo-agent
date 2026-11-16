import { describe, expect, it, vi } from 'vitest'
import { callSignature, detectStuck, detectStuckRules } from './loopGuard'

vi.mock('./cCoreBridge', () => ({
  cCoreBridge: { detectStuck: vi.fn() }
}))

describe('防死循环保险丝：C 主通道与 TS 兜底', () => {
  it('正常干活不触发', async () => {
    const { cCoreBridge } = await import('./cCoreBridge')
    vi.mocked(cCoreBridge.detectStuck).mockResolvedValue(null)
    await expect(detectStuck([
      { sig: 'read_file:a', isError: false },
      { sig: 'read_file:b', isError: false },
      { sig: 'search_files:c', isError: false }
    ])).resolves.toBeNull()
    expect(cCoreBridge.detectStuck).toHaveBeenCalledTimes(1)
  })

  it('连续失败与重复调用通过 C 返回停机原因', async () => {
    const { cCoreBridge } = await import('./cCoreBridge')
    vi.mocked(cCoreBridge.detectStuck)
      .mockResolvedValueOnce('C：连续失败 3 次')
      .mockResolvedValueOnce('C：重复 3 次')
    await expect(detectStuck([
      { sig: 'patch_file:x', isError: true },
      { sig: 'patch_file:x', isError: true },
      { sig: 'patch_file:x', isError: true }
    ])).resolves.toContain('连续失败 3 次')
    const sig = callSignature('run_command', { command: 'npm test' })
    await expect(detectStuck([
      { sig, isError: false }, { sig, isError: false }, { sig, isError: false }
    ])).resolves.toContain('重复 3 次')
  })

  it('TS 兜底保留原有规则', () => {
    expect(detectStuckRules([{ sig: 'a', isError: true }])).toBeNull()
    expect(detectStuckRules([
      { sig: 'a', isError: true }, { sig: 'b', isError: true }, { sig: 'c', isError: true }
    ])).toContain('连续失败 3 次')
    expect(detectStuckRules([
      { sig: 'same', isError: false }, { sig: 'same', isError: false }, { sig: 'same', isError: false }
    ])).toContain('重复 3 次')
  })
})
