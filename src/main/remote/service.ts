import log from 'electron-log/main'
import { getSecret, setSecret, deleteSecret } from '../secrets'
import { getSetting } from '../settings'
import { RemoteClient, type RemoteStatus } from './client'
import { deriveSessionKey, deriveSharedSecret, generateKeyPair, publicKeyFingerprint } from './crypto'
import { SessionCipher } from './crypto'
import {
  addPairedDevice,
  getPairedDevice,
  listPairedDevices,
  revokePairedDevice
} from './devices'
import { appendRemoteAudit } from './audit'
import type { RemoteHandlerContext } from './handler'
import { buildPairingUrl } from './pairing-url'
import { ensureIdentity, getIdentity, signChallenge } from './identity'

/**
 * 阶段3：远程总控（单例）。
 * - 默认关闭：remote.enabled 为 false 时不创建任何连接。
 * - 密钥：桌面 X25519 长期密钥对存 secrets（remote.devicePrivate/remote.devicePublic）；
 *   每台手机的会话密钥存 secrets（remote.session.<deviceId>），safeStorage 加密。
 * - 配对二维码内容：同源 HTTPS PWA 链接，附带中转地址、配对码和桌面公钥。
 */

const K_DEVICE_PRIVATE = 'remote.devicePrivate'
const K_DEVICE_PUBLIC = 'remote.devicePublic'
const K_DEVICE_TOKEN = 'remote.deviceToken'
const SESSION_PREFIX = 'remote.session.'
const PHONE_TOKEN_PREFIX = 'remote.phoneToken.'

export interface PairingInfo {
  /** 二维码内容（手机扫码）：可直接打开 PWA 的配对链接 */
  qrText: string
  code: string
  expiresAt: number
  fingerprint: string
}

type StatusListener = (status: RemoteStatus, detail?: string) => void

class RemoteService {
  private client: RemoteClient | null = null
  private status: RemoteStatus = 'off'
  private statusDetail = ''
  private listeners = new Set<StatusListener>()
  private currentDeviceId: string | null = null
  /** 多设备会话（deviceId -> cipher），当前仅支持单手机在线，多配对轮流用 */
  private sessions = new Map<string, SessionCipher>()

  getStatus(): { status: RemoteStatus; detail: string; enabled: boolean } {
    return { status: this.status, detail: this.statusDetail, enabled: this.isEnabled() }
  }

  onStatus(fn: StatusListener): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  private emit(status: RemoteStatus, detail = ''): void {
    this.status = status
    this.statusDetail = detail
    for (const fn of [...this.listeners]) {
      try {
        fn(status, detail)
      } catch {}
    }
  }

  isEnabled(): boolean {
    try {
      return getSetting<boolean>('remote.enabled', false)
    } catch {
      return false
    }
  }

  private relayUrl(): string {
    try {
      return getSetting<string>('remote.relayUrl', '').trim()
    } catch {
      return ''
    }
  }

  /** 中转准入密钥：与中转侧 RELAY_ACCESS_KEY 保持一致；空表示该中转不设准入。 */
  private accessKey(): string {
    try {
      return getSetting<string>('remote.accessKey', '').trim()
    } catch {
      return ''
    }
  }

  private handlerContext(): RemoteHandlerContext {
    let policy: RemoteHandlerContext['approvalPolicy'] = 'allow-all'
    try {
      const raw = getSetting<string>('remote.approvalPolicy', 'allow-all')
      if (raw === 'confirm-high' || raw === 'read-only') policy = raw
    } catch {}
    return { approvalPolicy: policy }
  }

