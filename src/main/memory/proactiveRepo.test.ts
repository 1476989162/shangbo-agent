import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let userDataDir = ''

vi.mock('electron', () => ({
  app: { getPath: () => process.env['PROACTIVE_REPO_TEST_USER_DATA'] ?? tmpdir() }
}))
vi.mock('electron-log/main', () => ({
  default: { info: () => {}, warn: () => {}, error: () => {} }
}))

beforeAll(() => {
  userDataDir = mkdtempSync(join(tmpdir(), 'shangbo-proactive-test-'))
  process.env['PROACTIVE_REPO_TEST_USER_DATA'] = userDataDir
})
afterAll(() => {
  closeDatabase()
  rmSync(userDataDir, { recursive: true, force: true })
})
beforeEach(() => {
  resetProactiveTransientState()
})

import { closeDatabase, getDb } from '../db'
import {
  applyFeedback,
  chatQuietForMs,
  countRemindersToday,
  isChatQuiet,
  listClues,
  listJudgedToday,
  listRules,
  loadProactiveContext,
  localDayStr,
  noteUserMessage,
  queueFollowUp,
  recordDecision,
  resetProactiveTransientState,
  takeFollowUps,
  upsertRule
} from './proactiveRepo'

const day = '2026-11-20'

describe('proactiveRepo：规则 / 线索 / 当日日志', () => {
  it('Direct Rule 一次写入规则表；普通线索两次晋升', () => {
    getDb()
    const direct = applyFeedback('以后这类消息都立刻告诉我', 'vendor-invoice', 10)
    expect(direct.direct).toBe(true)
    expect(listRules()['vendor-invoice']).toBe('tell-now')

    const first = applyFeedback('早点告诉我', 'delivery', 10)
    expect(first.rule).toBeNull()
    expect(listClues().some((c) => c.kind === 'delivery' && c.seen === 1)).toBe(true)
    const second = applyFeedback('早点告诉我', 'delivery', 10)
    expect(second.rule).toEqual({ kind: 'delivery', action: 'tell-now' })
    expect(listRules()['delivery']).toBe('tell-now')
    expect(listClues().some((c) => c.kind === 'delivery')).toBe(false)
  })

  it('深夜反馈绝不落成 stay-silent 规则', () => {
    const night = applyFeedback('以后别再提醒我这类', 'night-alerts', 23)
    expect(night.rule?.action ?? 'none').not.toBe('stay-silent')
    expect(listRules()['night-alerts']).not.toBe('stay-silent')
  })

  it('同一事项一天只记一次、每日提醒计数与上下文加载', () => {
    expect(recordDecision(day, 'task-1:2026-11-20', 'tell-now', 1_000)).toBe(true)
    expect(recordDecision(day, 'task-1:2026-11-20', 'follow-up', 2_000)).toBe(false)
    expect(recordDecision(day, 'task-2:2026-11-20', 'tell-now', 3_000)).toBe(true)
    expect(countRemindersToday(day)).toBe(2)
    expect(listJudgedToday(day).length).toBe(2)

    const ctx = loadProactiveContext(new Date('2026-11-20T10:00:00'))
    expect(ctx.dayStr).toBe(day)
    expect(ctx.remindersToday).toBe(2)
    expect(ctx.judgedToday).toContain('task-1:2026-11-20')
    upsertRule({ kind: 'meeting-change', action: 'stay-silent' })
    expect(loadProactiveContext(new Date('2026-11-20T10:00:00')).rules['meeting-change']).toBe('stay-silent')
    expect(localDayStr(new Date('2026-11-20T10:00:00'))).toBe(day)
  })
})

describe('proactiveRepo：3 分钟安静窗口与静默期汇总', () => {
  it('刚发过消息不安静，3 分钟后才允许推送', () => {
    expect(chatQuietForMs(10_000)).toBe(Number.POSITIVE_INFINITY)
    noteUserMessage(10_000)
    expect(isChatQuiet(10_000 + 60_000)).toBe(false)
    expect(isChatQuiet(10_000 + 3 * 60_000)).toBe(true)
  })

  it('静默期只入队，08:00 之后才汇总吐出', () => {
    queueFollowUp('许愿完成：A', '验收通过')
    expect(takeFollowUps(23)).toEqual([])
    expect(takeFollowUps(7)).toEqual([])
    const pending = takeFollowUps(9)
    expect(pending.length).toBe(1)
    expect(pending[0].title).toBe('许愿完成：A')
    expect(takeFollowUps(9)).toEqual([])
  })
})
