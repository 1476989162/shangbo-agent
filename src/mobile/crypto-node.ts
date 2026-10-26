import { createHash } from 'node:crypto'
import { canonicalParamString } from '@shared/remote'

/**
 * 手机端加密（Node 可测版本，与桌面 crypto.ts 同算法）。
 * 浏览器实装用 WebCrypto：X25519（SubtleCrypto deriveBits）+ 自实现 XChaCha
 *（与桌面 nacl.ts 同款 HKDF 派生 + ChaCha20-Poly1305；见 mobile/crypto-web.ts 注释）。
 * 这里提供 Node 版供单测交叉验证：同 input → 同 paramHash，同密钥 → 互解密。
 */

export function paramHashOf(input: unknown): string {
  return createHash('sha256').update(canonicalParamString(input), 'utf8').digest('hex')
}
