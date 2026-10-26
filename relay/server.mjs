import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join, normalize, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { WebSocketServer } from 'ws'
import { RelayState, RateLimiter, MAX_FRAME_BYTES, HEARTBEAT_MS } from './state.mjs'

/**
 * 中转服务：只按 roomId 转发二进制帧，不解析、不存储消息内容。
 * - 桌面：{ role: 'desktop', deviceToken } 注册到自己的 room
 * - 手机：{ role: 'phone', phoneToken } 加入 room（token 由配对码换取）
 * - 控制消息（JSON）：register / pair-issue / pair-redeem / revoke / list-phones
 * - 业务帧（二进制）：按 room 转发给对方，附带帧大小与限流检查
 *
 * 部署要求：必须经 TLS 反代（Caddy/Nginx）对外，只接受 wss://，拒绝明文 ws://。
 * 见 deploy/ 目录示例。
 */

const PORT = Number(process.env.RELAY_PORT ?? 8787)
const HOST = process.env.RELAY_HOST ?? '127.0.0.1'

// PWA 静态托管：relay 同目录 public/（`npm run mobile:build` 产物拷过来）。
// Caddy 只需一条反代，无需 file_server 挂载。反代剥掉 /sb-remote 前缀后这里按 / 提供。
const HERE = dirname(fileURLToPath(import.meta.url))
const PUBLIC_DIR = join(HERE, 'public')
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon'
}

const state = new RelayState()
const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  if (url.pathname === '/healthz') {
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify({ ok: true, ...state.stats }))
    return
  }
  // 静态：/ -> index.html；其余按路径取文件，防目录穿越
  try {
    const rel = url.pathname === '/' || url.pathname === '' ? 'index.html' : url.pathname.replace(/^\/+/, '')
    const file = normalize(join(PUBLIC_DIR, rel))
    if (!file.startsWith(PUBLIC_DIR)) {
      res.writeHead(403)
      res.end('forbidden')
      return
    }
    const data = await readFile(file)
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream' })
    res.end(data)
  } catch {
    // SPA 回退：未知路径返回 index.html（manifest/sw 精确文件缺失则 404）
    if (url.pathname.startsWith('/assets/') || url.pathname.endsWith('.webmanifest') || url.pathname.endsWith('.js')) {
      res.writeHead(404)
      res.end('not found')
      return
    }
    try {
      const data = await readFile(join(PUBLIC_DIR, 'index.html'))
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(data)
    } catch {
      res.writeHead(404)
      res.end('not found')
    }
  }
})

const wss = new WebSocketServer({
  server,
  maxPayload: MAX_FRAME_BYTES,
  // 要求反代透传 X-Forwarded-Proto；直连 http 时打日志提醒配 TLS
  verifyClient: (info, done) => {
    const proto = info.req.headers['x-forwarded-proto']
    if (proto && proto !== 'https') {
      done(false, 403, 'relay requires TLS (wss only)')
      return
    }
    done(true)
  }
})

function sendJson(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj))
}

