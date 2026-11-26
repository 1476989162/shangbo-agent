import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/* settings 写透缓存：真实 SQLite + 临时 userData 目录，不碰真实库。 */

let userDataDirA = ''
let userDataDirB = ''

vi.mock('electron', () => ({
  app: { getPath: () => process.env['SETTINGS_TEST_USER_DATA'] ?? tmpdir() }
}))

vi.mock('electron-log/main', () => ({
  default: { info: () => {}, warn: () => {}, error: () => {} }
}))

beforeAll(() => {
  userDataDirA = mkdtempSync(join(tmpdir(), 'shangbo-settings-test-a-'))
  userDataDirB = mkdtempSync(join(tmpdir(), 'shangbo-settings-test-b-'))
  process.env['SETTINGS_TEST_USER_DATA'] = userDataDirA
})

afterAll(() => {
  closeDatabase()
  rmSync(userDataDirA, { recursive: true, force: true })
  rmSync(userDataDirB, { recursive: true, force: true })
})

import { closeDatabase, getDb } from './db'
import { clearSettingsCache, getAllSettings, getSetting, setSetting } from './settings'

describe('settings 写透缓存', () => {
  it('写入后命中内存，绕过缓存的直接改库读到旧值（证明缓存生效）', () => {
    setSetting('test.cache.key', { n: 1 })
    expect(getSetting<unknown>('test.cache.key', null)).toEqual({ n: 1 })
    // 绕过 setSetting 直接改库：缓存未失效前读到的仍是旧值
    getDb()
      .prepare('UPDATE settings SET value = ? WHERE key = ?')
      .run(JSON.stringify({ n: 2 }), 'test.cache.key')
    expect(getSetting<unknown>('test.cache.key', null)).toEqual({ n: 1 })
  })

  it('clearSettingsCache 后读到库里最新值', () => {
    clearSettingsCache()
    expect(getSetting<unknown>('test.cache.key', null)).toEqual({ n: 2 })
  })

  it('getAllSettings 与单条读写同一份视图', () => {
    setSetting('test.cache.other', 'hello')
    expect(getAllSettings()['test.cache.other']).toBe('hello')
    expect(getSetting('test.cache.other', '')).toBe('hello')
  })

  it('关库换库后零跨库脏读', () => {
    setSetting('test.cache.isolation', '库A的值')
    expect(getSetting('test.cache.isolation', '')).toBe('库A的值')
    closeDatabase()
    process.env['SETTINGS_TEST_USER_DATA'] = userDataDirB
    // 新库同名键不存在：必须回退 fallback，不能泄漏库A的值
    expect(getSetting('test.cache.isolation', 'fallback')).toBe('fallback')
    expect(getSetting('test.cache.key', 'fallback')).toBe('fallback')
    // 新库写入不影响旧库视图
    setSetting('test.cache.isolation', '库B的值')
    expect(getSetting('test.cache.isolation', '')).toBe('库B的值')
  })
})
