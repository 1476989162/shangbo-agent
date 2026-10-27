import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/* 真实 SQLite 上的 repo 层行为：迁移、启动收敛、树尾定位。
   electron 用环境变量注入的临时目录替代 userData，避免碰真实库。 */

let userDataDir = ''

vi.mock('electron', () => ({
  app: { getPath: () => process.env['REPO_TEST_USER_DATA'] ?? tmpdir() }
}))

vi.mock('electron-log/main', () => ({
  default: { info: () => {}, warn: () => {}, error: () => {} }
}))

beforeAll(() => {
  userDataDir = mkdtempSync(join(tmpdir(), 'shangbo-repo-test-'))
  process.env['REPO_TEST_USER_DATA'] = userDataDir
})

afterAll(() => {
  closeDatabase()
  rmSync(userDataDir, { recursive: true, force: true })
})

import { closeDatabase, getDb } from './index'
import * as repo from './repo'

function ensureSchemaReady(): void {
  getDb()
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('settleOrphanStreamingMessages 启动收敛', () => {
  it('崩溃残留的 streaming/pending/queued 统一标记为 aborted，done 不受影响', () => {
    ensureSchemaReady()
    const conv = repo.createConversation({ title: '收敛测试' })
    const queuedUser = repo.insertMessage({
      conversationId: conv.id,
      parentId: null,
      role: 'user',
      blocks: [{ type: 'text', text: '排队中崩溃的消息' }],
      status: 'queued'
    })
    const streamingAssistant = repo.insertMessage({
      conversationId: conv.id,
      parentId: queuedUser.id,
      role: 'assistant',
      blocks: [],
      status: 'streaming'
    })
    const doneMessage = repo.insertMessage({
      conversationId: conv.id,
      parentId: streamingAssistant.id,
      role: 'user',
      blocks: [{ type: 'text', text: '已完成的消息' }],
      status: 'done'
    })

    repo.settleOrphanStreamingMessages()

    expect(repo.getMessage(queuedUser.id)?.status).toBe('aborted')
    expect(repo.getMessage(streamingAssistant.id)?.status).toBe('aborted')
    expect(repo.getMessage(doneMessage.id)?.status).toBe('done')
  })
})

describe('getLatestMessageId 树尾定位', () => {
  it('返回会话内最新一条消息的 id（跨会话不串）', async () => {
    ensureSchemaReady()
    const convA = repo.createConversation({ title: 'A' })
    const convB = repo.createConversation({ title: 'B' })
    const first = repo.insertMessage({
      conversationId: convA.id,
      parentId: null,
      role: 'user',
      blocks: [{ type: 'text', text: '第一条' }]
    })
    // created_at 是毫秒级时间戳，隔几毫秒确保顺序稳定
    await sleep(3)
    const second = repo.insertMessage({
      conversationId: convA.id,
      parentId: first.id,
      role: 'assistant',
      blocks: []
    })
    await sleep(3)
    repo.insertMessage({
      conversationId: convB.id,
      parentId: null,
      role: 'user',
      blocks: [{ type: 'text', text: '别的会话' }]
    })

    expect(repo.getLatestMessageId(convA.id)).toBe(second.id)
    expect(repo.getLatestMessageId(convB.id)).not.toBe(second.id)
    expect(repo.getLatestMessageId('不存在的会话')).toBeNull()
  })
})

describe('getUsageStats 统计口径', () => {
  /** 每个用例使用独立日期，避免前序用例的数据落进同一个时间桶。 */
  function insertUsageAt(
    conversationId: string,
    createdAt: number,
    usage: Record<string, number>,
    options: { usageMode?: 'cowork' | 'code'; blocks?: unknown[] } = {}
  ): void {
    const message = repo.insertMessage({
      conversationId,
      parentId: null,
      role: 'assistant',
      blocks: (options.blocks ?? []) as never,
      usageMode: options.usageMode ?? null,
      usage: usage as never
    })
    getDb().prepare('UPDATE messages SET created_at = ? WHERE id = ?').run(createdAt, message.id)
  }

  /** 清掉其他用例留下的 usage 行，保证当前用例只断言自己写入的数据。 */
  function clearUsageRows(): void {
    getDb().prepare('UPDATE messages SET usage = NULL').run()
  }

  it('优先使用整轮累计输入/输出，总量恒等于两者之和', () => {
    ensureSchemaReady()
    clearUsageRows()
    const conv = repo.createConversation({ title: '统计口径' })
    insertUsageAt(
      conv.id,
      Date.now() - 1000,
      {
        promptTokens: 10,
        completionTokens: 2,
        totalTokens: 50,
        totalPromptTokens: 40,
        totalCompletionTokens: 10,
        requests: 3
      },
      { usageMode: 'code' }
    )

    const stats = repo.getUsageStats(1)

    expect(stats.promptTokens).toBe(40)
    expect(stats.completionTokens).toBe(10)
    expect(stats.totalTokens).toBe(50)
    expect(stats.codeTokens).toBe(50)
    expect(stats.coworkTokens).toBe(0)
    expect(stats.legacyTokens).toBe(0)
    expect(stats.fallbackUsageRows).toBe(0)
  })

  it('缺少累计拆分时回退到末次请求，且不会把 totalTokens 混入输入输出', () => {
    ensureSchemaReady()
    clearUsageRows()
    const conv = repo.createConversation({ title: '旧数据回退' })
    insertUsageAt(conv.id, Date.now() - 2000, {
        promptTokens: 7,
        completionTokens: 3,
        totalTokens: 30,
        requests: 2
      })

    const stats = repo.getUsageStats(1)

    expect(stats.promptTokens).toBe(7)
    expect(stats.completionTokens).toBe(3)
    expect(stats.totalTokens).toBe(10)
    expect(stats.fallbackUsageRows).toBe(1)
  })

  it('只有末次拆分但记录了多次请求时，也标记为口径回退', () => {
    ensureSchemaReady()
    clearUsageRows()
    const conv = repo.createConversation({ title: '累计缺失' })
    insertUsageAt(conv.id, Date.now() - 2500, {
      promptTokens: 20,
      completionTokens: 4,
      requests: 4
    })

    const stats = repo.getUsageStats(1)

    expect(stats.totalTokens).toBe(24)
    expect(stats.fallbackUsageRows).toBe(1)
    expect(stats.zeroInputUsageRows).toBe(0)
  })

  it('只有输出没有输入时如实计入零输入记录，不编造输入', () => {
    ensureSchemaReady()
    clearUsageRows()
    const conv = repo.createConversation({ title: '零输入' })
    insertUsageAt(conv.id, Date.now() - 2200, {
      promptTokens: 0,
      completionTokens: 9,
      totalTokens: 9
    })

    const stats = repo.getUsageStats(1)

    expect(stats.promptTokens).toBe(0)
    expect(stats.completionTokens).toBe(9)
    expect(stats.totalTokens).toBe(9)
    expect(stats.zeroInputUsageRows).toBe(1)
  })

  it('按真实落库模式分类，旧消息不再按目录绑定猜测', () => {
    ensureSchemaReady()
    clearUsageRows()
    const legacyConv = repo.createConversation({
      title: '旧会话',
      workingDir: 'G:\\some-project'
    })
    insertUsageAt(legacyConv.id, Date.now() - 3000, { promptTokens: 5, completionTokens: 5 })
    const coworkConv = repo.createConversation({ title: '协同' })
    insertUsageAt(
      coworkConv.id,
      Date.now() - 4000,
      { promptTokens: 6, completionTokens: 4 },
      { usageMode: 'cowork' }
    )

    const stats = repo.getUsageStats(1)

    expect(stats.coworkTokens).toBe(10)
    expect(stats.codeTokens).toBe(0)
    expect(stats.legacyTokens).toBe(10)
    expect(stats.legacyModeRows).toBe(1)
    expect(stats.coworkTokens + stats.codeTokens + stats.legacyTokens).toBe(stats.totalTokens)
  })

  it('工具调用次数来自内容块中的 tool_use', () => {
    ensureSchemaReady()
    clearUsageRows()
    const conv = repo.createConversation({ title: '工具计数' })
    insertUsageAt(
      conv.id,
      Date.now() - 5000,
      { promptTokens: 1, completionTokens: 1 },
      {
        blocks: [
        { type: 'tool_use', id: 'a', name: 'read_file', input: {} },
        { type: 'tool_result', toolUseId: 'a', content: 'ok', isError: false },
        { type: 'tool_use', id: 'b', name: 'search_files', input: {} }
        ]
      }
    )

    expect(repo.getUsageStats(1).toolCallsCount).toBe(2)
  })
})