wss.on('connection', (ws, req) => {
  state.stats.connections++
  const limiter = new RateLimiter()
  /** @type {{ kind: 'desktop'|'phone', roomId: string } | null} */
  let peer = null
  let alive = true

  const heartbeat = setInterval(() => {
    if (!alive) {
      clearInterval(heartbeat)
      ws.terminate()
      return
    }
    alive = false
    ws.ping()
  }, HEARTBEAT_MS)
  ws.on('pong', () => {
    alive = true
  })

  ws.on('message', (data, isBinary) => {
    // 超限帧由 ws 的 maxPayload 直接断开，这里只做限流
    if (!limiter.take()) {
      sendJson(ws, { kind: 'res', ok: false, error: 'rate limited' })
      ws.close(1008, 'rate limited')
      return
    }

    if (isBinary) {
      // 业务密文帧：只按 room 转发，不解析
      if (!peer) return
      const room = state.getRoom(peer.roomId)
      if (!room) return
      state.stats.bytesForwarded += data.length
      if (peer.kind === 'desktop') {
        for (const [token] of room.phones) {
          const sock = phoneSockets.get(token)
          if (sock && sock.readyState === 1) sock.send(data, { binary: true })
        }
      } else {
        if (room.desktop && room.desktop.readyState === 1) room.desktop.send(data, { binary: true })
      }
      return
    }

    // 控制消息：JSON
    let msg
    try {
      msg = JSON.parse(String(data))
    } catch {
      sendJson(ws, { kind: 'res', ok: false, error: 'bad json' })
      return
    }
    handleControl(ws, msg)
  })

  ws.on('close', () => {
    clearInterval(heartbeat)
    if (!peer) return
    const room = state.getRoom(peer.roomId)
    if (!room) return
    if (peer.kind === 'desktop') {
      if (room.desktop === ws) room.desktop = null
    } else {
      phoneSockets.delete(peer.phoneToken)
    }
  })

  function handleControl(ws, msg) {
    const id = typeof msg.id === 'string' ? msg.id : ''
    const reply = (ok, data, error) => sendJson(ws, { id, kind: 'res', ok, ...(ok ? { data } : { error }) });

    switch (msg.op) {
      case 'register-desktop': {
        // 首次注册：创建 room；断线重连：凭 deviceToken 认领
        if (typeof msg.deviceToken === 'string') {
          const room = state.findRoomByDeviceToken(msg.deviceToken)
          if (room) {
            room.desktop?.close?.(1000, 'replaced')
            room.desktop = ws
            peer = { kind: 'desktop', roomId: room.roomId }
            reply(true, { roomId: room.roomId })
            return
          }
          reply(false, null, 'unknown device token')
          return
        }
        const { roomId, deviceToken } = state.createRoom()
        state.getRoom(roomId).desktop = ws
        peer = { kind: 'desktop', roomId }
        reply(true, { roomId, deviceToken })
        return
      }
      case 'join-phone': {
        const { phoneToken } = msg
        if (typeof phoneToken !== 'string' || state.isRevoked(phoneToken)) {
          reply(false, null, 'revoked or unknown phone token')
          ws.close(1008, 'revoked')
          return
        }
        for (const room of state.rooms.values()) {
          if (room.phones.has(phoneToken)) {
            const info = room.phones.get(phoneToken)
            info.lastSeen = Date.now()
            peer = { kind: 'phone', roomId: room.roomId, phoneToken }
            phoneSockets.set(phoneToken, ws)
            reply(true, { roomId: room.roomId, pendingApprovals: [] })
            return
          }
        }
        reply(false, null, 'unknown phone token')
        return
      }
      case 'pair-issue': {
        // 桌面申请配对码：必须已注册
        if (peer?.kind !== 'desktop') {
          reply(false, null, 'desktop only')
          return
        }
        state.sweepExpiredPairings()
        const pairing = state.issuePairingCode(peer.roomId)
        if (!pairing) {
          reply(false, null, 'no room')
          return
        }
        reply(true, { code: pairing.code, expiresAt: pairing.expiresAt })
        return
      }
      case 'pair-redeem': {
        // 手机提交配对码换取 phoneToken（5 分钟有效、只能用一次）
        const { code, phoneName } = msg
        if (typeof code !== 'string') {
          reply(false, null, 'bad code')
          return
        }
        const result = state.redeemPairingCode(code, typeof phoneName === 'string' ? phoneName : '')
        if (!result) {
          reply(false, null, 'expired or already used')
          return
        }
        reply(true, result)
        return
      }
      case 'revoke-phone': {
        // 桌面吊销手机：其连接立即断开
        if (peer?.kind !== 'desktop') {
          reply(false, null, 'desktop only')
          return
        }
        const ok = state.revokePhone(peer.roomId, msg.phoneToken)
        const sock = phoneSockets.get(msg.phoneToken)
        try {
          sock?.close(1008, 'revoked by desktop')
        } catch {}
        phoneSockets.delete(msg.phoneToken)
        reply(ok, null, ok ? undefined : 'unknown phone')
        return
      }
      case 'list-phones': {
        if (peer?.kind !== 'desktop') {
          reply(false, null, 'desktop only')
          return
        }
        reply(true, state.listPhones(peer.roomId))
        return
      }
      default:
        reply(false, null, `unknown op: ${msg.op}`)
    }
  }
})

/** phoneToken -> ws（桌面广播时查找） */
const phoneSockets = new Map()

// 定期清理过期配对码
setInterval(() => state.sweepExpiredPairings(), 60_000)

server.listen(PORT, HOST, () => {
  console.log(`[relay] listening on ${HOST}:${PORT} (put TLS in front: wss only)`)
})
