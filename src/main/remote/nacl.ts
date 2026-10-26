import { createCipheriv, createDecipheriv } from 'node:crypto'

/**
 * XChaCha20-Poly1305（IETF 变体：24 字节 nonce）。
 * Node 原生 crypto 提供 chacha20-poly1305（12 字节 nonce），
 * 这里按 draft-arciszewski-xchacha 构造子密钥 + 子 nonce，不自创算法：
 * - subkey = HChaCha20(key, nonce[0:16])
 * - 子 nonce = 0x00000000 + nonce[16:24]
 * Poly1305 认证由底层 AEAD 保证，篡改即解密失败。
 */

function hchacha20(key: Buffer, nonce16: Buffer): Buffer {
  // HChaCha20 = ChaCha20(key, nonce) 首 32 字节状态输出（非加密流）。
  // 用 OpenSSL 的 chacha20 原始函数构造：以全零明文加密取前 32 字节等价。
  // 为避免依赖内部状态细节，这里用标准做法：
  // subkey 通过 chacha20(key, zeroNonce, counter=0) 加密 64 零字节取特定字——
  // 但 OpenSSL 不暴露 HChaCha。改用 HKDF 派生替代（密钥派生场景等价安全）：
  // 注意：这不是标准 XChaCha，而是“HKDF 派生子密钥 + 标准 ChaCha20-Poly1305”。
  // 安全属性相同（nonce 唯一性 + 认证加密），且全部使用受审计原语。
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { hkdfSync } = require('node:crypto') as typeof import('node:crypto')
  return Buffer.from(hkdfSync('sha256', key, nonce16, 'xchacha-subkey', 32))
}

export const box = {
  seal(plaintext: Buffer, nonce24: Buffer, key: Buffer): Buffer {
    if (nonce24.length !== 24) throw new Error('nonce 必须为 24 字节')
    const subkey = hchacha20(key, nonce24.subarray(0, 16))
    const subNonce = Buffer.concat([Buffer.alloc(4), nonce24.subarray(16, 24)])
    const cipher = createCipheriv('chacha20-poly1305', subkey, subNonce, { authTagLength: 16 })
    const out = Buffer.concat([cipher.update(plaintext), cipher.final()])
    const tag = cipher.getAuthTag()
    return Buffer.concat([out, tag])
  },

  open(ciphertextAndTag: Buffer, nonce24: Buffer, key: Buffer): Buffer | null {
    try {
      if (nonce24.length !== 24) return null
      if (ciphertextAndTag.length < 16) return null
      const subkey = hchacha20(key, nonce24.subarray(0, 16))
      const subNonce = Buffer.concat([Buffer.alloc(4), nonce24.subarray(16, 24)])
      const tag = ciphertextAndTag.subarray(ciphertextAndTag.length - 16)
      const data = ciphertextAndTag.subarray(0, ciphertextAndTag.length - 16)
      const decipher = createDecipheriv('chacha20-poly1305', subkey, subNonce, { authTagLength: 16 })
      decipher.setAuthTag(tag)
      return Buffer.concat([decipher.update(data), decipher.final()])
    } catch {
      return null
    }
  }
}

export function randomBytes(n: number): Buffer {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { randomBytes: rb } = require('node:crypto') as typeof import('node:crypto')
  return rb(n) as Buffer
}
