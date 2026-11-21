import { describe, expect, it } from 'vitest'
import {
  createWikiPage,
  linkWikiPages,
  renderWikiPage,
  sanitizeWikiPage,
  searchKnowledgeDualList,
  searchWiki,
  upsertWikiSection,
  WIKI_MAX_CHANGES,
  WIKI_SECTION_BODY_MAX_CHARS,
  type OriginalMessageSnippet
} from './wiki'

describe('Wiki 记忆：typed pages + section 改写 + 检索', () => {
  it('建页 → 改写记 reason → 检索命中 → 渲染含 Change Log', () => {
    let page = createWikiPage('project', 'Acme rollout')
    page = upsertWikiSection(page, 'Pricing', '报价 4.8 万，200 席')
    page = upsertWikiSection(page, 'Pricing', '报价 5.2 万，200 席，已确认', '客户邮件确认涨价')
    expect(page.sections.length).toBe(1)
    expect(page.changes.length).toBeGreaterThanOrEqual(3)

    const other = createWikiPage('client', 'Acme')
    const linked = linkWikiPages(page, other.id)
    expect(linked.links).toContain(other.id)

    const hits = searchWiki([linked, other], 'Acme 报价')
    expect(hits[0].id).toBe(linked.id)

    const md = renderWikiPage(linked)
    expect(md).toContain('Acme rollout')
    expect(md).toContain('Change Log')
  })

  it('空查询返回空', () => {
    const page = createWikiPage('topic', 'Pricing')
    expect(searchWiki([page], '   ')).toEqual([])
  })
})

describe('Wiki 双榜 RRF 检索（Stage 1）', () => {
  const now = 1_700_000_000_000
  const pages = [
    upsertWikiSection(createWikiPage('project', 'Acme rollout', now), '报价', '报价 5.2 万，200 席', '客户确认', now),
    upsertWikiSection(createWikiPage('client', 'Acme', now + 1), '联系人', '王经理', undefined, now + 1),
    upsertWikiSection(createWikiPage('topic', 'Pricing', now + 2), '规则', '折扣需审批', undefined, now + 2)
  ]
  const snippets: OriginalMessageSnippet[] = [
    { messageId: 'm1', conversationId: 'c1', role: 'user', text: 'Acme 报价 5.2 万请确认', createdAt: now + 10 },
    { messageId: 'm2', conversationId: 'c1', role: 'assistant', text: 'Acme pricing 已确认', createdAt: now + 20 },
    { messageId: 'm3', conversationId: 'c2', role: 'user', text: '无关的聊天记录', createdAt: now + 30 }
  ]

  it('主查询 + 别名各自成榜并融合，返回概览榜与原始消息榜', () => {
    const result = searchKnowledgeDualList({
      pages,
      snippets,
      query: 'Acme 报价',
      alternateQueries: ['Acme pricing', '报价'],
      limit: 5
    })
    expect(result.queries).toEqual(['Acme 报价', 'Acme pricing', '报价'])
    expect(result.wikiOverviews.length).toBeGreaterThan(0)
    expect(result.wikiOverviews[0].rank).toBe(1)
    expect(result.wikiOverviews[0].score).toBeGreaterThan(0)
    expect(result.originalMessages.map((m) => m.snippet.messageId)).not.toContain('m3')
    expect(result.originalMessages.every((m, i, all) => i === 0 || all[i - 1].score >= m.score)).toBe(true)
  })

  it('别名最多 6 个，kind 过滤生效，空查询返回空双榜', () => {
    const many = Array.from({ length: 10 }, (_, i) => `alias-${i}`)
    const result = searchKnowledgeDualList({ pages, snippets, query: 'Acme', alternateQueries: many })
    expect(result.queries.length).toBeLessThanOrEqual(7)
    const onlyClients = searchKnowledgeDualList({ pages, snippets, query: 'Acme', kind: 'client' })
    expect(onlyClients.wikiOverviews.every((r) => r.page.kind === 'client')).toBe(true)
    const empty = searchKnowledgeDualList({ pages, snippets, query: '   ' })
    expect(empty.wikiOverviews).toEqual([])
    expect(empty.originalMessages).toEqual([])
  })

  it('落库清洗：Section 正文截断 3000、Change Log 只留最近 20 条', () => {
    let page = createWikiPage('topic', 'Long', now)
    for (let i = 0; i < 30; i++) {
      page = upsertWikiSection(page, `s${i}`, 'x'.repeat(4_000), undefined, now + i)
    }
    const clean = sanitizeWikiPage(page)
    expect(clean.sections.every((s) => s.body.length <= WIKI_SECTION_BODY_MAX_CHARS)).toBe(true)
    expect(clean.changes.length).toBe(WIKI_MAX_CHANGES)
    expect(page.changes.length).toBe(WIKI_MAX_CHANGES)
  })
})
