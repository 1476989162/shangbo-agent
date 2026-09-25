import { randomUUID } from 'node:crypto'
import { getDb } from './index'
import type {
  ContentBlock,
  Conversation,
  Message,
  MessageStatus,
  Role,
  Usage
} from '../../shared/types'

/* ------------------------------------------------------------------ */
/* 行映射                                                              */
/* ------------------------------------------------------------------ */

interface ConversationRow {
  id: string
  title: string
  project_id: string | null
  provider_id: string | null
  model: string | null
  system_prompt: string | null
  created_at: number
  updated_at: number
  archived_at: number | null
}

interface MessageRow {
  id: string
  conversation_id: string
  parent_id: string | null
  role: string
  blocks: string
  status: string
  error: string | null
  provider_id: string | null
  model: string | null
  usage: string | null
  created_at: number
  updated_at: number
}

function toConversation(row: ConversationRow): Conversation {
  return {
    id: row.id,
    title: row.title,
    projectId: row.project_id,
    providerId: row.provider_id,
    model: row.model,
    systemPrompt: row.system_prompt,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at
  }
}

function toMessage(row: MessageRow): Message {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    parentId: row.parent_id,
    role: row.role as Role,
    blocks: JSON.parse(row.blocks) as ContentBlock[],
    status: row.status as MessageStatus,
    error: row.error,
    providerId: row.provider_id,
    model: row.model,
    usage: row.usage ? (JSON.parse(row.usage) as Usage) : null,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

/* ------------------------------------------------------------------ */
/* 会话                                                                */
/* ------------------------------------------------------------------ */

export function listConversations(): Conversation[] {
  const rows = getDb()
    .prepare(
      `SELECT * FROM conversations
       WHERE archived_at IS NULL
       ORDER BY updated_at DESC`
    )
    .all() as ConversationRow[]
  return rows.map(toConversation)
}

export function getConversation(id: string): Conversation | null {
  const row = getDb().prepare('SELECT * FROM conversations WHERE id = ?').get(id) as
    | ConversationRow
    | undefined
  return row ? toConversation(row) : null
}

export function createConversation(input?: Partial<Conversation>): Conversation {
  const now = Date.now()
  const id = input?.id ?? randomUUID()
  getDb()
    .prepare(
      `INSERT INTO conversations
         (id, title, project_id, provider_id, model, system_prompt, created_at, updated_at)
       VALUES (@id, @title, @projectId, @providerId, @model, @systemPrompt, @createdAt, @updatedAt)`
    )
    .run({
      id,
      title: input?.title ?? '新对话',
      projectId: input?.projectId ?? null,
      providerId: input?.providerId ?? null,
      model: input?.model ?? null,
      systemPrompt: input?.systemPrompt ?? null,
      createdAt: now,
      updatedAt: now
    })
  getDb()
    .prepare('INSERT OR IGNORE INTO conversation_state (conversation_id, active_leaf_id) VALUES (?, NULL)')
    .run(id)
  return getConversation(id)!
}

export function updateConversation(
  id: string,
  patch: Partial<Pick<Conversation, 'title' | 'providerId' | 'model' | 'systemPrompt'>>
): void {
  const current = getConversation(id)
  if (!current) return
  getDb()
    .prepare(
      `UPDATE conversations
       SET title = @title, provider_id = @providerId, model = @model,
           system_prompt = @systemPrompt, updated_at = @updatedAt
       WHERE id = @id`
    )
    .run({
      id,
      title: patch.title ?? current.title,
      providerId: patch.providerId ?? current.providerId,
      model: patch.model ?? current.model,
      systemPrompt: patch.systemPrompt ?? current.systemPrompt,
      updatedAt: Date.now()
    })
}

/** 首次产生对话内容时用首条用户消息生成标题，之后不再自动覆盖。 */
export function touchConversation(id: string): void {
  getDb().prepare('UPDATE conversations SET updated_at = ? WHERE id = ?').run(Date.now(), id)
}

export function deleteConversation(id: string): void {
  // messages / conversation_state 由外键级联清理
  getDb().prepare('DELETE FROM conversations WHERE id = ?').run(id)
}

export function setActiveLeaf(conversationId: string, leafId: string | null): void {
  getDb()
    .prepare(
      `INSERT INTO conversation_state (conversation_id, active_leaf_id) VALUES (?, ?)
       ON CONFLICT(conversation_id) DO UPDATE SET active_leaf_id = excluded.active_leaf_id`
    )
    .run(conversationId, leafId)
}

export function getActiveLeaf(conversationId: string): string | null {
  const row = getDb()
    .prepare('SELECT active_leaf_id FROM conversation_state WHERE conversation_id = ?')
    .get(conversationId) as { active_leaf_id: string | null } | undefined
  return row?.active_leaf_id ?? null
}

/* ------------------------------------------------------------------ */
/* 消息树                                                              */
/* ------------------------------------------------------------------ */

export function getMessage(id: string): Message | null {
  const row = getDb().prepare('SELECT * FROM messages WHERE id = ?').get(id) as
    | MessageRow
    | undefined
  return row ? toMessage(row) : null
}

export function listMessages(conversationId: string): Message[] {
  const rows = getDb()
    .prepare('SELECT * FROM messages WHERE conversation_id = ? ORDER BY created_at ASC')
    .all(conversationId) as MessageRow[]
  return rows.map(toMessage)
}

export function listChildren(messageId: string): Message[] {
  const rows = getDb()
    .prepare('SELECT * FROM messages WHERE parent_id = ? ORDER BY created_at ASC')
    .all(messageId) as MessageRow[]
  return rows.map(toMessage)
}

export function insertMessage(input: {
  id?: string
  conversationId: string
  parentId: string | null
  role: Role
  blocks?: ContentBlock[]
  status?: MessageStatus
  providerId?: string | null
  model?: string | null
  usage?: Usage | null
}): Message {
  const now = Date.now()
  const id = input.id ?? randomUUID()
  getDb()
    .prepare(
      `INSERT INTO messages
         (id, conversation_id, parent_id, role, blocks, status, provider_id, model, usage, created_at, updated_at)
       VALUES (@id, @conversationId, @parentId, @role, @blocks, @status, @providerId, @model, @usage, @createdAt, @updatedAt)`
    )
    .run({
      id,
      conversationId: input.conversationId,
      parentId: input.parentId,
      role: input.role,
      blocks: JSON.stringify(input.blocks ?? []),
      status: input.status ?? 'done',
      providerId: input.providerId ?? null,
      model: input.model ?? null,
      usage: input.usage ? JSON.stringify(input.usage) : null,
      createdAt: now,
      updatedAt: now
    })
  return getMessage(id)!
}

export function updateMessage(
  id: string,
  patch: Partial<{
    blocks: ContentBlock[]
    status: MessageStatus
    error: string | null
    usage: Usage | null
    model: string | null
    providerId: string | null
  }>
): void {
  const current = getMessage(id)
  if (!current) return
  getDb()
    .prepare(
      `UPDATE messages
       SET blocks = @blocks, status = @status, error = @error,
           usage = @usage, model = @model, provider_id = @providerId, updated_at = @updatedAt
       WHERE id = @id`
    )
    .run({
      id,
      blocks: JSON.stringify(patch.blocks ?? current.blocks),
      status: patch.status ?? current.status,
      error: patch.error === undefined ? current.error : patch.error,
      usage:
        patch.usage === undefined
          ? current.usage
            ? JSON.stringify(current.usage)
            : null
          : patch.usage
            ? JSON.stringify(patch.usage)
            : null,
      model: patch.model ?? current.model,
      providerId: patch.providerId ?? current.providerId,
      updatedAt: Date.now()
    })
}

/** 删除该消息及其整条子树（分支删除语义）。 */
export function deleteSubtree(messageId: string): void {
  const db = getDb()
  const collect = db.prepare('SELECT id FROM messages WHERE parent_id = ?')
  const remove = db.prepare('DELETE FROM messages WHERE id = ?')

  const walk = (id: string): void => {
    const children = collect.all(id) as { id: string }[]
    for (const child of children) walk(child.id)
    remove.run(id)
  }

  db.transaction(() => walk(messageId))()
}

/**
 * 从指定消息沿 parent_id 回溯到根，得到当前激活分支的完整链路（时间正序）。
 * 每次都从 active_leaf 回溯，因此切换分支无需重写任何消息。
 */
export function getActivePath(conversationId: string): Message[] {
  const leafId = getActiveLeaf(conversationId)
  if (!leafId) return []

  const byId = new Map(listMessages(conversationId).map((m) => [m.id, m]))
  const path: Message[] = []
  let cursor: string | null = leafId

  while (cursor) {
    const message: Message | undefined = byId.get(cursor)
    if (!message) break
    path.push(message)
    cursor = message.parentId
  }

  return path.reverse()
}