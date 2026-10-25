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
