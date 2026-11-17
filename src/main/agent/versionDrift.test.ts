import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { auditHardLines } from './safety'
import { cCoreBridge } from './cCoreBridge'

/**
 * 运行包/双栈漂移契约测试（二期现在做）。
 * 根因：11-15 跑的是 0.9.4 旧 asar，源码已 0.9.5；C/TS 各判各的安全分级。
 * 锁三件事：版本号单源一致、TS 硬红线不弱于基线、C 源码含同版本。
 */
function pkgVersion(): string {
  const pkg = JSON.parse(readFileSync(resolve(__dirname, '../../../package.json'), 'utf8')) as {
    version: string
  }
  return pkg.version
}

describe('版本与双栈漂移契约', () => {
  it('package.json 与桥接层版本一致', () => {
    expect(cCoreBridge.getStatus().version).toBe(pkgVersion())
  })

  it('C 源码版本与 package.json 一致', () => {
    const v = pkgVersion()
    const mainC = readFileSync(resolve(__dirname, '../../../c-core/src/main.c'), 'utf8')
    const rpcC = readFileSync(resolve(__dirname, '../../../c-core/src/json_rpc.c'), 'utf8')
    expect(mainC).toContain(v)
    expect(rpcC).toContain(v)
  })

  it('TS 硬红线基线不被弱化：磁盘/删库/删.git 一律 blocked/hard', () => {
    expect(auditHardLines('format D:')?.tier).toBe('blocked')
    expect(auditHardLines('rm -rf .git')?.tier).toBe('hard')
    expect(auditHardLines('DROP TABLE users')?.tier).toBe('hard')
    expect(auditHardLines('DELETE FROM users')?.tier).toBe('hard')
    expect(auditHardLines('git push --force')?.tier).toBe('hard')
  })
})
