import log from 'electron-log/main'
import { getSecret, setSecret, deleteSecret } from '../secrets'
import { getSetting } from '../settings'
import { RemoteClient, type RemoteStatus } from './client'
import { deriveSessionKey, deriveSharedSecret, generateKeyPair, publicKeyFingerprint } from './crypto'
import { SessionCipher } from './crypto'
import { addPairedDevice, listPairedDevices, revokePairedDevice } from './devices'
import { appendRemoteAudit } from './audit'
import type { RemoteHandlerContext } from './handler'

/**
 * 阶段3：远程总控（单例）。
 * - 默认关闭：remote.enabled 为 false 时不创建任何连接。
 * - 密钥：桌面 X25519 长期密钥对存 secrets（remote.devicePrivate/remote.devicePublic）；
 *   每台手机的会话密钥存 secrets（remote.session.<deviceId>），safeStorage 加密。
 * - 配对二维码内容：JSON { relayUrl, code, desktopPub, fingerprint }。
 */

const K_DEVICE_PRIVATE = 'remote.devicePrivate'
const K_DEVICE_PUBLIC = 'remote.devicePublic'
const K_DEVICE_TOKEN = 'remote.deviceToken'
const SESSION_PREFIX = 'remote.session.'

export interface PairingInfo {
  /** 二维码内容（手机扫码）：中转地址 + 配对码 + 桌面公钥 + 指纹 */
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
    if (!this.client) {
      this.client = new RemoteClient({
        relayUrl: this.relayUrl(),
        deviceToken: getSecret(K_DEVICE_TOKEN),
        getSession: () => {
          if (!this.currentDeviceId) return null
          const cipher = this.sessions.get(this.currentDeviceId)
          if (!cipher) return null
          return { cipher, deviceId: this.currentDeviceId }
        },
        handlerContext: () => this.handlerContext(),
        onStatus: (s, d) => this.emit(s, d ?? '')
      })
    }
    this.client.setEnabled(true)
  }

  /** 申请配对：返回二维码内容。必须在线才能申请。 */
  async issuePairing(phoneName = ''): Promise<PairingInfo> {
    if (!this.client) throw new Error('远程功能未开启')
    const { code, expiresAt } = await this.client.issuePairingCode()
    const { publicRaw } = this.ensureDeviceKeys()
    const qrText = JSON.stringify({
      v: 1,
      relayUrl: this.relayUrl(),
      code,
      desktopPub: publicRaw.toString('base64url'),
      fingerprint: publicKeyFingerprint(publicRaw),
      name: phoneName
    })
    void code
    return { qrText, code, expiresAt, fingerprint: publicKeyFingerprint(publicRaw) }
  }

  /**
   * 配对完成（手机已提交配对码换到 phoneToken，中转会把手机的公钥经加密通道发回；
   * 第一版简化：手机在配对成功后首帧即为 { op:'pair-hello', phonePub }，
   * 由 client.onMessage 透传到这里完成 ECDH。）
   * 为保持阶段3最小可用，这里提供由桌面侧直接完成配对的接口：
   * 手机扫码后在同一加密通道内发送 phonePub，桌面据此派生会话密钥并落库设备。
   */
  completePairing(deviceName: string, phonePubB64: string): { deviceId: string; fingerprint: string } {
    const phonePub = Buffer.from(phonePubB64, 'base64url')
    if (phonePub.length !== 32) throw new Error('手机公钥非法')
    const privDer = this.loadDevicePrivateKey()
    if (!privDer) throw new Error('桌面密钥缺失')
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { createPrivateKey } = require('node:crypto') as typeof import('node:crypto')
    const privateKey = createPrivateKey({ key: privDer, format: 'der', type: 'pkcs8' })
    const { publicRaw } = this.ensureDeviceKeys()
    const shared = deriveSharedSecret(privateKey, phonePub)
    const sessionKey = deriveSessionKey(shared, publicRaw, phonePub)
    const device = addPairedDevice(deviceName, phonePubB64)
    setSecret(SESSION_PREFIX + device.id, sessionKey.toString('base64url'))
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
