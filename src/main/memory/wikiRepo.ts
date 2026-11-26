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

function escapeFtsPhrase(term: string): string | null {
  // FTS5 短语查询：双引号包裹，内部双引号加倍；至少含一个字母或数字才有意义
  if (!/[\p{L}\p{N}]/u.test(term)) return null;
  return `"${term.replace(/"/g, '""')}"`;
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

  // FTS 短语（trigram 索引只含纯文本）+ 短词 LIKE 回退，双路 OR 召回
  const ftsTerms: string[] = []
  const likeTerms: string[] = []
  for (const term of terms) {
    const phrase = escapeFtsPhrase(term)
    if (phrase !== null && [...term].length >= 3) ftsTerms.push(phrase)
    else likeTerms.push(term)
  }

  const branches: string[] = []
  const params: unknown[] = []
  if (ftsTerms.length > 0) {
    // MATCH 必须独占一个 UNION 分支才能作为 FTS 驱动约束：
    // 与同表的 LIKE 直接 OR 会报 "unable to use function MATCH"
    branches.push('SELECT rowid AS rid FROM messages_fts WHERE messages_fts MATCH ?')
    params.push(ftsTerms.join(' OR '))
  }
  for (const term of likeTerms) {
    branches.push("SELECT rowid AS rid FROM messages_fts WHERE messages_fts.plain_text LIKE ? ESCAPE '\\'")
    params.push(`%${escapeLike(term)}%`)
  }

  const rows = getDb()
    .prepare(
      `SELECT m.id AS id, m.conversation_id AS conversationId, m.role AS role,
              m.blocks AS blocks, m.created_at AS createdAt
       FROM (${branches.join(' UNION ')}) AS hit
       JOIN messages AS m ON m.rowid = hit.rid
       ORDER BY m.created_at DESC LIMIT ?`
    )
    .all(...params, maxRows) as {
    id: string
    conversationId: string
    role: string
    blocks: string
    createdAt: number
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
      conversationId: row.conversationId,
      role: row.role,
      text,
      createdAt: row.createdAt,
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

/** 后台异步提取入口：提取一批攒满的回合（默认 5 轮），返回写入的实体数。 */
export function extractWikiAndMemoryBatch(
  turns: Array<{ userText: string; assistantText: string }>
): number {
  const nonEmpty = turns.filter((t) => t.userText.trim() || t.assistantText.trim())
  if (nonEmpty.length === 0) return 0
  const candidates = extractWikiCandidates(
    nonEmpty.map((t) => `${t.userText}\n${t.assistantText}`.trim()).join('\n\n')
  )
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

/** 后台异步提取入口：从一轮对话里提结构化候选并落库，返回写入的实体数。 */
export function extractWikiAndMemory(userText: string, assistantText: string): number {
  return extractWikiAndMemoryBatch([{ userText, assistantText }])
}
