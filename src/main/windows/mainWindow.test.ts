import { describe, expect, it, vi } from 'vitest'

/* P0-6 外链白名单：模型输出的链接被 linkify 后用户点击即触发，
   file:// 与伪协议必须挡在外面。 */

vi.mock('electron', () => ({
  BrowserWindow: class {},
  app: { isPackaged: false },
  protocol: {},
  session: {},
  shell: { openExternal: async () => {} }
}))

vi.mock('electron-log/main', () => ({
  default: { info: () => {}, warn: () => {}, error: () => {} }
}))

import { isSafeExternalUrl } from './mainWindow'

describe('isSafeExternalUrl 外部链接白名单', () => {
  it('放行 http/https/mailto（含前后空白与大小写变体）', () => {
    expect(isSafeExternalUrl('https://example.com/a?b=1')).toBe(true)
    expect(isSafeExternalUrl('http://localhost:3000/docs')).toBe(true)
    expect(isSafeExternalUrl('mailto:someone@example.com')).toBe(true)
    expect(isSafeExternalUrl('  HTTPS://EXAMPLE.COM  ')).toBe(true)
  })

  it('拦截 file://、伪协议与 UNC 路径', () => {
    expect(isSafeExternalUrl('file://C:/Windows/system.ini')).toBe(false)
    expect(isSafeExternalUrl('ms-msdt:foo')).toBe(false)
    expect(isSafeExternalUrl('search-ms:query')).toBe(false)
    expect(isSafeExternalUrl('javascript:alert(1)')).toBe(false)
    expect(isSafeExternalUrl('\\\\server\\share')).toBe(false)
    expect(isSafeExternalUrl('')).toBe(false)
  })
})
