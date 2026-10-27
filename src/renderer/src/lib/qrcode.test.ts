import { describe, expect, it } from 'vitest'
import jsQR from 'jsqr'
import { makeQrMatrix } from './qrcode'

/* 配对二维码：必须能被真实扫码器完整解码，而不只是“看起来像二维码”。 */

describe('配对二维码 (qrcode)', () => {
  function decode(matrix: boolean[][], scale = 6): string | null {
    const quiet = 4
    const width = (matrix.length + quiet * 2) * scale
    const pixels = new Uint8ClampedArray(width * width * 4)
    pixels.fill(255)
    for (let row = 0; row < matrix.length; row++) {
      for (let col = 0; col < matrix.length; col++) {
        if (!matrix[row][col]) continue
        for (let y = 0; y < scale; y++) {
          for (let x = 0; x < scale; x++) {
            const offset =
              ((row + quiet) * scale + y) * width * 4 + ((col + quiet) * scale + x) * 4
            pixels[offset] = 0
            pixels[offset + 1] = 0
            pixels[offset + 2] = 0
            pixels[offset + 3] = 255
          }
        }
      }
    }
    return jsQR(pixels, width, width, { inversionAttempts: 'dontInvert' })?.data ?? null
  }

  it('短文本可被真实解码器完整还原', () => {
    const m = makeQrMatrix('hello')
    expect(m.length).toBe(21)
    expect(decode(m)).toBe('hello')
  })

  it('完整配对链接可被真实解码器完整还原', () => {
    const qrText =
      'https://www.lnbxsoft.com/sb-remote/?relay=wss%3A%2F%2Fwww.lnbxsoft.com%2Fsb-remote%2F' +
      '&code=123456&pub=' +
      'A'.repeat(43) +
      '&fp=ABCD-1234-EFGH-5678&secret=' +
      'B'.repeat(43)
    const m = makeQrMatrix(qrText)
    expect(m.length % 2).toBe(1)
    expect(m.length).toBeGreaterThanOrEqual(21)
    expect(decode(m)).toBe(qrText)
  })

  it('内容不同矩阵不同（扫码不会撞）', () => {
    const a = JSON.stringify(makeQrMatrix('https://example.com/?code=111111'))
    const b = JSON.stringify(makeQrMatrix('https://example.com/?code=222222'))
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
