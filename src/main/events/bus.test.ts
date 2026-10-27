import { beforeEach, describe, expect, it, vi } from 'vitest'
import { bridgeEventsToWindow, eventBus } from './bus'
import type { AgentEvent } from '../../shared/types'

/* 事件总线：publish/subscribe，订阅者异常隔离。 */

describe('事件总线 (eventBus)', () => {
  beforeEach(() => {
    eventBus.clear()
  })

  it('订阅者能收到 publish 的事件', () => {
    const received: AgentEvent[] = []
    eventBus.subscribe((e) => received.push(e))
    const event: AgentEvent = { type: 'run_end', runId: 'r1', conversationId: 'c1', queued: 0 }
    eventBus.publish(event)
    expect(received).toEqual([event])
  })

  it('多个订阅者都收到，取消订阅后不再收到', () => {
    const a: AgentEvent[] = []
    const b: AgentEvent[] = []
    eventBus.subscribe((e) => a.push(e))
    const offB = eventBus.subscribe((e) => b.push(e))
    const event: AgentEvent = { type: 'run_end', runId: 'r1', conversationId: 'c1', queued: 0 }
    eventBus.publish(event)
    expect(a).toHaveLength(1)
    expect(b).toHaveLength(1)
    offB()
    eventBus.publish(event)
    expect(a).toHaveLength(2)
    expect(b).toHaveLength(1)
  })

  it('单个订阅者抛错不影响其他订阅者', () => {
    const received: AgentEvent[] = []
    eventBus.subscribe(() => {
      throw new Error('boom')
    })
    eventBus.subscribe((e) => received.push(e))
    expect(() =>
      eventBus.publish({ type: 'run_end', runId: 'r1', conversationId: 'c1', queued: 0 })
    ).not.toThrow()
    expect(received).toHaveLength(1)
  })

  it('AgentRuntime.withBus 同时调用 emit 并 publish 到总线', async () => {
    const { AgentRuntime } = await import('../agent/runtime')
    const runtime = new AgentRuntime()
    const viaEmit: AgentEvent[] = []
    const viaBus: AgentEvent[] = []
    eventBus.subscribe((e) => viaBus.push(e))
    const wrapped = runtime.withBus((e) => viaEmit.push(e))
    const event: AgentEvent = { type: 'run_end', runId: 'r1', conversationId: 'c1', queued: 0 }
    wrapped(event)
    expect(viaEmit).toEqual([event])
    expect(viaBus).toEqual([event])
    const spy = vi.fn()
    void spy
  })

  it('桌面窗口每个事件只投递一次：总线桥接 + send 的 emit 不能同时发到窗口', async () => {
    // 回归测试：ipc/index.ts 曾把 broadcast 既作为 withBus 的 emit，又作为总线桥接，
    // 每个 text_delta 被发到窗口两次，界面出现「你好你好」式的结巴重复。
    // 这里用生产代码里的同一个 bridgeEventsToWindow 与 withBus，锁定正确接线。
    const { AgentRuntime } = await import('../agent/runtime')
    const runtime = new AgentRuntime()
    const delivered: AgentEvent[] = []
    bridgeEventsToWindow((e) => delivered.push(e))
    // 生产代码（ipc/index.ts 的 chat:send / regenerate）传入的 emit 必须是空操作
    const emit = runtime.withBus(() => {})
    const event: AgentEvent = {
      type: 'text_delta',
      runId: 'r1',
      conversationId: 'c1',
      messageId: 'm1',
      text: '你好'
    }
    emit(event)
    expect(delivered).toEqual([event])
  })
})
