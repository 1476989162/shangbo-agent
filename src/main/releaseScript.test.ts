import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { describe, expect, it } from 'vitest'

const releaseScript = readFileSync('scripts/release.mjs', 'utf8')
const releasePreflight = readFileSync('scripts/release-preflight.mjs', 'utf8')

describe('发布脚本构建顺序', () => {
  it('在任何构建前检查脏工作区与目标标签', () => {
    const preflight = releaseScript.indexOf('assertReleasePreflight(version)')
    const build = releaseScript.indexOf("sh('npm run build')")
    expect(preflight).toBeGreaterThan(-1)
    expect(preflight).toBeLessThan(build)
    expect(releasePreflight).toContain('禁止复用旧标签或覆盖同版本 Release')
    expect(releaseScript).not.toContain('tag ${tag} 已存在，跳过建 tag')
  })
  it('先重新生成 out/ 再调用 electron-builder', () => {
    const buildIndex = releaseScript.indexOf("sh('npm run build')")
    const packageIndex = releaseScript.indexOf('npx electron-builder')

    expect(buildIndex).toBeGreaterThan(-1)
    expect(packageIndex).toBeGreaterThan(-1)
    expect(buildIndex).toBeLessThan(packageIndex)
  })
  it('当前脏工作区与既有 v0.9.4 会在任何构建前被拒绝', () => {
    const direct = spawnSync(process.execPath, [
      '--input-type=module',
      '--eval',
      "import { assertReleasePreflight } from './scripts/release-preflight.mjs'; try { assertReleasePreflight('0.9.4'); process.exitCode = 2 } catch (error) { console.log(error.message) }"
    ], { cwd: process.cwd(), encoding: 'utf8', timeout: 15_000 })
    expect(direct.status).toBe(0)
    expect(direct.stdout).toMatch(/发版前必须提交源码改动|禁止复用旧标签/)
    const result = spawnSync(process.execPath, ['scripts/release.mjs', '0.9.4'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      timeout: 15_000
    })
    expect(result.status).toBe(1)
    expect(result.stderr).not.toContain('npm run typecheck')
    expect(result.stdout).not.toContain('electron-builder')
  }, 20_000)
})
