import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { isWishAutoApproved, isWishModeActive, resolveAgentMode } from './wishMode'

const settings = {
  wishEnabled: true,
  autoApproveWorkspace: true,
  defaultMode: 'builder'
}

const tempDirs: string[] = []

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'shangbo-wish-mode-'))
  tempDirs.push(dir)
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('许愿模式状态', () => {
  it('总开关关闭时，wish 会话回落到建造者', () => {
    expect(resolveAgentMode('wish', { ...settings, wishEnabled: false })).toBe('builder')
    expect(isWishModeActive('wish', { ...settings, wishEnabled: false })).toBe(false)
  })

  it('会话未指定模式时使用默认模式', () => {
    expect(resolveAgentMode(null, { ...settings, defaultMode: 'wish' })).toBe('wish')
    expect(isWishModeActive(null, { ...settings, defaultMode: 'wish' })).toBe(true)
  })
})

describe('许愿模式工作区免审批', () => {
  it('工作区内文件与命令可自动放行', () => {
    const dir = workspace()
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1\n')

    expect(isWishAutoApproved('read_file', { path: 'src/a.ts' }, true, true, dir)).toBe(true)
    expect(isWishAutoApproved('write_file', { path: 'src/b.ts' }, true, true, dir)).toBe(true)
    expect(isWishAutoApproved('run_command', { command: 'npm test' }, true, true, dir)).toBe(true)
  })

  it('工作区外文件、cwd 与命令参数不放行', () => {
    const dir = workspace()
    const outside = workspace()
    writeFileSync(join(outside, 'secret.txt'), 'secret')

    expect(
      isWishAutoApproved('read_file', { path: join(outside, 'secret.txt') }, true, true, dir)
    ).toBe(false)
    expect(
      isWishAutoApproved('run_command', { command: 'npm test', cwd: outside }, true, true, dir)
    ).toBe(false)
    expect(
      isWishAutoApproved(
        'run_command',
        { command: `type ${join(outside, 'secret.txt')}` },
        true,
        true,
        dir
      )
    ).toBe(false)
  })

  it('未开启许愿或工作区免审批时一律不放行', () => {
    const dir = workspace()
    expect(isWishAutoApproved('read_file', { path: 'a.ts' }, false, true, dir)).toBe(false)
    expect(isWishAutoApproved('read_file', { path: 'a.ts' }, true, false, dir)).toBe(false)
    expect(isWishAutoApproved('read_file', { path: 'a.ts' }, true, true, null)).toBe(false)
  })
})
