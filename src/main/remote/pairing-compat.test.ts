import { describe, expect, it } from 'vitest'
import { generateKeyPairSync, diffieHellman, createPublicKey, type KeyObject } from 'node:crypto'
import { x25519 } from '@noble/curves/ed25519.js'
import { deriveSessionKey } from './crypto'
import { createPairingSession } from '../../mobile/pairing'

/* 真实配对握手复刻：桌面 Node X25519 与手机 noble X25519 派生出的会话密钥必须逐字节一致。
 * 若此处变红，说明两端 ECDH/HKDF 实现分叉，线上必然全量解密失败（请求超时+空列表）。 */

const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex')

function nodeKeypair(): { pubRaw: Buffer; priv: KeyObject } {
  const { privateKey } = generateKeyPairSync('x25519')
  const spki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }) as Buffer
  return { pubRaw: Buffer.from(spki.subarray(spki.length - 32)), priv: privateKey }
}

function nodeShared(priv: KeyObject, peerRaw: Buffer): Buffer {
  return diffieHellman({
    privateKey: priv,
    publicKey: createPublicKey({ key: Buffer.concat([SPKI_PREFIX, peerRaw]), format: 'der', type: 'spki' })
  }) as Buffer
}

describe('配对密钥派生互通（桌面 Node ↔ 手机 noble）', () => {
  it('共享密钥一致', () => {
    const desktop = nodeKeypair()
    const phonePriv = x25519.utils.randomSecretKey()
    const phonePub = x25519.getPublicKey(phonePriv)
    const fromNode = nodeShared(desktop.priv, Buffer.from(phonePub))
    const fromNoble = Buffer.from(x25519.getSharedSecret(phonePriv, new Uint8Array(desktop.pubRaw)))
    expect(fromNoble.toString('hex')).toBe(fromNode.toString('hex'))
  })

  it('完整握手：手机会话密钥 == 桌面用手机公钥派生的密钥', () => {
    const desktop = nodeKeypair()
    const mobile = createPairingSession(desktop.pubRaw.toString('base64url'))
    const phonePub = Buffer.from(mobile.phonePublicKeyB64, 'base64url')
    const desktopKey = deriveSessionKey(nodeShared(desktop.priv, phonePub), desktop.pubRaw, phonePub)
    expect(desktopKey.toString('base64url')).toBe(mobile.sessionKeyB64)
  })
})
