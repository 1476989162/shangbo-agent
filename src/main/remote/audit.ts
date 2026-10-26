import { randomUUID } from 'node:crypto'
import { getDb } from '../db'

/** 阶段3：远程审计日志——每次远程审批与远程发消息都记一条（只记元数据，不记密钥）。 */

export type RemoteAuditKind =
  | 'remote.approve'
  | 'remote.reject'
  | 'remote.send'
  | 'remote.pair'
  | 'remote.revoke'
  | 'remote.ban'
  | 'remote.disconnect'

export function appendRemoteAudit(kind: RemoteAuditKind, detail: string): void {
  try {
    getDb()
      .prepare('INSERT INTO remote_audit (id, kind, detail, created_at) VALUES (?, ?, ?, ?)')
      .run(randomUUID(), kind, detail.slice(0, 2000), Date.now())
  } catch {
    // 审计写入失败不阻塞主流程
  }
}

export function listRemoteAudit(limit = 100): { id: string; kind: string; detail: string; createdAt: number }[] {
  const rows = getDb()
    .prepare('SELECT * FROM remote_audit ORDER BY created_at DESC LIMIT ?')
    .all(Math.max(1, Math.min(limit, 500))) as {
    id: string
    kind: string
    detail: string
    created_at: number
  }[]
  return rows.map((r) => ({ id: r.id, kind: r.kind, detail: r.detail, createdAt: r.created_at }))
}
