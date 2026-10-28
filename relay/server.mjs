import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join, normalize, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { dirname } from 'node:path'
import { timingSafeEqual } from 'node:crypto'
import { WebSocketServer } from 'ws'
import { RelayState, RateLimiter, MAX_FRAME_BYTES, HEARTBEAT_MS } from './state.mjs'
import {
  parseAllowedDesktops,
  verifyIdentitySignature,
  canonicalize,
  identityFingerprint
} from './identity.mjs'

/**
 * 中转服务：只按 roomId 转发二进制帧，不解析、不存储消息内容。
 * - 桌面：{ role: 'desktop', deviceToken } 注册到自己的 room
 * - 手机：{ role: 'phone', phoneToken } 加入 room（token 由配对码换取）
 * - 控制消息（JSON）：register / pair-issue / pair-redeem / join-phone / revoke / list-phones
 * - 业务帧（二进制）：按 room 转发给对方，附带帧大小与限流检查
 *
 * 部署要求：必须经 TLS 反代（Caddy/Nginx）对外，只接受 wss://，拒绝明文 ws://。
 * 见 deploy/ 目录示例。
 *
 * 准入控制：设置环境变量 RELAY_ACCESS_KEY 后，register-desktop 必须带上同一个
 * accessKey 才被受理。这是"别人拿到你的中转地址也用不了"的开关——不设则该中转
 * 对公网完全开放（谁都能建房间），只适合本机/内网调试。
 */

const PORT = Number(process.env.RELAY_PORT ?? 8787)
const HOST = process.env.RELAY_HOST ?? '127.0.0.1'
/** 准入密钥：留空 = 不校验（开放中转）；设置后桌面注册必须匹配。 */
const ACCESS_KEY = (process.env.RELAY_ACCESS_KEY ?? '').trim()
/** 同时在线连接上限，防止连接洪泛把内存与 fd 吃光。 */
const MAX_CONNECTIONS = Number(process.env.RELAY_MAX_CONNECTIONS ?? 2000)
/**
 * 身份白名单：设置后该中转**只服务列表里的桌面**，别人连注册都过不去。
 * 这是"只有我能用"的开关——服务器只存公钥，伪造需要私钥。
 */
const ALLOWED_DESKTOPS = parseAllowedDesktops(process.env.RELAY_ALLOWED_DESKTOPS)
/** 白名单模式下，是否仍要求准入密钥（默认不要求，白名单本身已足够严格）。 */
const REQUIRE_ACCESS_KEY_WITH_ALLOWLIST = (process.env.RELAY_REQUIRE_ACCESS_KEY ?? '') === '1'

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
    // 连接数上限：超限直接拒绝握手，避免 fd/内存被洪泛耗尽
    if (wss.clients.size >= MAX_CONNECTIONS) {
      done(false, 503, 'relay busy')
      return
    }
    done(true)
  }
})

/**
 * 准入密钥校验：常量时间比较，避免通过响应耗时逐字符试探。
 * ACCESS_KEY 为空表示该中转不设准入（开放模式），此时放行全部注册。
 */
