import { createHash, createPublicKey, verify } from 'node:crypto'

/**
 * 中转身份鉴权（Ed25519）。
 *
 * 为什么共享密钥不够：
 * 共享密钥是"知道就能用"，一旦出现在聊天记录、git 历史、服务器配置里，
 * 拿到的人和你权限完全相同。要做到"只有我"，服务器只能持有**公钥**，
 * 进门时必须用**私钥签名**证明身份——私钥只在你本机的 safeStorage 里，
 * 服务器被看光也伪造不了。
 *
 * 流程（challenge-response，防重放）：
 *   1. 桌面 → { op:'register-desktop', pubKey }
 *   2. 中转 → { ok:true, data:{ challenge } }（32 字节随机，一次性）
 *   3. 桌面 → { op:'register-desktop', pubKey, challenge, signature }
 *            签名对象 "challenge|pubKey"，绑定挑战防重放、绑定公钥防换钥复用
 *   4. 中转 → 校验公钥在白名单内 且 签名正确 → 建/认领房间
 *
 * 只比对公钥不验签是无效的：公钥是公开信息，任何人都能抄。
 */

/** RFC 8410 Ed25519 SPKI 前缀（32 字节裸公钥前补此头即可重建 KeyObject）。 */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

/** base64url 编码的 32 字节裸公钥长度（无 padding）。 */
const RAW_PUBLIC_KEY_LEN = 43

/**
 * 指纹有两种书写形式，内部一律用 canonical（16 位无分隔 hex）比较：
 * - 展示形式 `A1B2-C3D4-E5F6-7890`（人类可读，与配对二维码指纹同格式）
 * - canonical `A1B2C3D4E5F67890`（白名单集合内部存储与比对用）
 * 混用是这里最容易出的错，所以只保留一个比较入口 canonicalFingerprint。
 */

function rawPublicKey(publicKeyB64) {
  const raw = Buffer.from(String(publicKeyB64 ?? ''), 'base64url')
  if (raw.length !== 32) throw new Error('ed25519 公钥必须为 32 字节')
  return raw
}

/** 公钥 → canonical 指纹（16 位无分隔大写 hex）。 */
export function canonicalFingerprint(publicKeyB64) {
  const hex = createHash('sha256').update(rawPublicKey(publicKeyB64)).digest('hex')
  return hex.slice(0, 16).toUpperCase()
}

/** 公钥 → 人类可读指纹（分组形式，给用户抄到服务器配置里）。 */
export function identityFingerprint(publicKeyB64) {
  const hex = canonicalFingerprint(publicKeyB64)
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}`
}

/**
 * 把用户填的任意形式（公钥 / 展示指纹 / 无分隔指纹）归一化成 canonical。
 * 无法识别返回 ''。
 */
export function canonicalize(value) {
  const item = String(value ?? '').trim()
  if (!item) return ''
  // 43 字符 base64url → 视为裸公钥
  if (item.length === RAW_PUBLIC_KEY_LEN && /^[A-Za-z0-9_-]+$/.test(item)) {
    try {
      return canonicalFingerprint(item)
    } catch {
      return ''
    }
  }
  const normalized = item.replace(/[-:\s]/g, '').toUpperCase()
  return /^[0-9A-F]{16}$/.test(normalized) ? normalized : ''
}

/** 兼容旧名：等同于 canonicalize。 */
export function fingerprintOfInput(value) {
  return canonicalize(value)
}

export function decodePublicKey(publicKeyB64) {
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, rawPublicKey(publicKeyB64)]),
    format: 'der',
    type: 'spki'
  })
}

/**
 * 校验签名。任何异常都返回 false（畸形公钥/签名不应让服务抛错退出）。
 */
export function verifyIdentitySignature(publicKeyB64, message, signatureB64) {
  try {
    const key = decodePublicKey(publicKeyB64)
    const signature = Buffer.from(String(signatureB64 ?? ''), 'base64url')
    if (signature.length !== 64) return false
    return verify(null, Buffer.from(String(message), 'utf8'), key, signature)
  } catch {
    return false
  }
}

/**
 * 解析 RELAY_ALLOWED_DESKTOPS：逗号分隔，每项可以是
 * - 展示指纹 `A1B2-C3D4-E5F6-7890` / 无分隔 `A1B2C3D4E5F67890`（大小写不敏感）
 * - base64url 裸公钥（43 字符）
 * 统一归一化成 canonical 指纹集合，书写格式差异不会误判。
 */
export function parseAllowedDesktops(raw) {
  const allowed = new Set()
  for (const part of String(raw ?? '').split(',')) {
    // 单项非法只忽略该项，不让一处手误把整份配置作废
    const canonical = canonicalize(part)
    if (canonical) allowed.add(canonical)
  }
  return allowed
}
