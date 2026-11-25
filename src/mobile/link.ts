/**
 * 手机端连接层（PWA 运行时，不进 Electron 打包）。
 * - WSS 连中转（只接受 wss://，拒绝明文）
 * - 控制面 JSON：join-phone / pair-redeem
 * - 业务面二进制密文：请求 {id,kind:'req'} → 响应 {id,kind:'res'}；推送 {kind:'push'}
 * - 断线指数退避重连；密钥存 IndexedDB（不可导出 CryptoKey 存 raw 会话密钥，
 *   第一版存 raw 32B，二期再迁不可导出 X25519 私钥）。
 */

import { b64urlDecode, b64urlEncode, paramHashOf, type SealedMessage } from './crypto-web'
import { buildNonce24, checkNonceSeq, openXChaCha, sealXChaCha } from './chacha'

export interface MobileCredentials {
  relayUrl: string
  phoneToken: string
  sessionKeyB64: string
  deviceName: string
  phonePubB64: string
}

export interface RemoteRequest {
  id: string
  kind: 'req'
  op: string
  params: unknown
}

const MAX_FRAME_BYTES = 1024 * 1024
const BASE_BACKOFF_MS = 2000
const MAX_BACKOFF_MS = 60000

/** sendSeq 按 phoneToken 持久化（localStorage）：
 *  刷新/重启后序号归零，桌面 SessionCipher 会把新帧判成重放并累计
 *  解密失败，5 次即触发 MAX_DECRYPT_FAILURES 封禁 10 分钟——这是手机刷新自封的根因。
 *  持久化后序号单调递增，重连继续从上次水位往上发。 */
const SEQ_STORAGE_PREFIX = 'shangbo.remote.sendSeq.'

function loadStoredSeq(phoneToken: string): number {
  try {
    const raw = window.localStorage.getItem(SEQ_STORAGE_PREFIX + phoneToken)
    const n = typeof raw === 'string' ? Number(raw) : NaN
    return Number.isInteger(n) && n >= 0 ? n : 0
  } catch {
    return 0
  }
}

function storeSeq(phoneToken: string, seq: number): void {
  try {
    window.localStorage.setItem(SEQ_STORAGE_PREFIX + phoneToken, String(seq))
  } catch {
    // localStorage 不可用（隐私模式等）：不阻断发送，只是失去跨刷新持久性
    console.warn('[link] sendSeq 持久化失败，刷新后需重新配对或等待桌面解封')
  }
}

export class MobileLink {
  private ws: WebSocket | null = null
  private cipherKey: Uint8Array | null = null
  private sendSeq = 0
  private recvSeen = new Set<number>()
  private recvHigh = -1
  private backoffMs = BASE_BACKOFF_MS
  private stopped = false
  private pending = new Map<
    string,
    { resolve: (data: unknown) => void; reject: (e: Error) => void; timer: number }
  >()
  private reqSeq = 0
  private pairAcknowledged = false
  /** 重连退避定时器：disconnect 时必须清掉，防「已断开却还在重连」 */
  private reconnectTimer: number | null = null

  /** 配对是否已获桌面确认：App 用它决定显示已配对还是等待确认。 */
  wasPairAcknowledged(): boolean {
    return this.pairAcknowledged
  }
  private joinWaiter: {
    resolve: () => void
    reject: (error: Error) => void
    timer: number
  } | null = null

  onPush: ((event: unknown) => void) | null = null
  onStatus: ((status: string, detail?: string) => void) | null = null

  constructor(
    private readonly creds: MobileCredentials,
    private announcePairing = false
  ) {}

