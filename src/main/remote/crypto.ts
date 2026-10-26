import { createHash, randomBytes, timingSafeEqual, type KeyObject } from 'node:crypto'
import { box, randomBytes as randomBytesNacl } from './nacl'
import { canonicalParamString } from '../../shared/remote'

/**
 * 阶段3：端到端加密（X25519 + XChaCha20-Poly1305，自实现 X25519 握手 + NaCl 密文）。
 * - 配对时桌面与手机做密钥交换（X25519 ECDH），之后所有负载用 XChaCha20-Poly1305 加密。
 * - 中转只转发密文，看不到内容。
 * - 每条消息带递增序号（nonce 的一部分），拒绝重放。
 *
 * 说明：Node 18+ 的 crypto 支持 x25519（diffieHellman）与 chacha20-poly1305（AEAD）。
 * 这里用 ECDH 得出共享密钥后经 HKDF 派生会话密钥；手机端用 WebCrypto
 *（同样支持 X25519 + XChaCha20-Poly1305，经 libsodium.js 或原生实现）对应实现。
 */

const INFO = 'shangbo-remote-v1'

export interface KeyPair {
  publicKey: Buffer
  privateKey: KeyObject
}

export function generateKeyPair(): KeyPair {
  // Node 的 X25519 私钥必须是 KeyObject；公钥导出 raw 32 字节
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { generateKeyPairSync, createPublicKey } = require('node:crypto') as typeof import('node:crypto')
  const { privateKey } = generateKeyPairSync('x25519')
  const publicKey = createPublicKey(privateKey).export({ format: 'der', type: 'spki' })
  // SPKI DER 最后 32 字节即 raw 公钥
  const raw = publicKey.subarray(publicKey.length - 32)
  return { publicKey: Buffer.from(raw), privateKey }
}

export function deriveSharedSecret(privateKey: KeyObject, peerPublicRaw: Buffer): Buffer {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { diffieHellman, createPublicKey } = require('node:crypto') as typeof import('node:crypto')
  // 由 raw 32 字节重建 SPKI DER：RFC 8410 前缀 + 公钥
  const SPKI_PREFIX = Buffer.from('302a300506032b656e032100', 'hex')
  const peerKey = createPublicKey({
    key: Buffer.concat([SPKI_PREFIX, peerPublicRaw]),
    format: 'der',
    type: 'spki'
  })
  return diffieHellman({ privateKey, publicKey: peerKey }) as Buffer
}

/** HKDF-SHA256 派生 32 字节会话密钥（salt=双方公钥排序拼接，info 固定）。 */
export function deriveSessionKey(sharedSecret: Buffer, localPub: Buffer, peerPub: Buffer): Buffer {
  const sorted = [localPub, peerPub].sort(Buffer.compare)
  const salt = Buffer.concat(sorted)
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { hkdfSync } = require('node:crypto') as typeof import('node:crypto')
  return Buffer.from(hkdfSync('sha256', sharedSecret, salt, INFO, 32))
}

export interface SealedMessage {
  /** 发送方序号（单调递增，防重放） */
  seq: number
  /** base64url(nonce 24B) + base64url(ciphertext) */
  nonce: string
  data: string
}

/**
 * 会话加密器：每端独立维护发送序号与接收水位。
 * - seal：明文 JSON -> 密文帧（nonce = 12B 随机前缀 + 12B seq 大端，保证唯一）
 * - open：校验 seq > 已见水位，否则按重放拒绝；篡改由 Poly1305 tag 拒绝
 */
export class SessionCipher {
  private sendSeq = 0
  private recvHigh = -1
  /** 已见序号窗口（防乱序重放，窗口 1024） */
  private seen = new Set<number>()

  constructor(private readonly key: Buffer) {
    if (key.length !== 32) throw new Error('会话密钥必须为 32 字节')
  }

  seal(plaintext: string): SealedMessage {
    const seq = this.sendSeq++
    if (seq > 0xffffffff) throw new Error('序号耗尽，请重新配对')
    const nonce = Buffer.concat([randomBytes(12), seqToBytes(seq)])
    const ciphertext = box.seal(Buffer.from(plaintext, 'utf8'), nonce, this.key)
    return { seq, nonce: nonce.toString('base64url'), data: ciphertext.toString('base64url') }
  }

  open(frame: SealedMessage): string {
    if (!Number.isInteger(frame.seq) || frame.seq < 0) throw new Error('非法序号')
    if (frame.seq <= this.recvHigh - 1024 || this.seen.has(frame.seq)) {
      throw new Error('重放消息，已拒绝')
    }
    const nonce = Buffer.from(frame.nonce, 'base64url')
    const ciphertext = Buffer.from(frame.data, 'base64url')
    if (nonce.length !== 24) throw new Error('非法 nonce')
    const seqBytes = seqToBytes(frame.seq)
    if (!timingSafeEqual(nonce.subarray(12), seqBytes)) throw new Error('序号与 nonce 不一致')
    const plaintext = box.open(ciphertext, nonce, this.key)
    if (!plaintext) throw new Error('解密失败（篡改或密钥错误）')
    this.seen.add(frame.seq)
    // 滑动窗口：清理远落后水位的记录
    if (frame.seq > this.recvHigh) {
      this.recvHigh = frame.seq
      for (const s of [...this.seen]) {
        if (s <= this.recvHigh - 1024) this.seen.delete(s)
      }
    }
    return plaintext.toString('utf8')
  }

  /** 导出当前序号（持久化重连后继续，避免序号回绕导致误判重放）。 */
  getSendSeq(): number {
    return this.sendSeq
  }

  setSendSeq(seq: number): void {
    this.sendSeq = seq
  }
}

function seqToBytes(seq: number): Buffer {
  const buf = Buffer.alloc(12)
  buf.writeUInt32BE(Math.floor(seq / 0x100000000), 0)
  buf.writeUInt32BE(seq >>> 0, 4)
  return buf
}

/** 工具：对 input 算 paramHash（与 runtime.paramHashOf 同算法，供单测交叉验证）。 */
export function paramHashOf(input: unknown): string {
  return createHash('sha256').update(canonicalParamString(input), 'utf8').digest('hex')
}

/** 公钥指纹（配对二维码展示用，防中间人）：SHA-256 前 16 hex 字符分组。 */
export function publicKeyFingerprint(publicKey: Buffer): string {
  const hex = createHash('sha256').update(publicKey).digest('hex').slice(0, 16).toUpperCase()
  return `${hex.slice(0, 4)}-${hex.slice(4, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}`
}

export { randomBytesNacl }
