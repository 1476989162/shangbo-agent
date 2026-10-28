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

/**
 * 资源上限：中转是公网服务，房间与吊销表都是纯内存结构。
 * 没有上限时任何人循环 register-desktop 就能把进程撑爆（远程 OOM）。
 */
export const MAX_ROOMS = Number(process.env.RELAY_MAX_ROOMS ?? 5000)
/** 空房间回收：桌面不在线、且没有任何手机，超过此空闲时长直接删除。 */
export const ROOM_IDLE_TTL_MS = Number(process.env.RELAY_ROOM_IDLE_MS ?? 7 * 24 * 60 * 60 * 1000)
/** 吊销黑名单上限：超出按插入顺序淘汰最旧的（被淘汰的 token 本来也已断开）。 */
export const MAX_REVOKED_PHONES = 20_000
/** 身份鉴权挑战有效期：60 秒足够往返，又短到无法被长期囤积重放。 */
export const CHALLENGE_TTL_MS = 60 * 1000

export function newToken(bytes = DEVICE_TOKEN_BYTES) {
  return randomBytes(bytes).toString('base64url')
}

export function newPairingCode() {
  // 6 位数字，人可读、扫码失败时可手输
  return String(Math.floor(100000 + Math.random() * 900000))
}

export class RelayState {
  /** roomId -> { desktop, phones: Map<phoneToken, info>, pairing, lastActiveAt } */
  rooms = new Map()
  /** deviceToken -> roomId（注册/重连 O(1)，避免每次遍历全部房间） */
  deviceTokens = new Map()
  /** pairingCode -> { roomId, expiresAt, used }（全局索引，方便手机侧按码查找） */
  pairings = new Map()
  /** phoneToken -> roomId（join-phone 不再遍历房间；同时限制吊销表增长） */
  phoneRooms = new Map()
  /** 已吊销的 phoneToken 集合 */
  revokedPhones = new Set()
  /** 连接统计：只记时间与字节，不记内容 */
  stats = { connections: 0, bytesForwarded: 0, startedAt: Date.now() }

  /**
   * maxRooms / roomIdleTtlMs 可注入，便于测试上限与回收逻辑。
   */
  constructor({ maxRooms = MAX_ROOMS, roomIdleTtlMs = ROOM_IDLE_TTL_MS } = {}) {
    this.maxRooms = maxRooms
    this.roomIdleTtlMs = roomIdleTtlMs
    /** challenge -> { expiresAt }（身份鉴权用，一次性，60 秒有效） */
    this.challenges = new Map()
  }

  /** 签发一次性登录挑战（身份鉴权第一步）。 */
  issueChallenge() {
    const challenge = randomBytes(32).toString('base64url')
    this.challenges.set(challenge, { expiresAt: Date.now() + CHALLENGE_TTL_MS })
    return challenge
  }

  /**
   * 消耗挑战：无论校验成败都删除，防止同一挑战被反复试探签名。
   * 过期或不存在返回 false。
   */
  consumeChallenge(challenge) {
    if (typeof challenge !== 'string' || !challenge) return false
    const entry = this.challenges.get(challenge)
    if (!entry) return false
    this.challenges.delete(challenge)
    return Date.now() <= entry.expiresAt
  }

  /** 清理过期挑战，避免未完成握手的连接堆积内存。 */
  sweepExpiredChallenges(now = Date.now()) {
    let removed = 0
    for (const [challenge, entry] of this.challenges) {
      if (now > entry.expiresAt) {
        this.challenges.delete(challenge)
        removed++
      }
    }
    return removed
  }

  /**
   * 创建房间。超过 maxRooms 时返回 null，调用方必须拒绝该桌面连接，
   * 否则公网上任何人循环注册即可把内存吃光。
   */
  createRoom() {
    if (this.rooms.size >= this.maxRooms) return null
    const roomId = randomUUID()
    const deviceToken = newToken()
    this.rooms.set(roomId, {
      roomId,
      deviceToken,
      desktop: null,
      phones: new Map(),
      pairing: null,
      lastActiveAt: Date.now()
    })
    this.deviceTokens.set(deviceToken, roomId)
    return { roomId, deviceToken }
  }

  getRoom(roomId) {
    return this.rooms.get(roomId) ?? null
  }