  async connect(): Promise<void> {
    const raw = await b64urlDecodeAsync(this.creds.sessionKeyB64)
    this.cipherKey = raw
    this.stopped = false
    // 恢复持久化的发送序号：不从 0 重发，避免桌面判重放/解密失败自封
    this.sendSeq = loadStoredSeq(this.creds.phoneToken)
    const ready = new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.joinWaiter = null
        reject(new Error('连接超时'))
      }, 15_000)
      this.joinWaiter = { resolve, reject, timer }
    })
    this.loop()
    return ready
  }

  disconnect(): void {
    this.stopped = true
    // 清掉还在排队的重连定时器：否则 disconnect 后 setTimeout 仍会拉起新连接
    if (this.reconnectTimer !== null) {
      window.clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    // join 等待者一并终结，调用方不至于挂到超时
    if (this.joinWaiter) {
      clearTimeout(this.joinWaiter.timer)
      this.joinWaiter.reject(new Error('已手动断开'))
      this.joinWaiter = null
    }
    try {
      this.ws?.close()
    } catch {}
    this.ws = null
  }

  private setStatus(s: string, d?: string): void {
    try {
      this.onStatus?.(s, d)
    } catch {}
  }

  private loop(): void {
    if (this.stopped) return
    const url = this.creds.relayUrl.trim()
    if (!/^wss:\/\//i.test(url)) {
      this.setStatus('error', '中转地址必须为 wss://')
      return
    }
    this.setStatus(this.backoffMs > BASE_BACKOFF_MS ? 'reconnecting' : 'connecting')
    const ws = new WebSocket(url)
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    ws.onopen = () => {
      this.backoffMs = BASE_BACKOFF_MS
      ws.send(
        JSON.stringify({
          op: 'join-phone',
          phoneToken: this.creds.phoneToken,
          ...(this.announcePairing
            ? { phonePub: this.creds.phonePubB64, phoneName: this.creds.deviceName }
            : {})
        })
      )
    }
    ws.onmessage = (ev) => {
      void this.onMessage(ev.data)
    }
    ws.onclose = () => {
      this.pending.forEach((p) => {
        clearTimeout(p.timer)
        p.reject(new Error('连接已断开'))
      })
      this.pending.clear()
      if (this.joinWaiter) {
        clearTimeout(this.joinWaiter.timer)
        this.joinWaiter.reject(
          new Error(this.announcePairing ? '配对连接已断开' : '连接已断开')
        )
        this.joinWaiter = null
      }
      if (this.stopped) {
        this.setStatus('off')
        return
      }
      this.setStatus('reconnecting')
      const delay = this.backoffMs
      this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS)
      // 记下定时器句柄：disconnect() 时清除，避免手动断开后仍自动重连
      this.reconnectTimer = window.setTimeout(() => {
        this.reconnectTimer = null
        this.loop()
      }, delay)
    }
    ws.onerror = () => {
      try {
        ws.close()
      } catch {}
    }
  }

  private async onMessage(data: string | ArrayBuffer): Promise<void> {
    if (typeof data === 'string') {
      // 控制面回包
      try {
        const msg = JSON.parse(data) as {
          id?: string
          kind?: string
          ok?: boolean
          data?: unknown
          error?: string
        }
        if (msg.id === 'pair-ack') {
          this.announcePairing = false
          this.pairAcknowledged = true
          this.setStatus('online', '配对完成')
          if (this.joinWaiter) {
            const waiter = this.joinWaiter
            this.joinWaiter = null
            clearTimeout(waiter.timer)
            waiter.resolve()
          }
          return
        }
        if (msg.kind === 'res' && this.joinWaiter) {
          if (!msg.ok) {
            const waiter = this.joinWaiter
            this.joinWaiter = null
            clearTimeout(waiter.timer)
            waiter.reject(new Error(msg.error || '加入中转失败'))
          } else if (this.announcePairing && !this.pairAcknowledged) {
            // 首次配对必须等桌面派生完会话密钥并回 pair-ack，不能提前发业务请求。
            this.setStatus('等待桌面确认')
          } else {
            const waiter = this.joinWaiter
            this.joinWaiter = null
            clearTimeout(waiter.timer)
            this.setStatus('online')
            waiter.resolve()
          }
          return
        }
        if (msg.id && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)!
          this.pending.delete(msg.id)
          clearTimeout(p.timer)
          if (msg.ok) p.resolve(msg.data)
          else p.reject(new Error(msg.error || '请求失败'))
        }
      } catch (error) {
        // 控制面回包解析失败不再静默：具体帧内容进日志，现场可诊断
        console.warn('[link] 控制面消息解析失败', error, typeof data === 'string' ? data.slice(0, 200) : '')
      }
      return
    }
    // 业务密文帧
    if (!this.cipherKey) return
    try {
      const frame = JSON.parse(new TextDecoder().decode(data)) as SealedMessage
      const plaintext = await this.openFrame(frame)
      const msg = JSON.parse(plaintext) as { id?: string; kind?: string; event?: unknown; data?: unknown; error?: string; ok?: boolean }
      if (msg.kind === 'res' && msg.id && this.pending.has(msg.id)) {
        const p = this.pending.get(msg.id)!
        this.pending.delete(msg.id)
        clearTimeout(p.timer)
        if (msg.ok) p.resolve(msg.data)
        else p.reject(new Error(String(msg.error || '请求失败')))
      } else if (msg.kind === 'push') {
        this.onPush?.(msg.event)
      }
    } catch (error) {
      // 解密/解析失败不再静默：桌面侧重放计数与封禁能从这里找到对应现场
      console.warn('[link] 业务帧解密或解析失败', error instanceof Error ? error.message : String(error))
    }
  }

  private async sealFrame(plaintext: string): Promise<ArrayBuffer> {
    if (!this.cipherKey) throw new Error('未配对')
    const seq = this.sendSeq++
    if (seq > 0xffffffff) throw new Error('序号耗尽请重新配对')
    // 序号只进不退：立即落盘，刷新后从新水位继续
    storeSeq(this.creds.phoneToken, this.sendSeq)
    // nonce 布局必须与桌面 SessionCipher.seal 完全一致：12B 随机 + hi/be32 + lo/be32 + 4 零字节
    const rand12 = new Uint8Array(12)
    crypto.getRandomValues(rand12)
    const nonce = buildNonce24(seq, rand12)
    const sealed = await sealXChaCha(new TextEncoder().encode(plaintext), nonce, this.cipherKey)
    const frame: SealedMessage = { seq, nonce: b64urlEncode(nonce), data: b64urlEncode(sealed) }
    const bytes = new TextEncoder().encode(JSON.stringify(frame))
    if (bytes.length > MAX_FRAME_BYTES) throw new Error('帧超限')
    return bytes.buffer as ArrayBuffer
  }

  private async openFrame(frame: SealedMessage): Promise<string> {
    if (!this.cipherKey) throw new Error('未配对')
    if (!Number.isInteger(frame.seq) || frame.seq < 0) throw new Error('非法序号')
    if (frame.seq <= this.recvHigh - 1024 || this.recvSeen.has(frame.seq)) throw new Error('重放')
    const nonce = b64urlDecode(frame.nonce)
    const sealed = b64urlDecode(frame.data)
    if (nonce.length !== 24) throw new Error('非法 nonce')
    if (!checkNonceSeq(nonce, frame.seq)) throw new Error('序号与 nonce 不一致')
    const plain = await openXChaCha(sealed, nonce, this.cipherKey)
    if (!plain) throw new Error('解密失败')
    this.recvSeen.add(frame.seq)
    if (frame.seq > this.recvHigh) {
      this.recvHigh = frame.seq
      for (const s of [...this.recvSeen]) {
        if (s <= this.recvHigh - 1024) this.recvSeen.delete(s)
      }
    }
    return new TextDecoder().decode(plain)
  }

  request<T = unknown>(op: string, params: unknown): Promise<T> {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN || !this.cipherKey) {
      return Promise.reject(new Error('未连接'))
    }
    const id = `m-${++this.reqSeq}`
    const payload: RemoteRequest = { id, kind: 'req', op, params }
    return new Promise<T>((resolve, reject) => {
      const timer = window.setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('请求超时'))
      }, 30_000)
      this.pending.set(id, {
        resolve: (d) => resolve(d as T),
        reject,
        timer
      })
      this.sealFrame(JSON.stringify(payload))
        .then((buf) => ws.send(buf))
        .catch((e: unknown) => {
          this.pending.delete(id)
          clearTimeout(timer)
          reject(e instanceof Error ? e : new Error(String(e)))
        })
    })
  }

  /** 审批必须带参数哈希（与桌面核对一致后才放行）。 */
  async approve(runId: string, toolUseId: string, approved: boolean, input: unknown): Promise<unknown> {
    const paramHash = await paramHashOf(input)
    return this.request('approve', { runId, toolUseId, approved, paramHash })
  }
}

async function b64urlDecodeAsync(s: string): Promise<Uint8Array> {
  return b64urlDecode(s)
}