  /** 确保桌面长期密钥对存在，返回 raw 公钥。 */
  ensureDeviceKeys(): { publicRaw: Buffer } {
    const existingPub = getSecret(K_DEVICE_PUBLIC)
    const existingPriv = getSecret(K_DEVICE_PRIVATE)
    if (existingPub && existingPriv) {
      return { publicRaw: Buffer.from(existingPub, 'base64url') }
    }
    const kp = generateKeyPair()
    // 私钥 KeyObject 导出 PKCS8 存 secrets
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createPrivateKey } = require('node:crypto') as typeof import('node:crypto')
    void createPrivateKey
    const privDer = kp.privateKey.export({ format: 'der', type: 'pkcs8' }) as Buffer
    setSecret(K_DEVICE_PRIVATE, privDer.toString('base64url'))
    setSecret(K_DEVICE_PUBLIC, kp.publicKey.toString('base64url'))
    return { publicRaw: kp.publicKey }
  }

  private loadDevicePrivateKey(): Buffer | null {
    const raw = getSecret(K_DEVICE_PRIVATE)
    return raw ? Buffer.from(raw, 'base64url') : null
  }

  /** 启动/停止（设置页开关、托盘一键断开调用）。 */
  sync(): void {
    const enabled = this.isEnabled()
    if (!enabled) {
      this.client?.disconnectAll('disabled')
      this.client = null
      this.emit('off')
      return
    }
    this.ensureDeviceKeys()
    // 身份密钥：中转白名单模式要用它证明"这台桌面就是我"，必须在连接前就绪。
    ensureIdentity()
    // 地址或准入密钥变了必须重建客户端：RemoteClient 在构造时读取这两个值，
    // 复用旧实例会让新填的准入密钥完全不生效（表现为一直 access denied）。
    const relayUrl = this.relayUrl()
    const accessKey = this.accessKey()
    if (this.client && (this.client.relayUrl() !== relayUrl || this.client.accessKey() !== accessKey)) {
      this.client.disconnectAll('config-changed')
      this.client = null
    }
    if (!this.client) {
      this.client = new RemoteClient({
        relayUrl,
        deviceToken: getSecret(K_DEVICE_TOKEN),
        accessKey,
        getIdentity: () => getIdentity(),
        signChallenge: (challenge, publicKeyB64) => signChallenge(challenge, publicKeyB64),
        getSession: () => {
          if (!this.currentDeviceId) return null
          const cipher = this.sessions.get(this.currentDeviceId)
          if (!cipher) return null
          return { cipher, deviceId: this.currentDeviceId }
        },
        handlerContext: () => this.handlerContext(),
        onStatus: (s, d) => this.emit(s, d ?? ''),
        onPairingHello: (hello) => {
          try {
            this.completePairing(hello.deviceName, hello.phonePub, hello.phoneToken)
            void this.client?.confirmPairing(hello.phoneToken).catch((error) => {
              log.warn('[remote] 配对确认发送失败', error)
            })
          } catch (error) {
            log.warn('[remote] 完成配对失败', error)
          }
        }
      })
    }
    this.client.setEnabled(true)
  }

  /** 申请配对：返回二维码内容。必须在线才能申请。 */
  async issuePairing(phoneName = ''): Promise<PairingInfo> {
    if (!this.client) throw new Error('远程功能未开启')
    const { code, expiresAt } = await this.client.issuePairingCode()
    const { publicRaw } = this.ensureDeviceKeys()
    const fingerprint = publicKeyFingerprint(publicRaw)
    const qrText = buildPairingUrl(
      this.relayUrl(),
      code,
      publicRaw.toString('base64url'),
      fingerprint,
      phoneName
    )
    return { qrText, code, expiresAt, fingerprint }
  }

  /**
   * 本机中转身份（公钥 + 指纹）。用户把指纹填到中转的 RELAY_ALLOWED_DESKTOPS，
   * 中转就只服务这一台桌面。公钥是公开信息，暴露给设置页展示没有风险。
   */
  getIdentityInfo(): { publicKeyB64: string; fingerprint: string } {
    return ensureIdentity()
  }

  /** 配对完成：手机经中转控制面提交 X25519 公钥，桌面派生会话密钥并落库。 */
  completePairing(
    deviceName: string,
    phonePubB64: string,
    phoneToken: string
  ): { deviceId: string; fingerprint: string } {
    const phonePub = Buffer.from(phonePubB64, 'base64url')
    if (phonePub.length !== 32) throw new Error('手机公钥非法')
    if (!phoneToken) throw new Error('手机令牌缺失')
    const privDer = this.loadDevicePrivateKey()
    if (!privDer) throw new Error('桌面密钥缺失')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createPrivateKey } = require('node:crypto') as typeof import('node:crypto')
    const privateKey = createPrivateKey({ key: privDer, format: 'der', type: 'pkcs8' })
    const { publicRaw } = this.ensureDeviceKeys()
    const shared = deriveSharedSecret(privateKey, phonePub)
    const sessionKey = deriveSessionKey(shared, publicRaw, phonePub)
    const tokenSecret = PHONE_TOKEN_PREFIX + phoneToken
    const existingDeviceId = getSecret(tokenSecret)
    const existingDevice = existingDeviceId ? getPairedDevice(existingDeviceId) : null
    let device: ReturnType<typeof addPairedDevice>
    if (existingDevice && !existingDevice.revokedAt) {
      device = existingDevice
    } else {
      if (existingDeviceId) deleteSecret(tokenSecret)
      device = addPairedDevice(deviceName, phonePubB64)
    }
    setSecret(SESSION_PREFIX + device.id, sessionKey.toString('base64url'))
    setSecret(SESSION_PREFIX + device.id + '.phoneToken', phoneToken)
    setSecret(tokenSecret, device.id)
    this.sessions.set(device.id, new SessionCipher(sessionKey))
    this.currentDeviceId = device.id
    appendRemoteAudit('remote.pair', `device=${device.name}`)
    return { deviceId: device.id, fingerprint: publicKeyFingerprint(phonePub) }
  }

  listDevices() {
    return listPairedDevices()
  }

  async revokeDevice(id: string): Promise<boolean> {
    const ok = revokePairedDevice(id)
    if (ok) {
      const token = getSecret(SESSION_PREFIX + id + '.phoneToken')
      if (token && this.client) {
        try {
          await this.client.revokePhone(token)
        } catch (error) {
          log.warn('[remote] 中转吊销失败（本地已吊销）', error)
        }
      }
      deleteSecret(SESSION_PREFIX + id)
      deleteSecret(SESSION_PREFIX + id + '.phoneToken')
      if (token) deleteSecret(PHONE_TOKEN_PREFIX + token)
      this.sessions.delete(id)
      if (this.currentDeviceId === id) this.currentDeviceId = null
      appendRemoteAudit('remote.revoke', `device=${id.slice(0, 8)}`)
    }
    return ok
  }

  /** 一键断开所有远程设备并关闭远程功能（阶段5.6）。 */
  disconnectAll(): void {
    this.client?.disconnectAll('manual-tray')
    this.client = null
    try {
      const { setSetting } = require('../settings') as typeof import('../settings')
      setSetting('remote.enabled', false)
    } catch {}
    this.emit('off', '已手动断开')
  }
}

export const remoteService = new RemoteService()
