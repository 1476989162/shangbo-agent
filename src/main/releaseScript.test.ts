import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const releaseScript = readFileSync('scripts/release.mjs', 'utf8')

describe('发布脚本构建顺序', () => {
  it('先重新生成 out/ 再调用 electron-builder', () => {
    const buildIndex = releaseScript.indexOf("sh('npm run build')")
    const packageIndex = releaseScript.indexOf('npx electron-builder')

    expect(buildIndex).toBeGreaterThan(-1)
    expect(packageIndex).toBeGreaterThan(-1)
    expect(buildIndex).toBeLessThan(packageIndex)
  })
})
