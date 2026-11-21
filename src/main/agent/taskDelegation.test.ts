import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let userDataDir = ''

const runtimeMocks = vi.hoisted(() => ({
  send: vi.fn((_payload: { priority?: string; [key: string]: unknown }) => ({ runId: 'mock-run' })),
  withBus: vi.fn(() => () => {}),
  abortConversationRuns: vi.fn()
}))

vi.mock('electron', () => ({
  app: { getPath: () => process.env['TASK_DELEGATION_TEST_USER_DATA'] ?? tmpdir() }
}))
vi.mock('electron-log/main', () => ({
  default: { info: () => {}, warn: () => {}, error: () => {} }
}))
vi.mock('./runtime', () => ({
  agentRuntime: {
    send: runtimeMocks.send,
    withBus: runtimeMocks.withBus,
    abortConversationRuns: runtimeMocks.abortConversationRuns
  }
}))

beforeAll(() => {
  userDataDir = mkdtempSync(join(tmpdir(), 'shangbo-delegation-test-'))
  process.env['TASK_DELEGATION_TEST_USER_DATA'] = userDataDir
})
afterAll(() => {
  resetTaskDelegationForTesting()
  closeDatabase()
  rmSync(userDataDir, { recursive: true, force: true })
})
beforeEach(() => {
  resetTaskDelegationForTesting()
  runtimeMocks.send.mockClear()
  runtimeMocks.abortConversationRuns.mockClear()
})

import { closeDatabase, getDb } from '../db'
import * as repo from '../db/repo'
import { eventBus } from '../events/bus'
import {
  buildTeamMarkdown,
  cancelTask,
  countActive,
  getDelegatedTask,
  isDelegatedChildConversation,
  listDelegatedTasks,
  MAX_CONCURRENT_ALTEREGOS,
  resetTaskDelegationForTesting,
  sendInstruction,
  startTask
} from './taskDelegation'

function makeParent(): string {
  return repo.createConversation({ title: '父会话' }).id
}

function flushImmediate(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

describe('team.md 协作协议', () => {
  it('生成 Goal / Coordinator / Members / Handoff DAG 四段', () => {
    const md = buildTeamMarkdown('上线新版官网', 'Meta', [
      { id: 'researcher', role: '调研', deliverable: '竞品清单', receivesFrom: [] },
      { id: 'coder', role: '实现', deliverable: '页面代码', receivesFrom: ['researcher'] }
    ])
    expect(md).toContain('## Goal')
    expect(md).toContain('## Coordinator')
    expect(md).toContain('### researcher')
    expect(md).toContain('receives_from: researcher')
    expect(md).toContain('researcher → coder → Meta')
  })
})

describe('Meta / AlterEgo 状态机', () => {
  it('task_create 立即返回 taskId，独立子会话隐藏，产出目录生成', async () => {
    getDb()
    const parent = makeParent()
    const result = startTask({
      parentConversationId: parent,
      title: '整理发布说明',
      brief: '读取 CHANGELOG.md，输出一页发布说明',
      workingDirectory: userDataDir,
      team: { goal: '发布说明', members: [{ id: 'writer', role: '撰写', deliverable: 'release-notes.md' }] }
    })
    expect(result.status).toBe('running')
    expect(result.taskId).toBeTruthy()
    expect(existsSync(result.workspacePath)).toBe(true)
    expect(existsSync(join(result.workspacePath, 'brief.md'))).toBe(true)
    expect(readFileSync(join(result.workspacePath, 'team.md'), 'utf8')).toContain('## Handoff DAG')

    const child = repo.getConversation(result.childConversationId)
    expect(child?.archivedAt).not.toBeNull()
    expect(isDelegatedChildConversation(result.childConversationId)).toBe(true)
    expect(getDelegatedTask(result.taskId)?.state).toBe('running')

    await flushImmediate()
    expect(runtimeMocks.send).toHaveBeenCalledTimes(1)
    expect(runtimeMocks.send.mock.calls[0][0].priority).toBe('task')
  })

  it('同一父会话最多 10 个并发分身，且分身禁止再派分身', () => {
    const parent = makeParent()
    let childId = ''
    for (let i = 0; i < MAX_CONCURRENT_ALTEREGOS; i++) {
      const task = startTask({
        parentConversationId: parent,
        title: `任务 ${i}`,
        brief: '占位',
        workingDirectory: userDataDir
      })
      childId = task.childConversationId
    }
    expect(countActive(parent)).toBe(MAX_CONCURRENT_ALTEREGOS)
    expect(() =>
      startTask({ parentConversationId: parent, title: '第 11 个', brief: '占位', workingDirectory: userDataDir })
    ).toThrow(/最多并发/)
    expect(() =>
      startTask({
        parentConversationId: childId,
        title: '套娃',
        brief: '占位',
        workingDirectory: userDataDir
      })
    ).toThrow(/禁止无限套娃/)
  })

  it('task_send 追加指令、task_cancel 暂停并保留历史', async () => {
    const parent = makeParent()
    const task = startTask({
      parentConversationId: parent,
      title: '写测试',
      brief: '补一组单测',
      workingDirectory: userDataDir
    })
    cancelTask(task.taskId)
    expect(getDelegatedTask(task.taskId)?.state).toBe('canceled')
    expect(runtimeMocks.abortConversationRuns).toHaveBeenCalledWith(task.childConversationId)

    const resumed = sendInstruction(task.taskId, '顺便把新 Logo 也加上')
    expect(resumed.state).toBe('running')
    expect(resumed.brief).toContain('顺便把新 Logo 也加上')
    expect(listDelegatedTasks(parent, task.taskId).length).toBe(1)
    await flushImmediate()
  })

  it('run_end / approval_required / run_error 事件驱动状态流转并广播汇报', async () => {
    const parent = makeParent()
    const task = startTask({
      parentConversationId: parent,
      title: '跑批',
      brief: '执行批处理',
      workingDirectory: userDataDir
    })
    const childId = task.childConversationId
    const reports: string[] = []
    const off = eventBus.subscribe((event) => {
      if (event.type === 'delegated_task_report') reports.push(event.state)
    })

    eventBus.publish({
      type: 'approval_required',
      runId: 'r1',
      conversationId: childId,
      messageId: 'm1',
      toolUseId: 't1',
      name: 'write_file',
      input: {},
      reason: '需要确认'
    })
    expect(getDelegatedTask(task.taskId)?.state).toBe('waiting_for_approval')

    // 恢复成 running 后再模拟正常收尾
    sendInstruction(task.taskId, '继续')
    await flushImmediate()
    eventBus.publish({ type: 'run_end', runId: 'r1', conversationId: childId, queued: 0 })
    expect(getDelegatedTask(task.taskId)?.state).toBe('idle')
    expect(reports).toContain('idle')

    const failing = startTask({
      parentConversationId: parent,
      title: '失败任务',
      brief: '故意失败',
      workingDirectory: userDataDir
    })
    eventBus.publish({
      type: 'run_error',
      runId: 'r2',
      conversationId: failing.childConversationId,
      messageId: 'm2',
      error: 'boom'
    })
    expect(getDelegatedTask(failing.taskId)?.state).toBe('failed')
    expect(getDelegatedTask(failing.taskId)?.error).toBe('boom')
    expect(reports).toContain('failed')
    off()
  })
})
