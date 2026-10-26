import { describe, expect, it } from 'vitest'
import { makeQrMatrix } from './qrcode'

/* 配对二维码：版本自动、寻像图形正确、内容变化矩阵变化。 */

describe('配对二维码 (qrcode)', () => {
  it('短文本生成版本1（21x21）', () => {
    const m = makeQrMatrix('hello')
    expect(m.length).toBe(21)
    expect(m[0][0]).toBe(true)
    expect(m[0][6]).toBe(true)
  })

  it('配对 JSON（约 300 字节）能生成且尺寸合法', () => {
    const qrText = JSON.stringify({
      v: 1,
      relayUrl: 'wss://www.lnbxsoft.com/sb-remote/',
      code: '123456',
      desktopPub: 'A'.repeat(43),
      fingerprint: 'ABCD-1234-EFGH-5678',
      name: 'test'
    })
    const m = makeQrMatrix(qrText)
    // 版本自动：尺寸 = 版本*4+17，且为奇数
    expect(m.length % 2).toBe(1)
    expect(m.length).toBeGreaterThanOrEqual(21)
    expect(m.length).toBeLessThanOrEqual(57)
  })

  it('内容不同矩阵不同（扫码不会撞）', () => {
    const a = JSON.stringify(makeQrMatrix('code-111111'))
    const b = JSON.stringify(makeQrMatrix('code-222222'))
    expect(a).not.toBe(b)
  })

  it('寻像图形三定位点正确', () => {
    const m = makeQrMatrix('test')
    const size = m.length
    // 左上、右上、左下的 7x7 寻像区角点为黑
    expect(m[0][0]).toBe(true)
    expect(m[0][size - 1]).toBe(true)
    expect(m[size - 1][0]).toBe(true)
    // 寻像中心为黑
    expect(m[3][3]).toBe(true)
  })
})
