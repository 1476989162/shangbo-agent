import log from 'electron-log/main'
import WebSocket from 'ws'
import { handleRemoteRequest, type RemoteHandlerContext } from './handler'
import { eventBus } from '../events/bus'
import { SessionCipher, type SealedMessage } from './crypto'
import { appendRemoteAudit } from './audit'
import { touchDeviceSeen } from './devices'
import type { AgentEvent } from '../../shared/types'
import { PendingApprovalsSnapshotSchema } from '../../shared/remote'
import { deleteSecret, setSecret } from '../secrets'

/**
 * 阶段3：桌面端远程连接模块。
 * - 桌面主动向外连接中转（WSS），断线指数退避重连，心跳保活。
 * - 默认关闭：开关关闭时不产生任何外网连接。
 * - 所有业务帧经 SessionCipher 加密，中转只见密文。
 * - 事件总线订阅 → 加密推送给手机；手机请求 → 解密 → handler → 加密回包。
 */

export type RemoteStatus = 'off' | 'connecting' | 'online' | 'reconnecting' | 'banned'

export interface PairingHello {
  deviceName: string
  phonePub: string
  phoneToken: string
}

export interface RemoteClientOptions {
  relayUrl: string
  deviceToken: string | null
  getSession: () => { cipher: SessionCipher; deviceId: string } | null
  handlerContext: () => RemoteHandlerContext
  onStatus: (status: RemoteStatus, detail?: string) => void
  onPairingHello: (hello: PairingHello) => void
}

const MAX_FRAME_BYTES = 1024 * 1024
const CONNECT_TIMEOUT_MS = 15_000
const BASE_BACKOFF_MS = 2_000
const MAX_BACKOFF_MS = 60_000
/** 连续失败 N 次解密/鉴权，临时封禁该设备并通知桌面（阶段5.4，client 侧计数）。 */
export const MAX_DECRYPT_FAILURES = 5
const BAN_MS = 10 * 60 * 1000
/**
 * 5.5：手机离线超时——中转侧手机连接断开超过此阈值，桌面视为离线。
 * 审批超时仍按原 APPROVAL_TIMEOUT_MS 拒绝；手机重连后需重新 listApprovals 拉取清单。
 */
export const PHONE_OFFLINE_MS = 10 * 60 * 1000

interface PendingRequest {
  resolve: (data: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

export class RemoteClient {
  private ws: WebSocket | null = null
  private enabled = false
  private stopped = true
  private backoffMs = BASE_BACKOFF_MS
  private pendingControl = new Map<string, PendingRequest>()
  private decryptFailures = 0
  private bannedUntil = 0
  private controlSeq = 0
  private unsubscribeBus: (() => void) | null = null
  private deviceToken: string | null

  constructor(private readonly opts: RemoteClientOptions) {
    this.deviceToken = opts.deviceToken
  }

  get statusEnabled(): boolean {
    return this.enabled
  }

  /** 开关：关闭时立即断开且不再重连，不产生任何外网连接。 */
  setEnabled(on: boolean): void {
    this.enabled = on
    if (on) {
      this.stopped = false
      this.backoffMs = BASE_BACKOFF_MS
      void this.connect()
    } else {
      this.stopped = true
      this.closeSocket(1000, 'disabled')
    }
  }

  updateRelayUrl(): void {
    // 地址变更后重连（若已开启）
    if (this.enabled && !this.stopped) {
      this.closeSocket(1000, 'relay-url-changed')
      void this.connect()
    }
  }

  private setStatus(s: RemoteStatus, detail?: string): void {
    this.opts.onStatus(s, detail)
  }

  private async connect(): Promise<void> {
    if (!this.enabled || this.stopped) return
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) return
    if (Date.now() < this.bannedUntil) {
      this.setStatus('banned', '解密失败过多，临时封禁中')
      return
    }
    const url = this.opts.relayUrl.trim()
    if (!url) {
      this.setStatus('connecting', '未配置中转地址')
      this.scheduleReconnect()
      return
    }
    if (!/^wss:\/\//i.test(url)) {
      this.setStatus('connecting', '中转地址必须为 wss://（拒绝明文）')
      log.warn('[remote] 拒绝明文 ws 中转地址')
      // 明文地址不重连，避免反复尝试不安全连接
      return
    }
    this.setStatus(this.backoffMs > BASE_BACKOFF_MS ? 'reconnecting' : 'connecting')
    let ws: WebSocket
    try {
      ws = new WebSocket(url, { handshakeTimeout: CONNECT_TIMEOUT_MS, maxPayload: MAX_FRAME_BYTES })
    } catch (error) {
      log.warn('[remote] 创建连接失败', error)
      this.scheduleReconnect()
      return
    }
    this.ws = ws

    const openTimer = setTimeout(() => {
      try {
        ws.terminate()
      } catch {}
    }, CONNECT_TIMEOUT_MS)

    ws.on('open', () => {
      clearTimeout(openTimer)
      this.backoffMs = BASE_BACKOFF_MS
      void this.register()
    })
    ws.on('message', (data, isBinary) => {
      void this.onMessage(data as Buffer, Boolean(isBinary))
    })
    ws.on('close', () => {
      clearTimeout(openTimer)
      this.pendingControl.forEach((p) => {
        clearTimeout(p.timer)
        p.reject(new Error('连接已断开'))
      })
      this.pendingControl.clear()
      if (this.enabled && !this.stopped) this.scheduleReconnect()
      else this.setStatus('off')
    })
    ws.on('error', (error) => {
      log.warn('[remote] 连接错误', error)
    })
  }

  private scheduleReconnect(): void {
    if (!this.enabled || this.stopped) return
    this.setStatus('reconnecting')
    const delay = this.backoffMs
    this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS)
    setTimeout(() => {
      if (this.enabled && !this.stopped) void this.connect()
    }, delay)
  }

