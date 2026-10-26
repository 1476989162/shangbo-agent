import { beforeEach, describe, expect, it, vi } from 'vitest'
import { eventBus } from './bus'
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
})
