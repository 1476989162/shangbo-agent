/**
 * Wiki 记忆（lite）：受 linger Wiki-and-memory 启发。
 *
 * linger 语义：clients / contacts / projects / topics 每类真实实体一页一 home，
 * 会议另起 Session 页并链接相关实体；每晚模型按 section 提改写（add / rewrite+reason /
 * close-item），带 Change Log；任意 agent 都能搜到（tell once, every agent knows）。
 *
 * 本模块是纯函数内核：页面建模 + section 级 upsert + 关键词检索 + markdown 渲染。
 * 持久化由调用方决定（DB/文件均可），此处不碰 electron/db，保证可单测。
 */

/** linger 规范：单个 Section 正文上限、Change Log 保留条数、同义词上限与 RRF 常数。 */
export const WIKI_SECTION_BODY_MAX_CHARS = 3_000
export const WIKI_MAX_CHANGES = 20
export const WIKI_MAX_ALTERNATE_QUERIES = 6
export const WIKI_RRF_K = 60

export type WikiPageKind = 'client' | 'contact' | 'project' | 'topic' | 'session'

export interface WikiSection {
  title: string
  body: string
}

export interface WikiChange {
  at: number
  summary: string
  reason?: string
}

export interface WikiPage {
  id: string
  kind: WikiPageKind
  title: string
  sections: WikiSection[]
  links: string[]
  changes: WikiChange[]
  updatedAt: number
}

export function createWikiPage(kind: WikiPageKind, title: string, now = Date.now()): WikiPage {
  const safe = title.trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '') || 'untitled'
  return {
    id: `${kind}:${safe}`,
    kind,
    title: title.trim(),
    sections: [],
    links: [],
    changes: [{ at: now, summary: `创建${kind}页《${title.trim()}》` }],
    updatedAt: now
  }
}

/**
 * section 级 upsert：同名 section 覆盖并记 reason；新 section 追加。
 * 返回新页面（不改入参）。
 */
export function upsertWikiSection(
  page: WikiPage,
  sectionTitle: string,
  body: string,
  reason?: string,
  now = Date.now()
): WikiPage {
  const title = sectionTitle.trim()
  const idx = page.sections.findIndex((s) => s.title === title)
  const sections = page.sections.map((s) => ({ ...s }))
  let summary: string
  if (idx >= 0) {
    sections[idx] = { title, body }
    summary = `改写「${title}」${reason ? `：${reason}` : ''}`
  } else {
    sections.push({ title, body })
    summary = `新增「${title}」`
  }
  return {
    ...page,
    sections,
    changes: [...page.changes, { at: now, summary, reason }].slice(-WIKI_MAX_CHANGES),
    updatedAt: now
  }
}

/** 双向链接：去重追加。 */
export function linkWikiPages(a: WikiPage, bId: string): WikiPage {
  if (a.id === bId || a.links.includes(bId)) return a
  return { ...a, links: [...a.links, bId], updatedAt: Date.now() }
}

/**
 * 关键词检索：标题命中权重最高，section 标题其次，正文最后。
 * 返回按分排序的页面（分>0 才返回）。
 */
export function searchWiki(pages: WikiPage[], query: string, limit = 5): WikiPage[] {
  const q = query.trim().toLowerCase()
  if (!q) return []
  const terms = q.split(/\s+/).filter(Boolean)
  const scored = pages
    .map((p) => {
      const title = p.title.toLowerCase()
      const secTitles = p.sections.map((s) => s.title.toLowerCase()).join('\n')
      const bodies = p.sections.map((s) => s.body.toLowerCase()).join('\n')
      let score = 0
      for (const t of terms) {
        if (title.includes(t)) score += 3
        if (secTitles.includes(t)) score += 2
        if (bodies.includes(t)) score += 1
      }
      return { p, score }
    })
    .filter((s) => s.score > 0)
    .sort((x, y) => y.score - x.score || y.p.updatedAt - x.p.updatedAt)
  return scored.slice(0, Math.max(1, limit)).map((s) => s.p)
}

/** 渲染单页为 Markdown（含 Change Log 尾部）。 */
export function renderWikiPage(page: WikiPage): string {
  const lines = [`# ${page.title}`, ``, `> kind: ${page.kind} · id: ${page.id}`, ``]
  for (const s of page.sections) {
    lines.push(`## ${s.title}`, ``, s.body.trim(), ``)
  }
  if (page.links.length > 0) {
    lines.push(`## 关联`, ``, page.links.map((l) => `- ${l}`).join('\n'), ``)
  }
  if (page.changes.length > 0) {
    lines.push(
      `## Change Log`,
      ``,
      page.changes
        .slice(-10)
        .map((c) => `- ${new Date(c.at).toLocaleString()} ${c.summary}`)
        .join('\n'),
      ``
    )
  }
  return lines.join('\n')
}

/**
 * 落库前统一清洗：Section 正文截断、Change Log 只保留最近 20 条、链接去重。
 * Change Log 的 at / summary 一律由 createWikiPage / upsertWikiSection 生成，
 * 工具入参不接受 changes 字段，模型无法伪造历史日志。
 */