function checkAccessKey(provided) {
  if (!ACCESS_KEY) return true
  if (typeof provided !== 'string') return false
  const a = Buffer.from(provided, 'utf8')
  const b = Buffer.from(ACCESS_KEY, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

/** 身份签名覆盖的内容：挑战与公钥绑定，换公钥或换挑战都无法复用签名。 */
function identityMessage(challenge, publicKeyB64) {
  return `${challenge}|${publicKeyB64}`
}

/**
 * 桌面注册的身份校验（两阶段）。
 *
 * 返回 { stage:'challenge', challenge } 表示已签发挑战，等客户端签名；
 * 返回 { ok:true } 表示身份通过；返回 { ok:false, error } 表示拒绝。
 *
 * 白名单为空时退化为"不校验身份"（兼容旧部署与本地调试），
 * 但准入密钥仍然生效——两种防线互相独立。
 */
function checkDesktopIdentity(msg) {
  // 白名单未启用：不需要身份签名
  if (ALLOWED_DESKTOPS.size === 0) return { ok: true }

  const pubKey = typeof msg.pubKey === 'string' ? msg.pubKey.trim() : ''
  if (!pubKey) return { ok: false, error: 'desktop identity required' }

  // 第一关：公钥必须在白名单内（先挡掉绝大多数无关请求，不做昂贵验签）
  const fp = canonicalize(pubKey)
  if (!fp || !ALLOWED_DESKTOPS.has(fp)) return { ok: false, error: 'desktop not allowed' }

  // 第二关：必须提交挑战签名。只比对公钥是无效的——公钥是公开信息，谁都能抄。
  if (!msg.challenge || !msg.signature) {
    return { stage: 'challenge', challenge: state.issueChallenge() }
  }
  // 挑战一次性：无论对错都消耗掉，防止同一挑战反复试探签名
  if (!state.consumeChallenge(msg.challenge)) {
    return { ok: false, error: 'challenge expired' }
  }
  if (!verifyIdentitySignature(pubKey, identityMessage(msg.challenge, pubKey), msg.signature)) {
    return { ok: false, error: 'bad signature' }
  }
  return { ok: true }
}

function sendJson(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj))
}

/** 把手机公钥交给桌面，由桌面完成 X25519 派生并回 pair-ack。 */
function notifyPairing(room, phoneToken) {
  const info = room?.phones.get(phoneToken)
  if (!info?.phonePub || !room.desktop || room.desktop.readyState !== 1) return false
  sendJson(room.desktop, {
    id: 'pair-hello',
    kind: 'res',
    ok: true,
    data: {
      deviceName: info.name || '手机',
      phonePub: info.phonePub,
      phoneToken
    }
  })
  return true
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
      state.touchRoom(peer.roomId)
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
        // 准入：设了 RELAY_ACCESS_KEY 就必须带对，否则外人拿到地址也建不了房间。
        // 白名单模式下默认不再强制准入密钥（白名单本身更严格），可用 RELAY_REQUIRE_ACCESS_KEY=1 强制两者并存。
        const needAccessKey = ACCESS_KEY && (ALLOWED_DESKTOPS.size === 0 || REQUIRE_ACCESS_KEY_WITH_ALLOWLIST)
        if (needAccessKey && !checkAccessKey(msg.accessKey)) {
          reply(false, null, 'access denied')
          ws.close(1008, 'access denied')
          return
        }
        // 身份：白名单模式要求 Ed25519 挑战签名，别人连注册都过不去。
        const identity = checkDesktopIdentity(msg)
        if (identity.stage === 'challenge') {
          reply(true, { challenge: identity.challenge })
          return
        }
        if (!identity.ok) {
          reply(false, null, identity.error)
          ws.close(1008, identity.error)
          return
        }
        // 首次注册：创建 room；断线重连：凭 deviceToken 认领
        if (typeof msg.deviceToken === 'string') {
          const room = state.findRoomByDeviceToken(msg.deviceToken)
          if (room) {
            // 白名单模式下，deviceToken 也必须属于同一身份，避免拿着别人的 token 顶替房间。
            if (ALLOWED_DESKTOPS.size > 0) {
              const roomFp = canonicalize(room.ownerPubKey)
              if (!roomFp || roomFp !== canonicalize(msg.pubKey)) {
                reply(false, null, 'desktop not allowed')
                ws.close(1008, 'desktop not allowed')
                return
              }
            }
            room.desktop?.close?.(1000, 'replaced')
            room.desktop = ws
            room.lastActiveAt = Date.now()
            peer = { kind: 'desktop', roomId: room.roomId }
            reply(true, { roomId: room.roomId })
            // 手机已加入但桌面当时不在线：桌面重连后补发未确认的配对公钥。
            for (const pending of state.listPendingPairings(room.roomId)) {
              notifyPairing(room, pending.phoneToken)
            }
            return
          }
          reply(false, null, 'unknown device token')
          return
        }
        const created = state.createRoom()
        // 房间数已达上限：拒绝，避免公网上无限注册把内存打满
        if (!created) {
          reply(false, null, 'relay room limit reached')
          ws.close(1013, 'room limit reached')
          return
        }
        const { roomId, deviceToken } = created
        // 记下房间归属身份：重连时据此拒绝他人顶替
        state.getRoom(roomId).ownerPubKey =
          ALLOWED_DESKTOPS.size > 0 ? String(msg.pubKey ?? '') : ''
        state.getRoom(roomId).desktop = ws
        peer = { kind: 'desktop', roomId }
        reply(true, { roomId, deviceToken })
        return
      }
      case 'join-phone': {
        const { phoneToken, phonePub, phoneName } = msg
        if (typeof phoneToken !== 'string' || state.isRevoked(phoneToken)) {
          reply(false, null, 'revoked or unknown phone token')
          ws.close(1008, 'revoked')
          return
        }
        // O(1) 索引查找，不再遍历全部房间
        const room = state.findRoomByPhoneToken(phoneToken)
        if (room) {
          const info = room.phones.get(phoneToken)
          info.lastSeen = Date.now()
          room.lastActiveAt = Date.now()
          peer = { kind: 'phone', roomId: room.roomId, phoneToken }
          phoneSockets.set(phoneToken, ws)
          reply(true, { roomId: room.roomId, pendingApprovals: [] })
          if (typeof phonePub === 'string') {
            state.setPhonePairing(
              room.roomId,
              phoneToken,
              phonePub,
              typeof phoneName === 'string' ? phoneName : ''
            )
            notifyPairing(room, phoneToken)
          }
          return
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
      case 'pair-ack': {
        // 桌面已完成 X25519 派生：通知正在等待配对结果的手机
        if (peer?.kind !== 'desktop') {
          reply(false, null, 'desktop only')
          return
        }
        const sock = phoneSockets.get(msg.phoneToken)
        if (sock && sock.readyState === 1) {
          state.markPhonePaired(peer.roomId, msg.phoneToken)
          sendJson(sock, { id: 'pair-ack', kind: 'res', ok: true })
        }
        reply(true, true)
        return
      }
      default:
        reply(false, null, `unknown op: ${msg.op}`)
    }
  }
})

