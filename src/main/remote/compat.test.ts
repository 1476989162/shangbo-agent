import { describe, expect, it } from 'vitest'
import { SessionCipher } from './crypto'
import { buildNonce24, checkNonceSeq, openXChaCha, sealXChaCha } from '../../mobile/chacha'

/* 桌面↔手机加密互通：历史上两端各自定义 nonce 布局与 tag算法导致 online 但永远解密失败。
 * 本单测用真实现双向跑通，任一端再改帧格式这里立刻变红。 */

function b64u(b: Uint8Array): string {
  return Buffer.from(b).toString('base64url')
}
function ub(s: string): Uint8Array {
  return new Uint8Array(Buffer.from(s, 'base64url'))
}
function randomKey(): Uint8Array {
  const k = new Uint8Array(32)
  crypto.getRandomValues(k)
  return k
}
const enc = new TextEncoder()
const dec = new TextDecoder()

describe('桌面↔手机加密互通', () => {
  it('nonce 序号布局与桌面 seqToBytes 等价（hi/be32 + lo/be32 + 4 零字节）', () => {
    for (const seq of [0, 1, 255, 256, 65536, 0x01020304, 0xffffffff]) {
      const n = buildNonce24(seq, new Uint8Array(12).fill(7))
      expect(n.length).toBe(24)
      expect(checkNonceSeq(n, seq)).toBe(true)
      expect(checkNonceSeq(n, (seq + 1) >>> 0)).toBe(false)
    }
    expect([...buildNonce24(0x01020304, new Uint8Array(12)).subarray(12)]).toEqual([
      0, 0, 0, 0, 1, 2, 3, 4, 0, 0, 0, 0
    ])
    expect(() => buildNonce24(0x100000000, new Uint8Array(12))).toThrow()
  })

  it('桌面 seal → 手机 open（会话列表/消息下行方向）', async () => {
    const key = randomKey()
    const desktop = new SessionCipher(Buffer.from(key))
    const frame = desktop.seal('你好手机这是会话内容')
    const plain = await openXChaCha(ub(frame.data), ub(frame.nonce), key)
    expect(plain && dec.decode(plain)).toBe('你好手机这是会话内容')
  })

  it('手机 seal → 桌面 open（发送消息上行方向）', async () => {
    const key = randomKey()
    const seq = 5
    const nonce = buildNonce24(seq, new Uint8Array(12).fill(9))
    const sealed = await sealXChaCha(enc.encode('手机发给桌面'), nonce, key)
    const desktop = new SessionCipher(Buffer.from(key))
    expect(desktop.open({ seq, nonce: b64u(nonce), data: b64u(sealed) })).toBe('手机发给桌面')
  })

  it('多帧连续双向不丢不乱序', async () => {
    const key = randomKey()
    const desktop = new SessionCipher(Buffer.from(key))
    for (let i = 0; i < 3; i++) {
      const frame = desktop.seal(`下行${i}`)
      const plain = await openXChaCha(ub(frame.data), ub(frame.nonce), key)
      expect(plain && dec.decode(plain)).toBe(`下行${i}`)
    }
    const desktop2 = new SessionCipher(Buffer.from(key))
    for (let i = 0; i < 3; i++) {
      const nonce = buildNonce24(i, new Uint8Array(12).fill(i + 1))
      const sealed = await sealXChaCha(enc.encode(`上行${i}`), nonce, key)
      expect(desktop2.open({ seq: i, nonce: b64u(nonce), data: b64u(sealed) })).toBe(`上行${i}`)
    }
  })

  it('篡改密文两端都拒绝（桌面验手机帧手机验桌面帧）', async () => {
    const key = randomKey()
    const desktop = new SessionCipher(Buffer.from(key))
    const frame = desktop.seal('原始')
    const bad = ub(frame.data)
    bad[0] ^= 1
    await expect(openXChaCha(bad, ub(frame.nonce), key)).resolves.toBeNull()

    const nonce = buildNonce24(0, new Uint8Array(12))
    const sealed = await sealXChaCha(enc.encode('原始'), nonce, key)
    sealed[0] ^= 1
    expect(() => desktop.open({ seq: 0, nonce: b64u(nonce), data: b64u(sealed) })).toThrow()
  })
})
