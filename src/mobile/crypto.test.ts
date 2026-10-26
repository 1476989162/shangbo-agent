import { describe, expect, it } from 'vitest'
import { paramHashOf } from './crypto-node'
import { stableStringify, paramHashOf as webParamHashOf } from './crypto-web'
import { canonicalParamString } from '@shared/remote'

/* 阶段4：手机端哈希算法必须与桌面/共享层一致（审批绑定跨端核对）。 */

describe('手机端参数哈希一致性', () => {
  it('stableStringify 与共享层 canonicalParamString 一致', () => {
    const input = { b: 2, a: 1, nested: { y: [3, 2], x: 1 }, n: null }
    expect(stableStringify(input)).toBe(canonicalParamString(input))
  })

  it('Node 版与桌面 runtime.paramHashOf 一致', async () => {
    const { AgentRuntime } = await import('@main/agent/runtime')
    const input = { command: 'npm test', cwd: '/tmp' }
    expect(paramHashOf(input)).toBe(AgentRuntime.paramHashOf(input))
  })

  it('Web 版（async）与共享层一致', async () => {
    const input = { command: 'npm test', cwd: '/tmp', arr: [1, { z: 2, a: 1 }] }
    expect(await webParamHashOf(input)).toBe(paramHashOf(input))
  })

  it('手机端不含敏感入口：link 只暴露白名单 op', async () => {
    const src = await import('node:fs').then((fs) => fs.readFileSync('src/mobile/link.ts', 'utf8'))
    for (const banned of ['settings:set', 'provider:', 'dialog:', 'app:quit', 'apiKey', 'ApiKey', 'API_KEY']) {
      expect(src.includes(banned)).toBe(false)
    }
  })
})
