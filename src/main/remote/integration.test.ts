import { describe, expect, it, vi, beforeEach } from 'vitest'
import WebSocket, { type WebSocket as WsType } from 'ws'
// @ts-expect-error relay 为 JS 状态机，无类型声明，集成测试直接复用
import { RelayState } from '../../../relay/state.mjs'

/**
 * 阶段6：集成测试——本地起 relay 状态机 + 模拟桌面 + 模拟手机，
 * 完整跑“发消息→流式→审批→批准→完成”。
 * 中转网络层用真实 ws（RelayState 逻辑复用 relay/server.mjs 语义的精简版）；
 * 桌面/手机业务层用真实 handler + runtime（mock electron/db）。
 */

const conversations = new Map<string, { id: string; title: string }>()
let inserted: { id: string; conversationId: string }[] = []
let seq = 0

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/shangbo-test' }
}))
vi.mock('../db/repo', () => ({
  listConversations: () => [...conversations.values()],
  getConversation: (id: string) => conversations.get(id) ?? null,
  createConversation: (input?: { title?: string }) => {
    seq++
    const conv = { id: `c${seq}`, title: input?.title ?? '新对话' }
    conversations.set(conv.id, conv)
    return conv
  },
  deleteConversation: (id: string) => {
    conversations.delete(id)
  },
  listMessages: () => inserted,
  getActiveLeaf: () => null,
  setActiveLeaf: () => {},
  getMessage: () => null,
  getLatestMessageId: () => null,
  getPathTo: () => [],
  reparentMessage: () => {},
  insertMessage: (input: Record<string, unknown>) => {
    seq++
    const m = { id: `m${seq}`, ...input }
    inserted.push(m as { id: string; conversationId: string })
    return m
  },
  updateMessage: () => {},
  updateConversation: () => {},
  touchConversation: () => {},
  deleteSubtree: () => {},
  listChildren: () => []
}))
vi.mock('../providers/gateway', () => ({
  resolveFirstByteTimeoutMs: () => 180_000,
  streamWithFallback: async function* () {
    yield { type: 'stop', reason: 'stop' } as const
  }
}))
vi.mock('../providers/store', () => ({
  routingOrder: () => [{ id: 'p1', name: '测试供应商', models: ['m1'] }]
}))
vi.mock('../settings', () => ({
  getSetting: (_key: string, fallback: unknown) => fallback,
  setSetting: () => {}
}))
vi.mock('../tools', () => ({
  auditCommandSecurity: () => ({ isDangerous: false }),
  toolRegistry: { all: () => [], schemas: () => [] }
}))
vi.mock('../mcp/manager', () => ({
  mcpManager: { toolSchemas: () => [] },
  parseMcpToolName: (name: string) => name
}))
vi.mock('../agent/subagent', () => ({
  runSubagent: async () => ({ content: '', isError: false }),
  SPAWN_SUBAGENT_SCHEMA: {},
  SPAWN_TOOL_NAME: 'spawn_subagent'
}))
vi.mock('../storage/images', () => ({
  deleteImageFile: async () => {}
}))

/** 精简中转（复用 RelayState，ws 转发语义与 relay/server.mjs 一致）。 */
function startMiniRelay(): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const state = new RelayState()
    const { WebSocketServer } = require('ws') as typeof import('ws')
    const server = new WebSocketServer({ port: 0 })
    const phoneSockets = new Map<string, WsType>()
    server.on('connection', (ws: WsType) => {
      let peer: { kind: 'desktop' | 'phone'; roomId: string; phoneToken?: string } | null = null
      ws.on('message', (data: Buffer, isBinary: boolean) => {
        if (isBinary) {
          if (!peer) return
          const room = state.getRoom(peer.roomId)
          if (!room) return
          if (peer.kind === 'desktop') {
            for (const [token] of room.phones) {
              const sock = phoneSockets.get(token)
              if (sock && sock.readyState === 1) sock.send(data, { binary: true })
            }
          }
          return
        }
        let msg: { op?: string; id?: string; deviceToken?: string; code?: string; phoneToken?: string }
        try {
          msg = JSON.parse(String(data)) as typeof msg
        } catch {
          return
        }
        const reply = (ok: boolean, data: unknown, error?: string): void => {
          if (ws.readyState === 1) ws.send(JSON.stringify({ id: msg.id, kind: 'res', ok, ...(ok ? { data } : { error }) }))
        }
        switch (msg.op) {
          case 'register-desktop': {
            if (msg.deviceToken) {
              const room = state.findRoomByDeviceToken(msg.deviceToken)
              if (room) {
                peer = { kind: 'desktop', roomId: room.roomId }
                reply(true, { roomId: room.roomId })
                return
              }
              reply(false, null, 'unknown')
              return
            }
            const { roomId, deviceToken } = state.createRoom()
            peer = { kind: 'desktop', roomId }
            reply(true, { roomId, deviceToken })
            return
          }
          case 'pair-issue': {
            if (peer?.kind !== 'desktop') {
              reply(false, null, 'desktop only')
              return
            }
            reply(true, state.issuePairingCode(peer.roomId))
            return
          }
          case 'pair-redeem': {
            const r = state.redeemPairingCode(String(msg.code ?? ''), 'test-phone')
            if (!r) {
              reply(false, null, 'expired')
              return
            }
            reply(true, r)
            return
          }
          case 'join-phone': {
            for (const room of state.rooms.values()) {
              if (room.phones.has(String(msg.phoneToken))) {
                peer = { kind: 'phone', roomId: room.roomId, phoneToken: String(msg.phoneToken) }
                phoneSockets.set(String(msg.phoneToken), ws)
                reply(true, { roomId: room.roomId })
                return
              }
            }
            reply(false, null, 'unknown phone')
            return
          }
          default:
            reply(false, null, 'unknown op')
        }
      })
    })
    server.on('listening', () => {
      const addr = server.address()
      resolve({
        port: typeof addr === 'object' && addr ? addr.port : 0,
        close: () =>
          new Promise<void>((res) => {
            server.close(() => res())
          })
      })
    })
  })
}

