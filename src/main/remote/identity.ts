import { createHash, type KeyObject } from 'node:crypto'
import log from 'electron-log/main'
import { getSecret, setSecret } from '../secrets'

/**
 * 中转身份密钥（Ed25519）：证明"这台桌面就是我"，让中转可以只服务我。
 *
 * 与 remote.devicePrivate 的区别：
 * - devicePrivate 是 X25519，用于与手机做 ECDH 派生会话密钥（端到端加密）。
 * - 这里的身份私钥是 Ed25519，只用于向**中转**证明身份，不参与消息加密。
 *
 * 私钥存在 secrets（safeStorage 加密），公钥是公开信息，可以随便贴到服务器配置里。
 * 中转只持有公钥，因此服务器即使被看光也无法伪造签名冒充你。
 */

const K_IDENTITY_PRIVATE = 'remote.identityPrivate'
const K_IDENTITY_PUBLIC = 'remote.identityPublic'

const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

export interface Identity {
  /** base64url 裸 32 字节公钥 */
  publicKeyB64: string
  /** 人类可读指纹（与配对二维码指纹同格式），用于填服务器白名单时核对 */
  fingerprint: string
}

export function identityFingerprint(publicKeyB64: string): string {
  const raw = Buffer.from(publicKeyB64, 'base64url')
  const hex = createHash('sha256').update(raw).digest('hex').slice(0, 16).toUpperCase()
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}`
}

function publicKeyFromRaw(raw: Buffer): KeyObject {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createPublicKey } = require('node:crypto') as typeof import('node:crypto')
  return createPublicKey({
    key: Buffer.concat([ED25519_SPKI_PREFIX, raw]),
    format: 'der',
    type: 'spki'
  })
}

/** 确保身份密钥对存在（首次调用时生成并落库），返回公钥与指纹。 */
export function ensureIdentity(): Identity {
  const existingPub = getSecret(K_IDENTITY_PUBLIC)
  const existingPriv = getSecret(K_IDENTITY_PRIVATE)
  if (existingPub && existingPriv) {
    return { publicKeyB64: existingPub, fingerprint: identityFingerprint(existingPub) }
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { generateKeyPairSync, createPublicKey } = require('node:crypto') as typeof import('node:crypto')
  const { privateKey } = generateKeyPairSync('ed25519')
  // 公钥从私钥导出：Ed25519 SPKI DER 最后 32 字节即裸公钥
  const pubSpki = createPublicKey(privateKey).export({ format: 'der', type: 'spki' }) as Buffer
  const raw = pubSpki.subarray(pubSpki.length - 32)
  const privDer = privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer
  const pubB64 = Buffer.from(raw).toString('base64url')
  setSecret(K_IDENTITY_PRIVATE, privDer.toString('base64url'))
  setSecret(K_IDENTITY_PUBLIC, pubB64)
  log.info(`[remote] 已生成中转身份密钥，指纹 ${identityFingerprint(pubB64)}`)
  return { publicKeyB64: pubB64, fingerprint: identityFingerprint(pubB64) }
}

/** 读取已存在的身份，不存在返回 null（不触发生成）。 */
export function getIdentity(): Identity | null {
  const pub = getSecret(K_IDENTITY_PUBLIC)
  if (!pub) return null
  return { publicKeyB64: pub, fingerprint: identityFingerprint(pub) }
}

/**
 * 对中转挑战签名。签名对象固定为 `${challenge}|${publicKeyB64}`，
 * 与中转侧 identityMessage 保持一致——绑定挑战可防重放，绑定公钥可防换钥复用。
 */
export function signChallenge(challenge: string, publicKeyB64: string): string {
  const privB64 = getSecret(K_IDENTITY_PRIVATE)
  if (!privB64) throw new Error('身份私钥缺失')
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { createPrivateKey } = require('node:crypto') as typeof import('node:crypto')
  const privateKey = createPrivateKey({
    key: Buffer.from(privB64, 'base64url'),
    format: 'der',
    type: 'pkcs8'
  })
  // 先用公钥自检：私钥/公钥不成对时能立刻发现，而不是等到中转拒绝
  void publicKeyFromRaw(Buffer.from(publicKeyB64, 'base64url'))
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { sign } = require('node:crypto') as typeof import('node:crypto')
  const signature = sign(null, Buffer.from(`${challenge}|${publicKeyB64}`, 'utf8'), privateKey)
  return signature.toString('base64url')
}
