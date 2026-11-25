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
/** 每设备发送序号持久化前缀：重启后恢复水位，防手机重发旧序号被判重放 */
const SEND_SEQ_PREFIX = 'remote.sendSeq.'

export interface PairingInfo {
  /** 二维码内容（手机扫码）：可直接打开 PWA 的配对链接 */
  qrText: string
  code: string
  expiresAt: number
  fingerprint: string
}

/** 桌面待确认的配对请求：手机扫码提交公钥后，需桌面人工确认才派生会话密钥。 */
export interface PendingPairing {
  deviceName: string
  phonePubB64: string
  phoneToken: string
  /** 手机公钥指纹：确认时与手机端显示核对，防止中间人。 */
  fingerprint: string
  receivedAt: number
}

/** 配对请求有效期：与一次性配对码一致，5 分钟，过期自动清理。 */
const PENDING_PAIRING_MS = 5 * 60 * 1000

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
          // 重启后内存会话丢失：在这里按需从 secrets 恢复，避免必须重新配对。
          this.ensureSessionLoaded()
          if (!this.currentDeviceId) return null
          const cipher = this.sessions.get(this.currentDeviceId)
          if (!cipher) return null
          return { cipher, deviceId: this.currentDeviceId }
        },
        handlerContext: () => this.handlerContext(),
        // 下行加密后把最新序号落 secrets：重启恢复水位，防手机端旧序号重放误判
        onSealedSeq: (deviceId, seq) => {
          try {
            setSecret(SEND_SEQ_PREFIX + deviceId, String(seq))
          } catch (error) {
            log.warn('[remote] 发送序号持久化失败', error)
          }
        },
        onStatus: (s, d) => this.emit(s, d ?? ''),
        onPairingHello: (hello) => {
          // 只暂存，需人工确认：设置页出现确认按钮前手机一直显示等待桌面确认。
          this.handlePairingHello(hello.deviceName, hello.phonePub, hello.phoneToken)
        }
      })
    }
    this.client.setEnabled(true)
  }

  /** 申请配对：返回二维码内容。必须在线才能申请。 */
  async issuePairing(phoneName = ''): Promise<PairingInfo> {
    if (!this.isEnabled()) throw new Error('远程功能未开启：请先打开「开启手机远程」开关')
    if (!this.client) {
      throw new Error(`中转未连接（${this.status}${this.statusDetail ? `：${this.statusDetail}` : ''}），请等状态变 online 后再点生成配对码`)
    }
    if (this.status !== 'online') {
      const d = this.statusDetail || ''
      const needKey =
        d.includes('准入') || d.includes('身份') || d.includes('指纹') || d.includes('access denied') || d.includes('not allowed') || d.includes('banned')
      const hint = needKey
        ? '：请核对「中转准入密钥」是否与中转 RELAY_ACCESS_KEY 一致，白名单模式请把本机指纹加入 RELAY_ALLOWED_DESKTOPS'
        : d ? `：${d}` : '：中转还没连上，稍等重连'
      throw new Error(`中转未连接（${this.status}${hint}），online 后再生成配对码`)
    }
    let code: string
    let expiresAt: number
    try {
      ;({ code, expiresAt } = await this.client.issuePairingCode())
    } catch (error) {
      const d = this.statusDetail ? `（当前 ${this.status}：${this.statusDetail}）` : `（当前 ${this.status}）`
      throw new Error(`${error instanceof Error ? error.message : String(error)}${d}`)
    }
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

  /** 重启后内存会话丢失：按最近配对设备从 secrets 恢复，会话不断必须重新配对。
   *  同时恢复每设备的发送序号水位：序号归零会让手机端新帧被判重放，
   *  连续解密失败触发 MAX_DECRYPT_FAILURES 封禁（手机刷新自封的另一半根因）。 */
  private ensureSessionLoaded(): void {
    if (this.currentDeviceId && this.sessions.has(this.currentDeviceId)) return
    try {
      const devices = listPairedDevices().filter((d) => !d.revokedAt)
      for (const d of devices) {
        if (this.sessions.has(d.id)) {
          if (!this.currentDeviceId) this.currentDeviceId = d.id
          continue
        }
        const keyB64 = getSecret(SESSION_PREFIX + d.id)
        if (!keyB64) continue
        try {
          const key = Buffer.from(keyB64, 'base64url')
          if (key.length !== 32) continue
          const cipher = new SessionCipher(key)
          // 恢复上次发送水位，不从 0 重发（重放误判源）
          const savedSeq = Number(getSecret(SEND_SEQ_PREFIX + d.id))
          if (Number.isInteger(savedSeq) && savedSeq > 0) cipher.setSendSeq(savedSeq)
          this.sessions.set(d.id, cipher)
          if (!this.currentDeviceId) this.currentDeviceId = d.id
        } catch (error) {
          // 单设备恢复失败不阻断其他设备，但留诊断线索
          log.warn(`[remote] 会话 ${d.id} 恢复失败`, error)
        }
      }
    } catch (error) {
      log.warn('[remote] 会话恢复异常', error)
    }
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

  /** 待确认配对（phoneToken -> 请求）：需用户在设置页点确认才完成握手。 */
  private pendingPairings = new Map<string, PendingPairing>()
  private pendingListeners = new Set<() => void>()

  /** 配对请求变化订阅（设置页轮询兜底 + 事件即时刷新）。 */
  onPendingChange(fn: () => void): () => void {
    this.pendingListeners.add(fn)
    return () => {
      this.pendingListeners.delete(fn)
    }
  }

  private emitPending(): void {
    for (const fn of [...this.pendingListeners]) {
      try {
        fn()
      } catch {}
    }
  }

  private sweepPending(): void {
    const now = Date.now()
    let changed = false
    for (const [token, p] of this.pendingPairings) {
      if (now - p.receivedAt > PENDING_PAIRING_MS) {
        this.pendingPairings.delete(token)
        changed = true
      }
    }
    if (changed) this.emitPending()
  }

  /** 待确认的配对请求列表（自动清理过期）。 */
  listPendingPairings(): PendingPairing[] {
    this.sweepPending()
    return [...this.pendingPairings.values()].sort((a, b) => a.receivedAt - b.receivedAt)
  }

  /**
   * 收到手机配对请求：只暂存需人工确认，不再自动派生密钥。
   * 同一 phoneToken 重复上报（手机重连）直接覆盖避免堆积。
   */
  handlePairingHello(deviceName: string, phonePubB64: string, phoneToken: string): void {
    try {
      const phonePub = Buffer.from(phonePubB64, 'base64url')
      if (phonePub.length !== 32) {
        log.warn('[remote] 配对请求公钥非法已忽略')
        return
      }
      if (!phoneToken) return
      this.pendingPairings.set(phoneToken, {
        deviceName: deviceName?.slice(0, 100) || '未命名手机',
        phonePubB64,
        phoneToken,
        fingerprint: publicKeyFingerprint(phonePub),
        receivedAt: Date.now()
      })
      this.sweepPending()
      this.emitPending()
      appendRemoteAudit('remote.pair', `pending device=${deviceName}`)
    } catch (error) {
      log.warn('[remote] 暂存配对请求失败', error)
    }
  }

  /** 人工确认配对：派生会话密钥并落库，通知中转放行手机。 */
  async confirmPendingPairing(phoneToken: string): Promise<{ deviceId: string; fingerprint: string }> {
    const p = this.pendingPairings.get(phoneToken)
    if (!p) throw new Error('配对请求已过期或不存在请手机重新扫码')
    const res = this.completePairing(p.deviceName, p.phonePubB64, p.phoneToken)
    this.pendingPairings.delete(phoneToken)
    this.emitPending()
    try {
      await this.client?.confirmPairing(phoneToken)
    } catch (error) {
      log.warn('[remote] 配对确认发送失败', error)
    }
    return res
  }

  /** 拒绝配对：丢弃请求并通知中转断开该手机。 */
  async denyPendingPairing(phoneToken: string): Promise<boolean> {
    const p = this.pendingPairings.get(phoneToken)
    if (!p) return false
    this.pendingPairings.delete(phoneToken)
    this.emitPending()
    appendRemoteAudit('remote.pair.deny', `deny device=${p.deviceName}`)
    try {
      await this.client?.revokePhone(phoneToken)
    } catch (error) {
      log.warn('[remote] 拒绝配对后吊销手机失败', error)
    }
    return true
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
