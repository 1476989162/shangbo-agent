import { randomUUID } from 'node:crypto'
import log from 'electron-log/main'
import { getDb } from '../db'

/**
 * 阶段3：已配对设备表（新增 v4 迁移，不改已有迁移）。
 * 设备密钥与令牌走 secrets.ts（safeStorage 加密），DB 只存元数据。
 */

export interface PairedDevice {
  id: string
  name: string
  phonePublicKey: string // base64url，配对时手机公钥
  createdAt: number
  lastSeenAt: number | null
  revokedAt: number | null
}

export function listPairedDevices(includeRevoked = false): PairedDevice[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM remote_devices ${includeRevoked ? '' : 'WHERE revoked_at IS NULL'} ORDER BY created_at DESC`
    )
    .all() as {
    id: string
    name: string
    phone_public_key: string
    created_at: number
    last_seen_at: number | null
    revoked_at: number | null
  }[]
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    phonePublicKey: r.phone_public_key,
    createdAt: r.created_at,
    lastSeenAt: r.last_seen_at,
    revokedAt: r.revoked_at
  }))
}

export function addPairedDevice(name: string, phonePublicKey: string): PairedDevice {
  const id = randomUUID()
  const now = Date.now()
  getDb()
    .prepare(
      `INSERT INTO remote_devices (id, name, phone_public_key, created_at, last_seen_at, revoked_at)
       VALUES (?, ?, ?, ?, NULL, NULL)`
    )
    .run(id, name.slice(0, 100) || '未命名手机', phonePublicKey, now)
  return { id, name: name.slice(0, 100), phonePublicKey, createdAt: now, lastSeenAt: null, revokedAt: null }
}

export function touchDeviceSeen(id: string): void {
  try {
    getDb().prepare('UPDATE remote_devices SET last_seen_at = ? WHERE id = ?').run(Date.now(), id)
  } catch (error) {
    log.warn('[remote] 更新设备在线时间失败', error)
  }
}

export function revokePairedDevice(id: string): boolean {
  const result = getDb()
    .prepare('UPDATE remote_devices SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
    .run(Date.now(), id)
  return result.changes > 0
}

export function getPairedDevice(id: string): PairedDevice | null {
  const row = getDb().prepare('SELECT * FROM remote_devices WHERE id = ?').get(id) as
    | {
        id: string
        name: string
        phone_public_key: string
        created_at: number
        last_seen_at: number | null
        revoked_at: number | null
      }
    | undefined
  if (!row) return null
  return {
    id: row.id,
    name: row.name,
    phonePublicKey: row.phone_public_key,
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    revokedAt: row.revoked_at
  }
}
