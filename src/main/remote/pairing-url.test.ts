import { describe, expect, it } from 'vitest'
import { buildPairingUrl } from './pairing-url'

describe('手机配对链接', () => {
  it('从 wss 中转地址生成同源 HTTPS PWA 链接', () => {
    const url = new URL(
      buildPairingUrl(
        'wss://www.lnbxsoft.com/sb-remote/',
        '123456',
        'desktop-public-key',
        'ABCD-1234-EFGH-5678',
        'Pixel'
      )
    )
    expect(url.protocol).toBe('https:')
    expect(url.host).toBe('www.lnbxsoft.com')
    expect(url.pathname).toBe('/sb-remote/')
    expect(url.searchParams.get('v')).toBe('1')
    expect(url.searchParams.get('relay')).toBe('wss://www.lnbxsoft.com/sb-remote/')
    expect(url.searchParams.get('code')).toBe('123456')
    expect(url.searchParams.get('pub')).toBe('desktop-public-key')
    expect(url.searchParams.get('fp')).toBe('ABCD-1234-EFGH-5678')
    expect(url.searchParams.get('name')).toBe('Pixel')
  })

  it('拒绝明文中转地址', () => {
    expect(() => buildPairingUrl('ws://example.com', '123456', 'pub', 'fp')).toThrow(
      '中转地址必须为 wss://'
    )
  })
})
