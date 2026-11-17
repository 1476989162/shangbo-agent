import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * Provider 种子自愈回归测试。
 * 线上症状：老库已种子化后新增 maas 三模型，下拉看不到（“这三个模型看不到”）。
 * 根因类型：seed-once 之后不再管 + 无测试锁住。进化点：MAGPIE_MODELS 唯一真源 + heal 幂等并集。
 */

let userDataDir = ''

vi.mock('electron', () => ({
  app: { getPath: () => process.env['STORE_TEST_USER_DATA'] ?? tmpdir() }
}))

vi.mock('electron-log/main', () => ({
  default: { info: () => {}, warn: () => {}, error: () => {} }
}))

// secrets 走 Electron safeStorage，测试里用内存 Map 替代，避免碰真实密钥环
const secretStore = new Map<string, string>()
vi.mock('../secrets', () => ({
  getSecret: (key: string) => secretStore.get(key) ?? null,
  setSecret: (key: string, value: string) => {
    secretStore.set(key, value)
  },
  deleteSecret: (key: string) => {
    secretStore.delete(key)
  },
  hasSecret: (key: string) => secretStore.has(key)
}))

beforeAll(() => {
  userDataDir = mkdtempSync(join(tmpdir(), 'shangbo-store-test-'))
  process.env['STORE_TEST_USER_DATA'] = userDataDir
})

afterAll(async () => {
  const { closeDatabase } = await import('../db/index')
  closeDatabase()
  rmSync(userDataDir, { recursive: true, force: true })
})

beforeEach(async () => {
  const { getDb } = await import('../db/index')
  getDb().prepare('DELETE FROM providers').run()
  getDb().prepare('DELETE FROM settings WHERE key = ?').run('providers.seeded')
  secretStore.clear()
})

async function loadStore() {
  return import('./store')
}

describe('MAGPIE_MODELS 唯一真源', () => {
  it('收录 maas 三模型，老库自愈有依据', async () => {
    const { MAGPIE_MODELS } = await loadStore()
    expect(MAGPIE_MODELS).toContain('trae-cn/deepseek-v4.1-flash-max')
    expect(MAGPIE_MODELS).toContain('maas-qianwenaiapi/deepseek-v4.1-flash-1017')
    expect(MAGPIE_MODELS).toContain('maas-qianwenaiapi/glm-5.3-flash')
    expect(MAGPIE_MODELS).toContain('maas-qianwenaiapi/qwen3.8-flash')
  })
})

describe('ensureDefaultProviders + healMagpieModels', () => {
  it('首次种子即带全量 Magpie 模型', async () => {
    const { ensureDefaultProviders, listProviders, MAGPIE_BASE_URL } = await loadStore()
    ensureDefaultProviders()
    const magpie = listProviders().find((p) => p.baseUrl === MAGPIE_BASE_URL)
    expect(magpie).toBeTruthy()
    for (const m of (await loadStore()).MAGPIE_MODELS) {
      expect(magpie!.models).toContain(m)
    }
  })

  it('老库只有 trae-cn 单模型时自动补齐三模型', async () => {
    const { getDb } = await import('../db/index')
    const { healMagpieModels, listProviders, MAGPIE_BASE_URL, MAGPIE_MODELS } = await loadStore()
    const { upsertProvider } = await loadStore()
    // 模拟老种子：只有 1 个模型
    upsertProvider({
      name: 'Magpie 网关',
      kind: 'openai-compatible',
      baseUrl: MAGPIE_BASE_URL,
      models: ['trae-cn/deepseek-v4.1-flash-max'],
      enabled: false,
      priority: 5
    })
    // 标记已种子化，确保走的是 heal 而不是重播种子
    getDb().prepare(`INSERT INTO settings (key, value) VALUES (?, ?)`).run('providers.seeded', 'true')

    healMagpieModels()

    const magpie = listProviders().find((p) => p.baseUrl === MAGPIE_BASE_URL)
    expect(magpie!.models).toEqual(expect.arrayContaining(MAGPIE_MODELS))
    expect(magpie!.models.length).toBe(MAGPIE_MODELS.length)
  })

  it('保留用户自加模型，只做并集不覆盖', async () => {
    const { healMagpieModels, listProviders, MAGPIE_BASE_URL, MAGPIE_MODELS } = await loadStore()
    const { upsertProvider } = await loadStore()
    upsertProvider({
      name: 'Magpie 网关',
      kind: 'openai-compatible',
      baseUrl: MAGPIE_BASE_URL,
      models: ['trae-cn/deepseek-v4.1-flash-max', 'my-custom-model'],
      enabled: false,
      priority: 5
    })

    healMagpieModels()
    healMagpieModels() // 幂等：跑两次也不应重复

    const magpie = listProviders().find((p) => p.baseUrl === MAGPIE_BASE_URL)!
    expect(magpie.models).toContain('my-custom-model')
    for (const m of MAGPIE_MODELS) expect(magpie.models).toContain(m)
    // 无重复
    expect(new Set(magpie.models).size).toBe(magpie.models.length)
  })

  it('非 Magpie 供应商不受 heal 影响', async () => {
    const { healMagpieModels, listProviders } = await loadStore()
    const { upsertProvider } = await loadStore()
    upsertProvider({
      name: 'DeepSeek',
      kind: 'openai-compatible',
      baseUrl: 'https://api.deepseek.com/v1',
      models: ['deepseek-chat'],
      enabled: false,
      priority: 10
    })

    healMagpieModels()

    expect(listProviders().find((p) => p.name === 'DeepSeek')!.models).toEqual(['deepseek-chat'])
  })
})
