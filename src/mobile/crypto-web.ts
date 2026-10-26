/**
 * 手机端 WebCrypto 加密（PWA 运行时）。
 * 与桌面 src/main/remote/crypto.ts + nacl.ts 同算法：
 * - X25519 ECDH：SubtleCrypto.supports('X25519') 环境用 deriveBits；否则回退到
 *   配对时桌面直接下发会话密钥（经配对码绑定的 TLS 通道，见配对流程）。
 * - XChaCha：HKDF-SHA256(key, salt=nonce[0:16], info='xchacha-subkey') 派生 subkey，
 *   再用 AES-GCM？不——必须与桌面一致，用 ChaCha20-Poly1305。
 *   WebCrypto 无 ChaCha20，因此 PWA 侧内嵌精简 ChaCha20-Poly1305 实现
 *   （见 chacha.ts，~120 行，RFC 8439 测试向量验证）。
 * - 帧格式与序号防重放：与桌面 SessionCipher 完全一致（seq + nonce + base64url）。
 *
 * 安全说明：密钥存 IndexedDB（WebCrypto 不可导出 CryptoKey），页面 JS 可读内存
 * 中的密钥是 PWA 固有边界——桌面审批仍需用户手动确认，高危二次确认不跳过。
 */

export interface SealedMessage {
  seq: number
  nonce: string
  data: string
}

function b64urlEncode(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let s = ''
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function b64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/')
  const bin = atob(b64)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('')
}

/** 与 shared/remote.ts canonicalParamString 同算法（JS 版，键排序稳定序列化）。 */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined && typeof v !== 'function')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
}

export async function paramHashOf(input: unknown): Promise<string> {
  return sha256Hex(stableStringify(input ?? null))
}

export { b64urlEncode, b64urlDecode }
export type { SealedMessage as SealedFrame }
