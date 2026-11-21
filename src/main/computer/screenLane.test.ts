import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  FocusLostError,
  ScreenLaneError,
  screenLane
} from './screenLane'

describe('Screen Lane：单车道 FIFO 互斥', () => {
  beforeEach(() => screenLane.resetForTesting())
  afterEach(() => screenLane.resetForTesting())

  it('多个会话并发请求物理输入时严格串行，不交错', async () => {
    const order: number[] = []
    const runs = [1, 2, 3].map((i) =>
      screenLane.runExclusive({ conversationId: `c${i}`, toolName: 'computer_click' }, async () => {
        order.push(i)
        await new Promise((resolve) => setTimeout(resolve, 5))
        order.push(-i)
        return i
      })
    )
    expect(await Promise.all(runs)).toEqual([1, 2, 3])
    expect(order).toEqual([1, -1, 2, -2, 3, -3])
  })

  it('成功后写 done；失败写 unknown 并永久禁止同 opId 重放', async () => {
    await expect(
      screenLane.runExclusive(
        { conversationId: 'c1', toolName: 'computer_click', opId: 'op-unknown' },
        async () => {
          throw new Error('执行超时，状态未知')
        }
      )
    ).rejects.toBeInstanceOf(ScreenLaneError)
    expect(screenLane.getLog().find((e) => e.opId === 'op-unknown')?.state).toBe('unknown')
    expect(screenLane.isReplayForbidden('op-unknown')).toBe(true)

    await expect(
      screenLane.runExclusive(
        { conversationId: 'c1', toolName: 'computer_click', opId: 'op-unknown' },
        async () => 'retry'
      )
    ).rejects.toThrow(/禁止自动重放/)

    await expect(
      screenLane.runExclusive({ conversationId: 'c1', toolName: 'computer_type', opId: 'op-ok' }, () => 'ok')
    ).resolves.toBe('ok')
    expect(screenLane.getLog().find((e) => e.opId === 'op-ok')?.state).toBe('done')
    expect(screenLane.isReplayForbidden('op-ok')).toBe(false)
  })

  it('预写日志是 in_flight：排队期间即可见', async () => {
    const first = screenLane.runExclusive(
      { conversationId: 'c1', toolName: 'computer_click', opId: 'op-1' },
      () => new Promise<string>((resolve) => setTimeout(() => resolve('first'), 20))
    )
    const second = screenLane.runExclusive(
      { conversationId: 'c2', toolName: 'computer_click', opId: 'op-2' },
      () => 'second'
    )
    const states = screenLane.getLog().map((e) => e.state)
    expect(states).toEqual(['in_flight', 'in_flight'])
    await Promise.all([first, second])
    expect(screenLane.getLog().map((e) => e.state)).toEqual(['done', 'done'])
  })
})

describe('Screen Lane：焦点守护', () => {
  beforeEach(() => screenLane.resetForTesting())
  afterEach(() => screenLane.resetForTesting())

  it('用户切走前台窗口即停手，且状态记为 aborted（不是 unknown）', async () => {
    screenLane.setFocusProvider(async () => ({ windowId: 'w-other', app: 'OtherApp' }))
    await expect(
      screenLane.runExclusive(
        { conversationId: 'c1', toolName: 'desktop_click_ref', opId: 'op-focus', expectedWindowId: 'w-1' },
        () => 'clicked'
      )
    ).rejects.toBeInstanceOf(FocusLostError)
    expect(screenLane.getLog().find((e) => e.opId === 'op-focus')?.state).toBe('aborted')
    expect(screenLane.isReplayForbidden('op-focus')).toBe(false)
  })

  it('焦点一致时正常执行；探测失败或未给目标窗口时不阻断', async () => {
    screenLane.setFocusProvider(async () => ({ windowId: 'w-1', app: 'MyApp' }))
    await expect(
      screenLane.runExclusive(
        { conversationId: 'c1', toolName: 'computer_type', expectedWindowId: 'w-1' },
        () => 'typed'
      )
    ).resolves.toBe('typed')

    screenLane.setFocusProvider(async () => {
      throw new Error('辅助进程不可用')
    })
    await expect(
      screenLane.runExclusive(
        { conversationId: 'c1', toolName: 'computer_type', expectedWindowId: 'w-1' },
        () => 'typed-2'
      )
    ).resolves.toBe('typed-2')
    await expect(
      screenLane.runExclusive({ conversationId: 'c1', toolName: 'computer_scroll' }, () => 'scrolled')
    ).resolves.toBe('scrolled')
  })
})
