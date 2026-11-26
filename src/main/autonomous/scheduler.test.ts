import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * 回归测试：调度器启停的订阅与定时器清理。
 * - 重复 start() 不叠加 eventBus 监听（退订函数被保存且只订阅一次）；
 * - stop() 退订监听并清掉 15s 轮询与 8s 启动定时器（停机后不再 tick）；
 * - 重启后恢复正常轮询。
 */

vi.mock('electron', () => ({
  Notification: { isSupported: () => false }
}))

vi.mock('electron-log/main', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

vi.mock('../db/repo', () => ({}))

const settingsMap: Record<string, unknown> = {}
vi.mock('../settings', () => ({
  getSetting: (key: string, fallback: unknown) =>
    key in settingsMap ? settingsMap[key] : fallback
}))

const storeMocks = vi.hoisted(() => ({
  dueTasks: vi.fn<() => Array<{ id: string }>>()
}))

vi.mock('./store', () => ({
  listTasks: vi.fn(() => []),
  upsertTask: vi.fn(),
  deleteTask: vi.fn(),
  setTaskEnabled: vi.fn(),
  getTask: vi.fn(() => null),
  resetTaskForManualRun: vi.fn(),
  countRunsToday: vi.fn(() => 0),
  markTaskFinished: vi.fn(),
  computeNextRunAt: vi.fn(() => 0),
  dueTasks: storeMocks.dueTasks,
  claimTask: vi.fn(() => false),
  createRun: vi.fn(),
  markTaskStarted: vi.fn(),
  attachConversation: vi.fn(),
  updateRun: vi.fn(),
  lessonForTask: vi.fn(() => null),
  upsertLesson: vi.fn(),
  listLessons: vi.fn(() => [])
}))

vi.mock('../agent/runtime', () => ({
  agentRuntime: {
    abortConversationRuns: vi.fn(),
    withBus: () => () => {},
    send: vi.fn()
  }
}))

vi.mock('../agent/wish', () => ({
  resolveWishPrompt: () => ''
}))

vi.mock('../tools', () => ({
  auditCommandSecurity: () => ({ isDangerous: false as boolean }),
  commandTouchesPrivateData: () => false
}))

vi.mock('../providers/types', () => ({
  textOf: () => ''
}))

vi.mock('../memory/dreaming', () => ({
  decideProactiveDetailed: () => ({ bucket: 'default', action: 'tell-now', reason: '' })
}))

vi.mock('../memory/proactiveRepo', () => ({
  applyFeedback: vi.fn(),
  isChatQuiet: () => true,
  loadProactiveContext: () => ({}),
  queueFollowUp: vi.fn(),
  recordDecision: vi.fn(),
  takeFollowUps: () => [],
  noteUserMessage: vi.fn()
}))

import { autonomousScheduler } from './scheduler'
import { eventBus } from '../events/bus'

beforeEach(() => {
  vi.useFakeTimers()
  autonomousScheduler.stop()
  eventBus.clear()
  for (const k of Object.keys(settingsMap)) delete settingsMap[k]
  // tick 走到扫库分支（否则 enabled=false 会提前返回，定时器是否存活测不出来）
  settingsMap['agent.autonomous.enabled'] = true
  storeMocks.dueTasks.mockReturnValue([])
  storeMocks.dueTasks.mockClear()
})

describe('autonomousScheduler 启停清理', () => {
  it('重复 start() 只订阅一次，不叠监听', () => {
    autonomousScheduler.start()
    autonomousScheduler.start()
    expect(eventBus.subscriberCount()).toBe(1)
    autonomousScheduler.stop()
  })

  it('stop() 退订监听并清掉 8s 启动定时器，停机后不再 tick', () => {
    autonomousScheduler.start()
    // 停机早于 8s 启动定时器触发
    vi.advanceTimersByTime(7_000)
    autonomousScheduler.stop()
    expect(eventBus.subscriberCount()).toBe(0)
    // 把 15s 轮询和 8s 启动定时器都熬过去：tick 不应再发生
    vi.advanceTimersByTime(60_000)
    expect(storeMocks.dueTasks).not.toHaveBeenCalled()
  })

  it('stop() 清掉 15s 轮询：运行中停机后不再扫库', () => {
    autonomousScheduler.start()
    // 跑过一次 15s 轮询，确认 tick 正常工作
    vi.advanceTimersByTime(16_000)
    expect(storeMocks.dueTasks).toHaveBeenCalled()
    storeMocks.dueTasks.mockClear()
    autonomousScheduler.stop()
    vi.advanceTimersByTime(60_000)
    expect(storeMocks.dueTasks).not.toHaveBeenCalled()
  })

  it('重启后恢复订阅与轮询', () => {
    autonomousScheduler.start()
    autonomousScheduler.stop()
    autonomousScheduler.start()
    expect(eventBus.subscriberCount()).toBe(1)
    vi.advanceTimersByTime(16_000)
    expect(storeMocks.dueTasks).toHaveBeenCalled()
    autonomousScheduler.stop()
    expect(eventBus.subscriberCount()).toBe(0)
  })
})