  findRoomByDeviceToken(deviceToken) {
    const roomId = this.deviceTokens.get(deviceToken)
    if (!roomId) return null
    const room = this.rooms.get(roomId)
    // 房间已被回收：顺手清掉悬空索引
    if (!room) {
      this.deviceTokens.delete(deviceToken)
      return null
    }
    return room
  }

  /** 标记房间活跃（有连接、有配对、有业务帧时刷新空闲计时）。 */
  touchRoom(roomId) {
    const room = this.rooms.get(roomId)
    if (room) room.lastActiveAt = Date.now()
  }

  /**
   * 回收空闲房间：桌面不在线且没有任何手机，且超过 idleMs 未活动。
   * 这是 createRoom 上限的兜底——否则房间只增不减，长期运行必然打满。
   */
  sweepIdleRooms(now = Date.now(), idleMs = this.roomIdleTtlMs) {
    let removed = 0
    for (const [roomId, room] of this.rooms) {
      const hasDesktop = room.desktop && room.desktop.readyState === 1
      if (hasDesktop || room.phones.size > 0) {
        room.lastActiveAt = now
        continue
      }
      if (now - room.lastActiveAt < idleMs) continue
      if (room.pairing) this.pairings.delete(room.pairing.code)
      this.deviceTokens.delete(room.deviceToken)
      this.rooms.delete(roomId)
      removed++
    }
    return removed
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
      roomId: pairing.roomId,
      phonePub: null,
      pairedAt: null,
      connectedAt: Date.now(),
      lastSeen: Date.now()
    })
    this.phoneRooms.set(phoneToken, pairing.roomId)
    room.lastActiveAt = Date.now()
    return { roomId: pairing.roomId, phoneToken }
  }

  /** 按 phoneToken 找房间（O(1)，不再遍历所有房间）。 */
  findRoomByPhoneToken(phoneToken) {
    const roomId = this.phoneRooms.get(phoneToken)
    if (!roomId) return null
    const room = this.rooms.get(roomId)
    if (!room) {
      this.phoneRooms.delete(phoneToken)
      return null
    }
    return room
  }

  /** 吊销手机：从房间移除并记入黑名单，其连接由调用方立即断开 */
  revokePhone(roomId, phoneToken) {
    const room = this.rooms.get(roomId)
    if (!room) return false
    const existed = room.phones.delete(phoneToken)
    this.phoneRooms.delete(phoneToken)
    this.rememberRevoked(phoneToken)
    return existed
  }

  /** 吊销表是有界集合：超上限淘汰最旧的，避免被大量 token 撑爆内存。 */
  rememberRevoked(phoneToken) {
    if (this.revokedPhones.has(phoneToken)) return
    this.revokedPhones.add(phoneToken)
    while (this.revokedPhones.size > MAX_REVOKED_PHONES) {
      const oldest = this.revokedPhones.values().next().value
      if (oldest === undefined) break
      this.revokedPhones.delete(oldest)
    }
  }

  isRevoked(phoneToken) {
    return this.revokedPhones.has(phoneToken)
  }

  /** 手机加入时登记公钥；同一 token 重新上报公钥视为新的待确认配对。 */
  setPhonePairing(roomId, phoneToken, phonePub, phoneName = '') {
    const room = this.rooms.get(roomId)
    const info = room?.phones.get(phoneToken)
    if (!info || typeof phonePub !== 'string') return false
    info.phonePub = phonePub
    info.pairedAt = null
    if (phoneName.trim()) info.name = phoneName.trim().slice(0, 100)
    return true
  }

  /** 桌面完成密钥派生后标记已确认；桌面重连时只补发尚未确认的配对。 */
  markPhonePaired(roomId, phoneToken) {
    const room = this.rooms.get(roomId)
    const info = room?.phones.get(phoneToken)
    if (!info) return false
    info.pairedAt = Date.now()
    return true
  }

  listPendingPairings(roomId) {
    const room = this.rooms.get(roomId)
    if (!room) return []
    return [...room.phones.entries()]
      .filter(([, info]) => info.phonePub && !info.pairedAt)
      .map(([phoneToken, info]) => ({
        phoneToken,
        phonePub: info.phonePub,
        phoneName: info.name
      }))
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
