import { getDb } from '../db'
import type { ContentBlock } from '../../shared/types'
import {
  createWikiPage,
  sanitizeWikiPage,
  searchKnowledgeDualList,
  upsertWikiSection,
  type OriginalMessageSnippet,
  type WikiPage,
  type WikiPageKind
} from './wiki'
import { extractWikiCandidates } from './extractor'
import { setWikiIndex, type WikiIndexEntry } from './memoryNote'

/**
 * Personal Wiki 的 SQLite 持久化 + 原始对话精确榜。
 *
 * 设计约束：
 * - 所有写入都经由 wiki.ts 的纯函数生成 Change Log（时间/摘要由代码给，模型不可伪造）；
 * - 原始消息榜只做参数化 LIKE + 内存截取，不做全盘遍历、不加 Embedding 依赖；
 * - 只被工具调用与后台异步提取调用，用户发消息的关键路径上不会碰这里。
 */

interface WikiRow {
  id: string
  kind: string
  title: string
  sections: string
  links: string
  changes: string
  updated_at: number
}

function parseJson<T>(raw: string, fallback: T): T {
  try {
    return JSON.parse(raw) as T
  } catch {
    return fallback
  }
}

function rowToPage(row: WikiRow): WikiPage {
  return {
    id: row.id,
    kind: row.kind as WikiPageKind,
    title: row.title,
    sections: parseJson<WikiPage['sections']>(row.sections, []),
    links: parseJson<string[]>(row.links, []),
    changes: parseJson<WikiPage['changes']>(row.changes, []),
    updatedAt: row.updated_at
  }
}

export function listWikiPages(kind?: WikiPageKind): WikiPage[] {
  const rows = kind
    ? (getDb().prepare('SELECT * FROM wiki_pages WHERE kind = ? ORDER BY updated_at DESC').all(kind) as WikiRow[])
    : (getDb().prepare('SELECT * FROM wiki_pages ORDER BY updated_at DESC').all() as WikiRow[])
  return rows.map(rowToPage)
}

export function getWikiPage(id: string): WikiPage | null {
  const row = getDb().prepare('SELECT * FROM wiki_pages WHERE id = ?').get(id) as WikiRow | undefined
  return row ? rowToPage(row) : null
}

export interface WikiUpsertInput {
  kind: WikiPageKind
  title: string
  section: string
  body: string
  reason?: string
  links?: string[]
}

/** Section 级写入：同名 section 覆盖并记 reason；新页由 createWikiPage 生成首条日志。 */
export function upsertWikiPage(input: WikiUpsertInput, now = Date.now()): WikiPage {
  const seed = createWikiPage(input.kind, input.title, now)
  const base = getWikiPage(seed.id) ?? seed
  let page = upsertWikiSection(base, input.section, input.body, input.reason, now)
  if (input.links?.length) {
    page = {
      ...page,
      links: [...new Set([...page.links, ...input.links.filter((id) => id && id !== page.id)])],
      updatedAt: now
    }
  }
  page = sanitizeWikiPage(page)
  getDb()
    .prepare(
      `INSERT INTO wiki_pages (id, kind, title, sections, links, changes, updated_at)
       VALUES (@id, @kind, @title, @sections, @links, @changes, @updated_at)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         sections = excluded.sections,
         links = excluded.links,
         changes = excluded.changes,
         updated_at = excluded.updated_at`
    )
    .run({
      id: page.id,
      kind: page.kind,
      title: page.title,
      sections: JSON.stringify(page.sections),
      links: JSON.stringify(page.links),
      changes: JSON.stringify(page.changes),
      updated_at: page.updatedAt
    })
  return page
}

/** 供首条 user 消息注入的轻量索引；同时刷新进程内缓存。 */
export function refreshWikiIndexCache(limit = 50): WikiIndexEntry[] {
  const rows = getDb()
    .prepare('SELECT id, kind, title, updated_at FROM wiki_pages ORDER BY updated_at DESC LIMIT ?')
    .all(limit) as { id: string; kind: string; title: string; updated_at: number }[]
  const entries: WikiIndexEntry[] = rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    title: r.title,
    updatedAt: r.updated_at
  }))
  setWikiIndex(entries)
  return entries
}