export function sanitizeWikiPage(page: WikiPage): WikiPage {
  return {
    ...page,
    title: page.title.trim().slice(0, 200),
    sections: page.sections.map((s) => ({
      title: s.title.trim().slice(0, 120),
      body: s.body.slice(0, WIKI_SECTION_BODY_MAX_CHARS)
    })),
    links: [...new Set(page.links)].slice(-50),
    changes: page.changes.slice(-WIKI_MAX_CHANGES),
    updatedAt: page.updatedAt
  }
}

/** 原始对话片段：由 wikiRepo 从 messages 表检索并截取匹配词前后 120 字符。 */
export interface OriginalMessageSnippet {
  messageId: string
  conversationId: string
  role: string
  text: string
  createdAt: number
  matchedTerms?: string[]
}

export interface RankedWikiPage {
  page: WikiPage
  score: number
  rank: number
}
export interface RankedSnippet {
  snippet: OriginalMessageSnippet
  score: number
  rank: number
}
export interface DualListSearchInput {
  pages: WikiPage[]
  snippets: OriginalMessageSnippet[]
  query: string
  /** 最多 6 个中英同义词 / 别名，每个别名单独成榜参与融合。 */
  alternateQueries?: string[]
  kind?: WikiPageKind
  limit?: number
}
export interface DualListSearchResult {
  queries: string[]
  wikiOverviews: RankedWikiPage[]
  originalMessages: RankedSnippet[]
}

interface Fused<T> {
  item: T
  score: number
  rank: number
}

/** Reciprocal Rank Fusion：score(d) = Σ_q 1 / (K + rank_q(d))，K = 60。 */
function fuse<T>(
  lists: T[][],
  keyOf: (item: T) => string,
  limit: number,
  tieBreak: (a: T, b: T) => number
): Fused<T>[] {
  const scores = new Map<string, { item: T; score: number }>()
  for (const list of lists) {
    list.forEach((item, index) => {
      const key = keyOf(item)
      const gain = 1 / (WIKI_RRF_K + index + 1)
      const current = scores.get(key)
      if (current) current.score += gain
      else scores.set(key, { item, score: gain })
    })
  }
  return [...scores.values()]
    .sort((a, b) => b.score - a.score || tieBreak(a.item, b.item))
    .slice(0, Math.max(1, limit))
    .map((entry, index) => ({ item: entry.item, score: entry.score, rank: index + 1 }))
}

function normalizedQueries(query: string, alternates?: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const raw of [query, ...(alternates ?? []).slice(0, WIKI_MAX_ALTERNATE_QUERIES)]) {
    const q = (raw ?? '').trim()
    const key = q.toLowerCase()
    if (!q || seen.has(key)) continue
    seen.add(key)
    out.push(q)
  }
  return out
}

/**
 * 双榜检索（纯函数，持久化与 DB 由调用方负责）：
 * ① Wiki 实体概览榜：每个 query / 别名各跑一次 searchWiki，RRF 融合；
 * ② 历史消息精确榜：按命中词频成榜，再叠加一条「时间邻近度」榜单做 RRF 融合。
 * 两榜互不干扰，模型可分别取用：概览看实体全貌，精确榜回看原始措辞。
 */
export function searchKnowledgeDualList(input: DualListSearchInput): DualListSearchResult {
  const queries = normalizedQueries(input.query, input.alternateQueries)
  if (queries.length === 0) {
    return { queries: [], wikiOverviews: [], originalMessages: [] }
  }
  const limit = Math.max(1, input.limit ?? 5)
  const pages = input.kind ? input.pages.filter((p) => p.kind === input.kind) : input.pages
  const pool = Math.max(20, pages.length)

  const wikiLists = queries.map((q) => searchWiki(pages, q, pool))
  const wikiOverviews: RankedWikiPage[] = fuse(
    wikiLists,
    (p) => p.id,
    limit,
    (a, b) => b.updatedAt - a.updatedAt
  ).map((e) => ({ page: e.item, score: e.score, rank: e.rank }))

  const matched = new Map<string, OriginalMessageSnippet>()
  const snippetLists = queries.map((q) => {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean)
    return input.snippets
      .map((s) => {
        const lower = s.text.toLowerCase()
        const hits = terms.reduce((n, t) => (lower.includes(t) ? n + 1 : n), 0)
        return { snippet: s, hits }
      })
      .filter((x) => x.hits > 0)
      .sort((a, b) => b.hits - a.hits || b.snippet.createdAt - a.snippet.createdAt)
      .map((x) => {
        matched.set(x.snippet.messageId, x.snippet)
        return x.snippet
      })
  })
  const byRecency = [...matched.values()].sort((a, b) => b.createdAt - a.createdAt)
  const originalMessages: RankedSnippet[] = fuse(
    [...snippetLists, byRecency],
    (s) => s.messageId,
    limit,
    (a, b) => b.createdAt - a.createdAt
  ).map((e) => ({ snippet: e.item, score: e.score, rank: e.rank }))

  return { queries, wikiOverviews, originalMessages }
}
