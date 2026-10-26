import { randomBytes, randomUUID } from 'node:crypto'

/**
 * 房间与配对状态（纯内存，不落盘；重启后所有配对失效，需重新扫码）。
 * - room: 一个桌面设备 = 一个 roomId，桌面用 deviceToken 注册，手机用 phoneToken 加入
 * - pairingCode: 一次性配对码，5 分钟有效、只能用一次
 * - revokedPhones: 被吊销的手机 token，即使重连也拒绝
 */
export const PAIRING_TTL_MS = 5 * 60 * 1000
export const MAX_FRAME_BYTES = 1024 * 1024 // 单帧上限 1MB
export const MAX_MSG_PER_WINDOW = 30 // 每连接每 10 秒最多 30 条
export const RATE_WINDOW_MS = 10_000
export const HEARTBEAT_MS = 30_000
export const DEVICE_TOKEN_BYTES = 32
export const PHONE_TOKEN_BYTES = 32

export function newToken(bytes = DEVICE_TOKEN_BYTES) {
  return randomBytes(bytes).toString('base64url')
}

export function newPairingCode() {
  // 6 位数字，人可读、扫码失败时可手输
  return String(Math.floor(100000 + Math.random() * 900000))
}

export class RelayState {
  /** roomId -> { desktop, phones: Map<phoneToken, info>, pairing } */
  rooms = new Map()
  /** pairingCode -> { roomId, expiresAt, used }（全局索引，方便手机侧按码查找） */
  pairings = new Map()
  /** 已吊销的 phoneToken 集合 */
  revokedPhones = new Set()
  /** 连接统计：只记时间与字节，不记内容 */
  stats = { connections: 0, bytesForwarded: 0, startedAt: Date.now() }

  createRoom() {
    const roomId = randomUUID()
    const deviceToken = newToken()
    this.rooms.set(roomId, {
      roomId,
      deviceToken,
      desktop: null,
      phones: new Map(),
      pairing: null
    })
    return { roomId, deviceToken }
  }

  getRoom(roomId) {
    return this.rooms.get(roomId) ?? null
  }

  findRoomByDeviceToken(deviceToken) {
    for (const room of this.rooms.values()) {
      if (room.deviceToken === deviceToken) return room
    }
    return null
  }

  /** 桌面申请一次性配对码：覆盖旧码（旧码作废），5 分钟有效 */
  issuePairingCode(roomId) {
    const room = this.rooms.get(roomId)
    if (!room) return null
    // 旧码作废
    if (room.pairing) this.pairings.delete(room.pairing.code)
    let code = newPairingCode()
    while (this.pairings.has(code)) code = newPairingCode()
    const pairing = { code, roomId, expiresAt: Date.now() + PAIRING_TTL_MS, used: false }
    room.pairing = pairing
    this.pairings.set(code, pairing)
    return pairing
  }

  /** 手机提交配对码换取 phoneToken：过期、重复使用都失败 */
  redeemPairingCode(code, phoneName = '') {
    const pairing = this.pairings.get(code)
    if (!pairing || pairing.used || Date.now() > pairing.expiresAt) return null
    pairing.used = true
    this.pairings.delete(code)
    const room = this.rooms.get(pairing.roomId)
    if (!room) return null
    if (room.pairing?.code === code) room.pairing = null
    const phoneToken = newToken(PHONE_TOKEN_BYTES)
    room.phones.set(phoneToken, {
      token: phoneToken,
      name: phoneName.slice(0, 100),
      connectedAt: Date.now(),
      lastSeen: Date.now()
    })
    return { roomId: pairing.roomId, phoneToken }
  }

  /** 吊销手机：从房间移除并记入黑名单，其连接由调用方立即断开 */
  revokePhone(roomId, phoneToken) {
    const room = this.rooms.get(roomId)
    if (!room) return false
    const existed = room.phones.delete(phoneToken)
    this.revokedPhones.add(phoneToken)
    return existed
  }

  isRevoked(phoneToken) {
    return this.revokedPhones.has(phoneToken)
  }

  listPhones(roomId) {
    const room = this.rooms.get(roomId)
    if (!room) return []
    return [...room.phones.values()].map((p) => ({
      name: p.name,
      connectedAt: p.connectedAt,
      lastSeen: p.lastSeen
    }))
  }

  sweepExpiredPairings() {
    const now = Date.now()
    for (const [code, pairing] of this.pairings) {
      if (pairing.used || now > pairing.expiresAt) {
        this.pairings.delete(code)
        const room = this.rooms.get(pairing.roomId)
        if (room?.pairing?.code === code) room.pairing = null
      }
    }
  }
}

/** 滑动窗口限流器：每连接独立计数 */
export class RateLimiter {
  constructor(maxPerWindow = MAX_MSG_PER_WINDOW, windowMs = RATE_WINDOW_MS) {
    this.maxPerWindow = maxPerWindow
    this.windowMs = windowMs
    this.stamps = []
  }

  take() {
    const now = Date.now()
    while (this.stamps.length > 0 && this.stamps[0] <= now - this.windowMs) this.stamps.shift()
    if (this.stamps.length >= this.maxPerWindow) return false
    this.stamps.push(now)
    return true
  }
}
