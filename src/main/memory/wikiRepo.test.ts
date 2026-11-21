import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/* 真实 SQLite 上验证 v8 迁移、Wiki 落库、双榜检索与后台提取。
   electron userData 用独立临时目录，绝不碰真实用户库。 */
let userDataDir = ''

vi.mock('electron', () => ({
  app: { getPath: () => process.env['WIKI_REPO_TEST_USER_DATA'] ?? tmpdir() }
}))

vi.mock('electron-log/main', () => ({
  default: { info: () => {}, warn: () => {}, error: () => {} }
}))

beforeAll(() => {
  userDataDir = mkdtempSync(join(tmpdir(), 'shangbo-wiki-test-'))
  process.env['WIKI_REPO_TEST_USER_DATA'] = userDataDir
})

afterAll(() => {
  closeDatabase()
  rmSync(userDataDir, { recursive: true, force: true })
})

import { closeDatabase, getDb } from '../db'
import * as repo from '../db/repo'
import * as wikiRepo from './wikiRepo'
import { getWikiIndex } from './memoryNote'

describe('wikiRepo：v8 迁移 + SQLite 持久化', () => {
  it('迁移 version 8 已应用，5 张新表都在', () => {
    getDb()
    const tables = (
      getDb().prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as { name: string }[]
    ).map((r) => r.name)
    expect(tables).toContain('wiki_pages')
    expect(tables).toContain('proactive_rules')
    expect(tables).toContain('proactive_clues')
    expect(tables).toContain('proactive_daily_log')
    expect(tables).toContain('delegated_tasks')
  })

  it('Section 写入 / 改写记 reason，Change Log 时间戳由代码生成', () => {
    const now = 1_700_000_000_000
    const page = wikiRepo.upsertWikiPage(
      { kind: 'project', title: 'Acme rollout', section: '报价', body: '4.8 万', reason: '初稿' },
      now
    )
    expect(page.id).toBe('project:acme-rollout')
    expect(page.changes.length).toBe(2)

    const updated = wikiRepo.upsertWikiPage(
      { kind: 'project', title: 'Acme rollout', section: '报价', body: '5.2 万', reason: '客户确认涨价' },
      now + 1
    )
    expect(updated.sections.length).toBe(1)
    expect(updated.sections[0].body).toBe('5.2 万')
    expect(updated.changes.at(-1)?.reason).toBe('客户确认涨价')
    expect(updated.changes.every((c) => typeof c.at === 'number' && typeof c.summary === 'string')).toBe(true)
    expect(wikiRepo.getWikiPage(page.id)?.sections[0].body).toBe('5.2 万')
  })

  it('落库时 Section 正文被截到 3000 字符', () => {
    const page = wikiRepo.upsertWikiPage({
      kind: 'topic',
      title: 'Long body',
      section: '长文',
      body: 'x'.repeat(5_000)
    })
    expect(page.sections[0].body.length).toBe(3_000)
  })

  it('双榜检索：Wiki 概览榜 + 历史消息精确榜', () => {
    const conv = repo.createConversation({ title: '记忆检索测试' })
    const msg = repo.insertMessage({
      conversationId: conv.id,
      parentId: null,
      role: 'user',
      blocks: [{ type: 'text', text: 'Acme 报价 5.2 万请确认，别再改了' }],
      status: 'done'
    })
    const result = wikiRepo.searchKnowledge({
      query: 'Acme 报价',
      alternateQueries: ['Acme pricing', 'acme'],
      limit: 5
    })
    expect(result.queries.length).toBe(3)
    expect(result.wikiOverviews.some((w) => w.title === 'Acme rollout')).toBe(true)
    expect(result.originalMessages.some((m) => m.messageId === msg.id && m.text.includes('报价'))).toBe(true)
    expect(result.originalMessages.every((m) => m.text.length <= 400)).toBe(true)
  })

  it('索引缓存与后台提取闭环', () => {
    const entries = wikiRepo.refreshWikiIndexCache()
    expect(entries.length).toBeGreaterThan(0)
    expect(getWikiIndex().length).toBe(entries.length)

    const count = wikiRepo.extractWikiAndMemory('我叫李明，客户是 Acme，项目叫 Apollo', '')
    expect(count).toBeGreaterThan(0)
    expect(wikiRepo.getWikiPage('contact:李明')).not.toBeNull()
    expect(wikiRepo.getWikiPage('client:acme')).not.toBeNull()
    expect(wikiRepo.getWikiPage('project:apollo')).not.toBeNull()
  })
})