/** phoneToken -> ws（桌面广播时查找） */
const phoneSockets = new Map()

// 定期清理过期配对码 + 回收空闲房间（房间只增不减会长期打满内存）
setInterval(() => {
  state.sweepExpiredPairings()
  state.sweepIdleRooms()
  state.sweepExpiredChallenges()
}, 60_000)

server.listen(PORT, HOST, () => {
  console.log(`[relay] listening on ${HOST}:${PORT} (put TLS in front: wss only)`)
  if (ALLOWED_DESKTOPS.size > 0) {
    console.log(`[relay] 身份白名单已启用：只服务 ${ALLOWED_DESKTOPS.size} 个桌面身份（Ed25519 签名校验）`)
    for (const fp of ALLOWED_DESKTOPS) {
      console.log(`[relay]   allowed: ${fp.slice(0, 4)}-${fp.slice(4, 8)}-${fp.slice(8, 12)}-${fp.slice(12, 16)}`)
    }
  } else {
    const mode = ACCESS_KEY
      ? '准入密钥已启用（RELAY_ACCESS_KEY）'
      : '准入密钥未设置：任何拿到地址的人都能注册房间'
    console.log(`[relay] ${mode}`)
    console.log('[relay] 提示：要做到"只有我能用"，请设置 RELAY_ALLOWED_DESKTOPS（见 relay/README.md）')
  }
})