function plainTextOfBlocks(raw: string): string {
  let blocks: ContentBlock[]
  try {
    blocks = JSON.parse(raw) as ContentBlock[]
  } catch {
    return raw
  }
  if (!Array.isArray(blocks)) return ''
  return blocks
    .map((b) => {
      if (b.type === 'text' || b.type === 'reasoning') return b.text
      if (b.type === 'tool_result') return b.content
      return ''
    })
    .filter(Boolean)
    .join('\n')
}

function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, '\\$&')
}

/** SQL 侧先过滤，再在内存里截取命中词前后 120 字符；单表上限 200 行，绝不拖慢主路径。 */
export function searchOriginalMessages(queries: string[], maxRows = 200): OriginalMessageSnippet[] {
  const terms = [...new Set(
    queries
      .flatMap((q) => q.toLowerCase().split(/\s+/))
      .map((t) => t.trim())
      .filter((t) => t.length > 0)
  )].slice(0, 24)
  if (terms.length === 0) return []

  const clause = terms.map(() => `LOWER(blocks) LIKE ? ESCAPE '\\'`).join(' OR ')
  const params = terms.map((t) => `%${escapeLike(t)}%`)
  const rows = getDb()
    .prepare(
      `SELECT id, conversation_id, role, blocks, created_at FROM messages
       WHERE ${clause} ORDER BY created_at DESC LIMIT ?`
    )
    .all(...params, maxRows) as {
    id: string
    conversation_id: string
    role: string
    blocks: string
    created_at: number
  }[]

  const out: OriginalMessageSnippet[] = []
  for (const row of rows) {
    const plain = plainTextOfBlocks(row.blocks)
    const lower = plain.toLowerCase()
    const matched = terms.filter((t) => lower.includes(t))
    if (matched.length === 0) continue
    const pos = Math.max(0, lower.indexOf(matched[0]))
    const start = Math.max(0, pos - 120)
    const end = Math.min(plain.length, pos + matched[0].length + 120)
    const text = `${start > 0 ? '…' : ''}${plain.slice(start, end)}${end < plain.length ? '…' : ''}`
    out.push({
      messageId: row.id,
      conversationId: row.conversation_id,
      role: row.role,
      text,
      createdAt: row.created_at,
      matchedTerms: matched
    })
  }
  return out
}

export interface WikiSearchParams {
  query: string
  alternateQueries?: string[]
  kind?: WikiPageKind
  limit?: number
}

/** 双榜检索的可序列化结果：Wiki 概览榜 + 原始对话精确榜。 */
export function searchKnowledge(params: WikiSearchParams): {
  queries: string[]
  wikiOverviews: Array<{
    id: string
    kind: WikiPageKind
    title: string
    rank: number
    score: number
    sections: Array<{ title: string; body: string }>
    updatedAt: number
  }>
  originalMessages: Array<OriginalMessageSnippet & { rank: number; score: number }>
} {
  const queries = [params.query, ...(params.alternateQueries ?? [])]
    .map((q) => (q ?? '').trim())
    .filter(Boolean)
    .slice(0, 7)
  const result = searchKnowledgeDualList({
    pages: listWikiPages(params.kind),
    snippets: searchOriginalMessages(queries),
    query: params.query,
    alternateQueries: params.alternateQueries,
    kind: params.kind,
    limit: params.limit
  })
  return {
    queries: result.queries,
    wikiOverviews: result.wikiOverviews.map((e) => ({
      id: e.page.id,
      kind: e.page.kind,
      title: e.page.title,
      rank: e.rank,
      score: Number(e.score.toFixed(6)),
      sections: e.page.sections.map((s) => ({ title: s.title, body: s.body.slice(0, 600) })),
      updatedAt: e.page.updatedAt
    })),
    originalMessages: result.originalMessages.map((e) => ({
      ...e.snippet,
      rank: e.rank,
      score: Number(e.score.toFixed(6))
    }))
  }
}

/** 后台异步提取入口：从一轮对话里提结构化候选并落库，返回写入的实体数。 */
export function extractWikiAndMemory(userText: string, assistantText: string): number {
  const candidates = extractWikiCandidates(`${userText}\n${assistantText}`)
  for (const c of candidates) {
    upsertWikiPage({
      kind: c.kind,
      title: c.title,
      section: c.section,
      body: c.body,
      reason: c.reason
    })
  }
  if (candidates.length > 0) refreshWikiIndexCache()
  return candidates.length
}
