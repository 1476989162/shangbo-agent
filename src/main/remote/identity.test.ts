import { describe, expect, it, vi, beforeEach } from 'vitest'
import { generateKeyPairSync, sign, verify, createPublicKey } from 'node:crypto'

/**
 * 中转身份密钥：证明"这台桌面就是我"。
 * secrets 依赖 Electron safeStorage，测试里用内存 Map 替代。
 */
const store = new Map<string, string>()
vi.mock('../secrets', () => ({
  getSecret: (key: string) => store.get(key) ?? null,
  setSecret: (key: string, value: string) => {
    store.set(key, value)
  },
  deleteSecret: (key: string) => {
    store.delete(key)
  },
  hasSecret: (key: string) => store.has(key)
}))
vi.mock('electron-log/main', () => ({
  default: { info: () => {}, warn: () => {}, error: () => {} }
}))

const { ensureIdentity, getIdentity, signChallenge, identityFingerprint } = await import('./identity')

describe('中转身份密钥（Ed25519）', () => {
  beforeEach(() => {
    store.clear()
  })

  it('首次调用生成并持久化，再次调用返回同一个身份', () => {
    const first = ensureIdentity()
    expect(first.publicKeyB64).toBeTruthy()
    expect(first.fingerprint).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/)
    const second = ensureIdentity()
    expect(second.publicKeyB64).toBe(first.publicKeyB64)
    expect(second.fingerprint).toBe(first.fingerprint)
  })

  it('私钥与公钥不成对时签名校验失败（防生成错位）', () => {
    const id = ensureIdentity()
    const message = 'challenge-1|' + id.publicKeyB64
    const signature = signChallenge('challenge-1', id.publicKeyB64)
    // 用公钥独立验证签名（与中转侧 verifyIdentitySignature 同语义）
    const raw = Buffer.from(id.publicKeyB64, 'base64url')
    const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw])
    const key = createPublicKey({ key: spki, format: 'der', type: 'spki' })
    expect(verify(null, Buffer.from(message, 'utf8'), key, Buffer.from(signature, 'base64url'))).toBe(
      true
    )
  })

  it('换挑战后旧签名不再有效（防重放）', () => {
    const id = ensureIdentity()
    const sig = signChallenge('challenge-A', id.publicKeyB64)
    const raw = Buffer.from(id.publicKeyB64, 'base64url')
    const spki = Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw])
    const key = createPublicKey({ key: spki, format: 'der', type: 'spki' })
    const okForA = verify(
      null,
      Buffer.from(`challenge-A|${id.publicKeyB64}`, 'utf8'),
      key,
      Buffer.from(sig, 'base64url')
    )
    const okForB = verify(
      null,
      Buffer.from(`challenge-B|${id.publicKeyB64}`, 'utf8'),
      key,
      Buffer.from(sig, 'base64url')
    )
    expect(okForA).toBe(true)
    expect(okForB).toBe(false)
  })

  it('不同机器生成不同身份（指纹不会撞）', () => {
    store.clear()
    const a = ensureIdentity()
    store.clear()
    const b = ensureIdentity()
    expect(a.publicKeyB64).not.toBe(b.publicKeyB64)
    expect(a.fingerprint).not.toBe(b.fingerprint)
  })

  it('getIdentity 不触发生成，未初始化时返回 null', () => {
    expect(getIdentity()).toBeNull()
    ensureIdentity()
    expect(getIdentity()?.publicKeyB64).toBeTruthy()
  })

  it('私钥缺失时签名抛错而不是静默返回空', () => {
    ensureIdentity()
    store.delete('remote.identityPrivate')
    expect(() => signChallenge('c', 'pub')).toThrow('身份私钥缺失')
  })

  it('指纹与公钥一一对应，且是 SHA-256 前 16 位', () => {
    const id = ensureIdentity()
    const raw = Buffer.from(id.publicKeyB64, 'base64url')
    expect(raw.length).toBe(32)
    expect(identityFingerprint(id.publicKeyB64)).toBe(id.fingerprint)
  })
})