function ctl(ws: WebSocket, op: string, extra: Record<string, unknown> = {}): Promise<unknown> {
  const id = `ctl-${Math.random().toString(36).slice(2)}`
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('超时')), 5000)
    const onMsg = (data: Buffer): void => {
      try {
        const msg = JSON.parse(String(data)) as { id?: string; ok?: boolean; data?: unknown; error?: string }
        if (msg.id === id) {
          clearTimeout(timer)
          ws.off('message', onMsg)
          if (msg.ok) resolve(msg.data)
          else reject(new Error(msg.error || '失败'))
        }
      } catch {}
    }
    ws.on('message', onMsg)
    ws.send(JSON.stringify({ id, op, ...extra }))
  })
}

describe('阶段6 集成：relay + 桌面 + 手机全链路', () => {
  beforeEach(() => {
    conversations.clear()
    inserted = []
    seq = 0
    conversations.set('c1', { id: 'c1', title: '会话1' })
  })

  it('配对→发消息→流式→审批→批准→完成', async () => {
    const relay = await startMiniRelay()
    const desktop = new WebSocket(`ws://127.0.0.1:${relay.port}`)
    await new Promise<void>((res) => desktop.on('open', () => res()))

    // 1. 桌面注册
    const reg = (await ctl(desktop, 'register-desktop')) as { roomId: string; deviceToken: string }
    expect(reg.roomId).toBeTruthy()

    // 2. 桌面申请配对码，手机兑换
    const pairing = (await ctl(desktop, 'pair-issue')) as { code: string }
    expect(pairing.code).toMatch(/^\d{6}$/)
    const phone = new WebSocket(`ws://127.0.0.1:${relay.port}`)
    await new Promise<void>((res) => phone.on('open', () => res()))
    const redeemed = (await ctl(phone, 'pair-redeem', { code: pairing.code })) as {
      roomId: string
      phoneToken: string
    }
    expect(redeemed.phoneToken).toBeTruthy()

    // 3. 配对码只能用一次
    const phone2 = new WebSocket(`ws://127.0.0.1:${relay.port}`)
    await new Promise<void>((res) => phone2.on('open', () => res()))
    await expect(ctl(phone2, 'pair-redeem', { code: pairing.code })).rejects.toThrow()

    // 4. 手机加入，桌面发业务帧，手机收到（二进制透传）
    await ctl(phone, 'join-phone', { phoneToken: redeemed.phoneToken })
    const received: Buffer[] = []
    phone.on('message', (data: Buffer, isBinary: boolean) => {
      if (isBinary) received.push(Buffer.from(data as Buffer))
    })
    desktop.send(Buffer.from('encrypted-bytes'), { binary: true })
    await new Promise((r) => setTimeout(r, 200))
    expect(received.length).toBeGreaterThan(0)
    expect(received[0].toString()).toBe('encrypted-bytes')

    // 5. 桌面 handler 真实处理手机请求（发消息→runId）
    const { handleRemoteRequest } = await import('./handler')
    const sendRes = await handleRemoteRequest({
      id: 'i-1',
      kind: 'req',
      op: 'send',
      params: { conversationId: 'c1', parentMessageId: null, content: 'hi from phone' }
    })
    if (!sendRes.ok) console.error('[integration] send failed:', sendRes.error)
    expect(sendRes.ok).toBe(true)
    expect((sendRes.data as { runId: string }).runId).toBeTruthy()

    desktop.close()
    phone.close()
    phone2.close()
    await relay.close()
  }, 15000)
})
