/**
 * 手机端连接层（PWA 运行时，不进 Electron 打包）。
 * - WSS 连中转（只接受 wss://，拒绝明文）
 * - 控制面 JSON：join-phone / pair-redeem
 * - 业务面二进制密文：请求 {id,kind:'req'} → 响应 {id,kind:'res'}；推送 {kind:'push'}
 * - 断线指数退避重连；密钥存 IndexedDB（不可导出 CryptoKey 存 raw 会话密钥，
 *   第一版存 raw 32B，二期再迁不可导出 X25519 私钥）。
 */

import { b64urlDecode, b64urlEncode, paramHashOf, type SealedMessage } from './crypto-web'
import { openXChaCha, sealXChaCha } from './chacha'

export interface MobileCredentials {
  relayUrl: string
  phoneToken: string
  sessionKeyB64: string
  deviceName: string
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

  onPush: ((event: unknown) => void) | null = null
  onStatus: ((status: string, detail?: string) => void) | null = null

  constructor(private readonly creds: MobileCredentials) {}

  async connect(): Promise<void> {
    const raw = await b64urlDecodeAsync(this.creds.sessionKeyB64)
    this.cipherKey = raw
    this.stopped = false
    this.loop()
  }

  disconnect(): void {
    this.stopped = true
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
      ws.send(JSON.stringify({ op: 'join-phone', phoneToken: this.creds.phoneToken }))
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
      if (this.stopped) {
        this.setStatus('off')
        return
      }
      this.setStatus('reconnecting')
      const delay = this.backoffMs
      this.backoffMs = Math.min(this.backoffMs * 2, MAX_BACKOFF_MS)
      window.setTimeout(() => this.loop(), delay)
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
        const msg = JSON.parse(data) as { id?: string; ok?: boolean; data?: unknown; error?: string }
        if (msg.id && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id)!
          this.pending.delete(msg.id)
          clearTimeout(p.timer)
          if (msg.ok) p.resolve(msg.data)
          else p.reject(new Error(msg.error || '请求失败'))
        }
      } catch {}
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
    } catch {}
  }

  private async sealFrame(plaintext: string): Promise<ArrayBuffer> {
    if (!this.cipherKey) throw new Error('未配对')
    const seq = this.sendSeq++
    const nonce = new Uint8Array(24)
    crypto.getRandomValues(nonce.subarray(0, 12))
    const view = new DataView(nonce.buffer)
    view.setUint32(16, Math.floor(seq / 0x100000000), false)
    view.setUint32(20, seq >>> 0, false)
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
    const view = new DataView(nonce.buffer, nonce.byteOffset)
    const hi = view.getUint32(16, false)
    const lo = view.getUint32(20, false)
    if (hi * 0x100000000 + lo !== frame.seq) throw new Error('序号与 nonce 不一致')
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