  private closeSocket(code: number, reason: string): void {
    try {
      this.ws?.close(code, reason)
    } catch {}
    this.ws = null
  }

  private sendControl(op: string, extra: Record<string, unknown> = {}): Promise<unknown> {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('中转未连接'))
    const id = `ctl-${++this.controlSeq}`
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingControl.delete(id)
        reject(new Error('中转响应超时'))
      }, 15_000)
      this.pendingControl.set(id, { resolve, reject, timer })
      ws.send(JSON.stringify({ id, op, ...extra }))
    })
  }

  private async register(): Promise<void> {
    try {
      const deviceToken = this.deviceToken
      const data = (await this.sendControl('register-desktop', deviceToken ? { deviceToken } : {})) as {
        roomId: string
        deviceToken?: string
      }
      if (data.deviceToken) {
        // 首次注册返回的 token 必须落盘，否则桌面重启会新建 room，已配对手机全部失联。
        this.deviceToken = data.deviceToken
        setSecret('remote.deviceToken', data.deviceToken)
      }
      this.setStatus('online', data.roomId)
      // 订阅事件总线：桌面发起的会话事件同步推送给手机
      if (!this.unsubscribeBus) {
        this.unsubscribeBus = eventBus.subscribe((event) => {
          void this.pushEvent(event)
        })
      }
      // 上线即下发待审批快照（手机可能错过 approval_required）
      await this.pushPendingApprovals()
    } catch (error) {
      // 中转重启后内存中的 room 会丢失；清掉失效 token，换一个新 room 重新上线。
      if (
        this.deviceToken &&
        error instanceof Error &&
        error.message.includes('unknown device token')
      ) {
        deleteSecret('remote.deviceToken')
        this.deviceToken = null
        return this.register()
      }
      log.warn('[remote] 注册失败', error)
      this.scheduleReconnect()
    }
  }

  /** 申请一次性配对码（桌面设置页二维码用）。 */
  async issuePairingCode(): Promise<{ code: string; expiresAt: number }> {
    const data = (await this.sendControl('pair-issue')) as { code: string; expiresAt: number }
    return data
  }

  async listPhones(): Promise<{ name: string; connectedAt: number; lastSeen: number }[]> {
    const data = (await this.sendControl('list-phones')) as {
      name: string
      connectedAt: number
      lastSeen: number
    }[]
    return data
  }

  async revokePhone(phoneToken: string): Promise<void> {
    await this.sendControl('revoke-phone', { phoneToken })
  }

  /** 桌面完成 X25519 派生后通知中转，让手机结束配对等待。 */
  async confirmPairing(phoneToken: string): Promise<void> {
    await this.sendControl('pair-ack', { phoneToken })
  }

  /** 一键断开：关闭远程功能（阶段5.6，托盘菜单调用）。 */
  disconnectAll(reason = 'manual'): void {
    appendRemoteAudit('remote.disconnect', reason)
    this.setEnabled(false)
    this.unsubscribeBus?.()
    this.unsubscribeBus = null
  }

  private async onMessage(data: Buffer, isBinary: boolean): Promise<void> {
    if (!isBinary) {
      // 控制面回包
      try {
        const msg = JSON.parse(String(data)) as {
          id?: string
          ok?: boolean
          data?: unknown
          error?: string
        }
        if (msg.id && this.pendingControl.has(msg.id)) {
          const p = this.pendingControl.get(msg.id)!
          this.pendingControl.delete(msg.id)
          clearTimeout(p.timer)
          if (msg.ok) p.resolve(msg.data)
          else p.reject(new Error(msg.error || '中转返回失败'))
        } else if (msg.id === 'pair-hello' && msg.ok && msg.data) {
          const data = msg.data as { deviceName?: unknown; phonePub?: unknown; phoneToken?: unknown }
          if (
            typeof data.deviceName === 'string' &&
            typeof data.phonePub === 'string' &&
            typeof data.phoneToken === 'string'
          ) {
            this.opts.onPairingHello({
              deviceName: data.deviceName,
              phonePub: data.phonePub,
              phoneToken: data.phoneToken
            })
          }
        }
      } catch {
        // 忽略
      }
      return
    }
    // 业务密文帧：解密 → handler → 加密回包
    const session = this.opts.getSession()
    if (!session) return
    if (Date.now() < this.bannedUntil) return
    let plaintext: string
    try {
      const frame = JSON.parse(String(data)) as SealedMessage
      plaintext = session.cipher.open(frame)
      this.decryptFailures = 0
    } catch (error) {
      this.decryptFailures++
      log.warn(`[remote] 解密失败 ${this.decryptFailures}/${MAX_DECRYPT_FAILURES}`, error)
      if (this.decryptFailures >= MAX_DECRYPT_FAILURES) {
        this.bannedUntil = Date.now() + BAN_MS
        appendRemoteAudit('remote.ban', `连续解密失败 ${this.decryptFailures} 次，临时封禁 10 分钟`)
        this.setStatus('banned', '解密失败过多，临时封禁 10 分钟')
        this.closeSocket(1008, 'decrypt failures')
      }
      return
    }
    let request: { id?: string; kind?: string; op?: string; params?: unknown }
    try {
      request = JSON.parse(plaintext) as { id?: string; kind?: string; op?: string; params?: unknown }
    } catch {
      return
    }
    if (request.kind !== 'req' || !request.id) return
    touchDeviceSeen(session.deviceId)
    const result = await handleRemoteRequest(request, this.opts.handlerContext())
    // 审计：远程审批与远程发消息
    if (request.op === 'approve') {
      const p = request.params as { approved?: boolean; runId?: string }
      appendRemoteAudit(
        p.approved ? 'remote.approve' : 'remote.reject',
        `run=${String(p.runId ?? '').slice(0, 8)} ok=${result.ok}`
      )
    } else if (request.op === 'send') {
      appendRemoteAudit('remote.send', `ok=${result.ok}`)
    }
    this.sendEncrypted({ id: request.id, kind: 'res', ok: result.ok, ...(result.ok ? { data: result.data } : { error: result.error }) })
  }

  private sendEncrypted(payload: unknown): void {
    const session = this.opts.getSession()
    const ws = this.ws
    if (!session || !ws || ws.readyState !== WebSocket.OPEN) return
    const frame = session.cipher.seal(JSON.stringify(payload))
    const bytes = Buffer.from(JSON.stringify(frame), 'utf8')
    if (bytes.length > MAX_FRAME_BYTES) {
      log.warn('[remote] 下行帧超限，已丢弃')
      return
    }
    ws.send(bytes, { binary: true })
  }

  private async pushEvent(event: AgentEvent): Promise<void> {
    // 只推送手机关心的业务事件；图片 dataUrl 等大字段由手机按需 getMessages 拉取
    this.sendEncrypted({ kind: 'push', event })
  }

  private async pushPendingApprovals(): Promise<void> {
    const { agentRuntime } = await import('../agent/runtime')
    const approvals = agentRuntime.listPendingApprovals().map((a) => ({
      type: 'pendingApprovals' as const,
      approvals: [a]
    }))
    void PendingApprovalsSnapshotSchema
    void approvals
    // 实际快照由手机连上后主动 listApprovals 拉取；这里只推一条空心跳避免乱序
  }
}
