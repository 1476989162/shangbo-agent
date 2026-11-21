import { beforeEach, describe, expect, it } from 'vitest'
import {
  adjustHardLimit,
  isLocalEndpoint,
  modelScheduler,
  PRIORITY_ORDER,
  type LimitState
} from './scheduler'

const baseLimit: LimitState = {
  hardLimit: 4,
  maxHard: 8,
  freezeUntil: 0,
  penaltyUntil: 0,
  penaltyMs: 5 * 60_000,
  baselineMsPer1k: 100
}

describe('ModelScheduler：优先级、软硬水位与抢占', () => {
  beforeEach(() => {
    modelScheduler.reset()
  })

  it('优先级常量顺序：approval > chat > task > proactive > compaction > background', () => {
    expect(PRIORITY_ORDER.approval).toBeLessThan(PRIORITY_ORDER.chat)
    expect(PRIORITY_ORDER.chat).toBeLessThan(PRIORITY_ORDER.task)
    expect(PRIORITY_ORDER.background).toBeGreaterThan(PRIORITY_ORDER.compaction)
  })

  it('远端端点 hard=2 / soft=1：后台只占一个槽，前台仍可插入', async () => {
    const bg1 = await modelScheduler.acquire({
      providerId: 'remote',
      baseUrl: 'https://api.example.com/v1',
      priority: 'background',
      preemptible: true
    })
    const queuedBg = modelScheduler.acquire({
      providerId: 'remote',
      priority: 'background',
      preemptible: true
    })
    expect(modelScheduler.stats('remote')).toMatchObject({ hardLimit: 2, softLimit: 1, running: 1, queued: 1 })

    const chat = await modelScheduler.acquire({ providerId: 'remote', priority: 'chat' })
    expect(modelScheduler.stats('remote').running).toBe(2)
    chat.release()
    bg1.release()
    const bg2 = await queuedBg
    bg2.release()
    expect(modelScheduler.stats('remote').running).toBe(0)
  })

  it('前台满载时抢占未吐正文的后台请求，并腾出槽位', async () => {
    const bg = await modelScheduler.acquire({ providerId: 'p', priority: 'background', preemptible: true })
    const firstChat = await modelScheduler.acquire({ providerId: 'p', priority: 'chat' })
    expect(modelScheduler.stats('p').running).toBe(2)

    // 第三个前台请求进来：hardLimit 已满，只能抢占那个可让路的后台请求
    const chatPromise = modelScheduler.acquire({ providerId: 'p', priority: 'chat' })
    expect(bg.preempted).toBe(true)
    const secondChat = await chatPromise
    expect(modelScheduler.stats('p').preemptions).toBe(1)
    bg.release()
    firstChat.release()
    secondChat.release()
  })

  it('已吐正文的非后台请求不被抢占，前台按队列等待', async () => {
    const proactive = await modelScheduler.acquire({ providerId: 'p2', priority: 'proactive', preemptible: true })
    proactive.markBodyEmitted()
    const firstChat = await modelScheduler.acquire({ providerId: 'p2', priority: 'chat' })
    let chatStarted = false
    const chatPromise = modelScheduler.acquire({ providerId: 'p2', priority: 'chat' }).then((slot) => {
      chatStarted = true
      return slot
    })
    await Promise.resolve()
    expect(chatStarted).toBe(false)
    expect(proactive.preempted).toBe(false)
    expect(modelScheduler.stats('p2').queued).toBe(1)

    firstChat.release()
    const secondChat = await chatPromise
    expect(chatStarted).toBe(true)
    secondChat.release()
    proactive.release()
  })

  it('本地端点初始并发 1、上限 2；排队期间取消会拒绝', async () => {
    expect(isLocalEndpoint('http://127.0.0.1:11434/v1')).toBe(true)
    expect(isLocalEndpoint('https://api.openai.com/v1')).toBe(false)
    const local = await modelScheduler.acquire({
      providerId: 'local',
      baseUrl: 'http://localhost:11434/v1',
      priority: 'chat'
    })
    const stats = modelScheduler.stats('local')
    expect(stats.hardLimit).toBe(1)
    expect(modelScheduler.stats('local').softLimit).toBe(1)

    const controller = new AbortController()
    const waiting = modelScheduler.acquire({ providerId: 'local', priority: 'chat', signal: controller.signal })
    controller.abort()
    await expect(waiting).rejects.toMatchObject({ name: 'AbortError' })
    local.release()
  })
})

describe('ModelScheduler：AIMD 自适应水位', () => {
  it('429 / 首字节超时 → 并发折半并冻结上调 60 秒', () => {
    const next = adjustHardLimit(baseLimit, { durationMs: 1000, rateLimited: true }, 10_000)
    expect(next.hardLimit).toBe(2)
    expect(next.freezeUntil).toBe(70_000)
  })

  it('显著变慢 → 降一档并加倍冷却（上限 30 分钟）', () => {
    const slowed = adjustHardLimit(baseLimit, { durationMs: 500, promptTokens: 1000 }, 20_000)
    expect(slowed.hardLimit).toBe(3)
    expect(slowed.penaltyUntil).toBe(20_000 + 10 * 60_000)
    const again = adjustHardLimit(slowed, { durationMs: 500, promptTokens: 1000 }, 30_000)
    expect(again.penaltyUntil).toBeGreaterThan(slowed.penaltyUntil)
  })

  it('队列有等待且速度未劣化 → 试探上调，但不超过端点上限', () => {
    const fast = adjustHardLimit(
      baseLimit,
      { durationMs: 100, promptTokens: 1000, queueDepth: 2 },
      40_000
    )
    expect(fast.hardLimit).toBe(5)
    const capped: LimitState = { ...baseLimit, hardLimit: 8, maxHard: 8 }
    expect(adjustHardLimit(capped, { durationMs: 100, promptTokens: 1000, queueDepth: 3 }, 40_000).hardLimit).toBe(8)
  })

  it('冻结期内不上调', () => {
    const frozen: LimitState = { ...baseLimit, freezeUntil: 100_000 }
    expect(
      adjustHardLimit(frozen, { durationMs: 100, promptTokens: 1000, queueDepth: 2 }, 50_000).hardLimit
    ).toBe(4)
  })
})
