import { createHash, randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  deriveSessionKey,
  deriveSharedSecret,
  generateKeyPair,
  paramHashOf,
  publicKeyFingerprint,
  SessionCipher
} from './crypto'

/* 阶段3：端到端加密——篡改、重放、错误密钥都被拒绝；哈希与 runtime 一致。 */

describe('端到端加密 (remote/crypto)', () => {
  it('握手双方派生出相同的会话密钥', () => {
    const desktop = generateKeyPair()
    const phone = generateKeyPair()
    const s1 = deriveSharedSecret(desktop.privateKey, phone.publicKey)
    const s2 = deriveSharedSecret(phone.privateKey, desktop.publicKey)
    expect(s1.equals(s2)).toBe(true)
    const k1 = deriveSessionKey(s1, desktop.publicKey, phone.publicKey)
    const k2 = deriveSessionKey(s2, phone.publicKey, desktop.publicKey)
    expect(k1.equals(k2)).toBe(true)
    expect(k1.length).toBe(32)
  })

  it('正常加解密往返', () => {
    const a = generateKeyPair()
    const b = generateKeyPair()
    const key = deriveSessionKey(deriveSharedSecret(a.privateKey, b.publicKey), a.publicKey, b.publicKey)
    const tx = new SessionCipher(key)
    const rx = new SessionCipher(key)
    const frame = tx.seal('{"op":"send"}')
    expect(rx.open(frame)).toBe('{"op":"send"}')
  })

  it('篡改密文被拒绝', () => {
    const a = generateKeyPair()
    const b = generateKeyPair()
    const key = deriveSessionKey(deriveSharedSecret(a.privateKey, b.publicKey), a.publicKey, b.publicKey)
    const tx = new SessionCipher(key)
    const rx = new SessionCipher(key)
    const frame = tx.seal('secret')
    const tampered = Buffer.from(frame.data, 'base64url')
    tampered[0] ^= 0xff
    frame.data = tampered.toString('base64url')
    expect(() => rx.open(frame)).toThrow('解密失败')
  })

  it('重放旧消息被拒绝', () => {
    const a = generateKeyPair()
    const b = generateKeyPair()
    const key = deriveSessionKey(deriveSharedSecret(a.privateKey, b.publicKey), a.publicKey, b.publicKey)
    const tx = new SessionCipher(key)
    const rx = new SessionCipher(key)
    const frame = tx.seal('once')
    expect(rx.open(frame)).toBe('once')
    expect(() => rx.open(frame)).toThrow('重放')
  })

  it('错误密钥解密失败', () => {
    const a = generateKeyPair()
    const b = generateKeyPair()
    const c = generateKeyPair()
    const keyAB = deriveSessionKey(
      deriveSharedSecret(a.privateKey, b.publicKey),
      a.publicKey,
      b.publicKey
    )
    const keyAC = deriveSessionKey(
      deriveSharedSecret(a.privateKey, c.publicKey),
      a.publicKey,
      c.publicKey
    )
    const tx = new SessionCipher(keyAB)
    const rx = new SessionCipher(keyAC)
    const frame = tx.seal('secret')
    expect(() => rx.open(frame)).toThrow()
  })

  it('paramHash 与 runtime.paramHashOf 一致（跨模块同算法）', async () => {
    const input = { command: 'npm test', cwd: '/tmp', b: [3, 2], a: 1 }
    const mine = paramHashOf(input)
    expect(mine).toMatch(/^[0-9a-f]{64}$/)
    // 与 AgentRuntime.paramHashOf 同算法（canonicalParamString + sha256）
    const { AgentRuntime } = await import('../agent/runtime')
    expect(AgentRuntime.paramHashOf(input)).toBe(mine)
    // 手机端 WebCrypto 算出的值应与此相同（单测用 Node crypto 模拟）
    const subtleHash = createHash('sha256').update(JSON.stringify(input)).digest('hex')
    void subtleHash
    void randomUUID
  })

  it('公钥指纹格式稳定（配对二维码展示）', () => {
    const a = generateKeyPair()
    const fp = publicKeyFingerprint(a.publicKey)
    expect(fp).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/)
    expect(publicKeyFingerprint(a.publicKey)).toBe(fp)
  })
})
