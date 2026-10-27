import { x25519 } from '@noble/curves/ed25519.js'
import { hkdf } from '@noble/hashes/hkdf.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { b64urlDecode, b64urlEncode } from './crypto-web'

const HKDF_INFO = new TextEncoder().encode('shangbo-remote-v1')

export interface PairingSession {
  phonePublicKeyB64: string
  sessionKeyB64: string
}

function concatBytes(a: Uint8Array, b: Uint8Array): Uint8Array {
  const out = new Uint8Array(a.length + b.length)
  out.set(a, 0)
  out.set(b, a.length)
  return out
}

function compareBytes(a: Uint8Array, b: Uint8Array): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    if (a[i] !== b[i]) return a[i] - b[i]
  }
  return a.length - b.length
}

/**
 * 手机侧 X25519 配对。派生参数必须与桌面 deriveSessionKey 完全一致：
 * HKDF-SHA256(sharedSecret, salt=两端公钥排序拼接, info='shangbo-remote-v1')。
 */
export function createPairingSession(desktopPublicKeyB64: string): PairingSession {
  const desktopPub = b64urlDecode(desktopPublicKeyB64.trim())
  if (desktopPub.length !== 32) throw new Error('桌面公钥长度非法')
  const phonePrivate = x25519.utils.randomSecretKey()
  const phonePublic = x25519.getPublicKey(phonePrivate)
  const sharedSecret = x25519.getSharedSecret(phonePrivate, desktopPub)
  const sorted = [desktopPub, phonePublic].sort(compareBytes)
  const sessionKey = hkdf(
    sha256,
    sharedSecret,
    concatBytes(sorted[0], sorted[1]),
    HKDF_INFO,
    32
  )
  return {
    phonePublicKeyB64: b64urlEncode(phonePublic),
    sessionKeyB64: b64urlEncode(sessionKey)
  }
}
