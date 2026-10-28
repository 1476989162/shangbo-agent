import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { generateKeyPairSync, sign } from 'node:crypto'
import {
  parseAllowedDesktops,
  canonicalize,
  canonicalFingerprint,
  identityFingerprint,
  verifyIdentitySignature
} from '../identity.mjs'

/** 造一个 Ed25519 身份，返回裸公钥 base64url 与签名函数。 */
function makeIdentity() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const spki = publicKey.export({ format: 'der', type: 'spki' })
  const raw = spki.subarray(spki.length - 32)
  const pubB64 = Buffer.from(raw).toString('base64url')
  return {
    pubB64,
    fingerprint: identityFingerprint(pubB64),
    canonical: canonicalFingerprint(pubB64),
    sign: (message) => sign(null, Buffer.from(message, 'utf8'), privateKey).toString('base64url')
  }
}

describe('中转身份鉴权（Ed25519）', () => {
  it('正确签名通过校验，篡改消息/签名失败', () => {
    const id = makeIdentity()
    const message = 'challenge-abc|' + id.pubB64
    assert.equal(verifyIdentitySignature(id.pubB64, message, id.sign(message)), true)
    // 消息被改（换挑战）
    assert.equal(verifyIdentitySignature(id.pubB64, 'other-challenge|' + id.pubB64, id.sign(message)), false)
    // 签名被改
    assert.equal(verifyIdentitySignature(id.pubB64, message, 'A'.repeat(86)), false)
  })

  it('别人的签名冒充不了（这是"只有我能用"的核心）', () => {
    const mine = makeIdentity()
    const attacker = makeIdentity()
    const message = 'challenge-xyz|' + mine.pubB64
    // 攻击者用自己的私钥签我的公钥绑定串 → 失败
    assert.equal(verifyIdentitySignature(mine.pubB64, message, attacker.sign(message)), false)
    // 攻击者抄了我的公钥但没私钥 → 也失败
    assert.equal(
      verifyIdentitySignature(mine.pubB64, message, attacker.sign('challenge-xyz|' + attacker.pubB64)),
      false
    )
  })

  it('畸形输入返回 false 而不是抛错', () => {
    assert.equal(verifyIdentitySignature('not-a-key', 'msg', 'sig'), false)
    assert.equal(verifyIdentitySignature(null, 'msg', 'sig'), false)
    assert.equal(verifyIdentitySignature('', '', ''), false)
    const id = makeIdentity()
    assert.equal(verifyIdentitySignature(id.pubB64, 'm', 'short'), false)
  })

  it('白名单可用指纹或公钥两种写法，归一化后一致', () => {
    const id = makeIdentity()
    const fromFingerprint = parseAllowedDesktops(id.fingerprint)
    const fromPublicKey = parseAllowedDesktops(id.pubB64)
    assert.equal(fromFingerprint.size, 1)
    assert.equal(fromPublicKey.size, 1)
    assert.deepEqual([...fromFingerprint], [...fromPublicKey])
    // 大小写与分隔符不影响
    assert.deepEqual([...parseAllowedDesktops(id.fingerprint.toLowerCase())], [...fromFingerprint])
    assert.deepEqual([...parseAllowedDesktops(id.fingerprint.replace(/-/g, ''))], [...fromFingerprint])
    // 内部一律 canonical（无分隔大写），比较不会因书写形式错配
    assert.deepEqual([...fromFingerprint], [id.canonical])
  })

  it('白名单支持多个身份、忽略空项与非法项', () => {
    const a = makeIdentity()
    const b = makeIdentity()
    const allowed = parseAllowedDesktops(`${a.fingerprint}, ,${b.pubB64},乱写`)
    assert.equal(allowed.size, 2)
    assert.ok(allowed.has(a.canonical))
    assert.ok(allowed.has(b.canonical))
    // 非法项不会让整份配置作废
    assert.equal(parseAllowedDesktops('').size, 0)
    assert.equal(parseAllowedDesktops('乱写,不是指纹').size, 0)
  })

  it('未在白名单内的公钥被判定为不允许', () => {
    const mine = makeIdentity()
    const other = makeIdentity()
    const allowed = parseAllowedDesktops(mine.fingerprint)
    assert.ok(allowed.has(canonicalize(mine.pubB64)))
    assert.equal(allowed.has(canonicalize(other.pubB64)), false)
  })
})
