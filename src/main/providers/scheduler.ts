import type { WorkPriority } from '../../shared/types'

/**
 * 端点级自适应优先级调度（对标 Linger docs/model-scheduling.md）。
 *
 * - 一个 providerId 一个队列，7 级（实际 6 级）优先级；
 * - 软硬水位：soft = max(1, hard - 1)，永远给 chat / approval 留最后一个槽；
 * - 前台排队时抢占「可抢占且尚未吐出正文（或后台单次提取）」的后台请求，
 *   被抢占者由网关重新入队，不计入失败次数；
 * - AIMD 动态水位：遇 429 / 首字节超时折半并冻结上调 60s，变慢则降档并冷却。
 *
 * 本模块不依赖 electron / DB / gateway，纯内存，可独立单测。
 */
export type { WorkPriority }

export const PRIORITY_ORDER: Record<WorkPriority, number> = {
  approval: 0,
  chat: 1,
  task: 2,
  proactive: 3,
  compaction: 4,
  background: 5
}

export class PreemptedError extends Error {
  constructor() {
    super('模型请求已为前台任务让路，将重新入队')
    this.name = 'PreemptedError'
  }
}

export interface AcquireOptions {
  providerId: string
  baseUrl?: string
  priority?: WorkPriority
  preemptible?: boolean
  signal?: AbortSignal
  /** 抢占后重新入队时保持原入队时刻，避免被后来者插队。 */
  enqueueAt?: number
  /**
   * 已被抢占次数（网关在重试上下文里维护并透传）。
   * 新槽位继承该计数，tryPreempt 的 `< 2` 上限才能真正生效；
   * 否则每次重入都从 0 开始，抢占上限形同虚设。
   */
  preemptionCount?: number
  /**
   * 显式声明是否为本机推理引擎（覆盖自动判定）。
   * 本机 Magpie 云代理（127.0.0.1:34254，背后是云端模型）必须传 false，
   * 否则会被误判成本地引擎、并发锁死为 1。
   */
  isLocalEngine?: boolean
}

export interface ScheduleSlot {
  readonly preemptSignal: AbortSignal
  readonly preempted: boolean
  /** 收到第一个正文分片后调用：已吐正文的请求一般不再被抢占。 */
  markBodyEmitted(): void
  release(): void
}

export interface WorkSample {
  durationMs: number
  promptTokens?: number
  queueDepth?: number
  rateLimited?: boolean
  timedOut?: boolean
}

export interface LimitState {
  hardLimit: number
  maxHard: number
  freezeUntil: number
  penaltyUntil: number
  penaltyMs: number
  baselineMsPer1k: number | null
}

export interface EndpointStats {
  hardLimit: number
  softLimit: number
  running: number
  queued: number
  preemptions: number
  freezeUntil: number
}

const FREEZE_MS = 60_000
const BASE_PENALTY_MS = 5 * 60_000
const MAX_PENALTY_MS = 30 * 60_000

/** AIMD 水位调整（纯函数，便于单测）。 */
export function adjustHardLimit(state: LimitState, sample: WorkSample, now = Date.now()): LimitState {
  if (sample.rateLimited || sample.timedOut) {
    return {
      ...state,
      hardLimit: Math.max(1, Math.floor(state.hardLimit / 2)),
      freezeUntil: now + FREEZE_MS,
      penaltyUntil: now + FREEZE_MS
    }
  }
  const tokens = Math.max(1, sample.promptTokens ?? 1_000)
  const msPer1k = (sample.durationMs / tokens) * 1_000
  const baseline = state.baselineMsPer1k
  const nextBaseline = baseline === null ? msPer1k : baseline * 0.7 + msPer1k * 0.3

  // 显著变慢：降一档 + 冷却（再次变慢则冷却翻倍，最高 30 分钟）
  if (baseline !== null && msPer1k > baseline * 1.5) {
    const penalty = Math.min(MAX_PENALTY_MS, Math.max(BASE_PENALTY_MS, state.penaltyMs * 2))
    return {
      ...state,
      hardLimit: Math.max(1, state.hardLimit - 1),
      penaltyUntil: now + penalty,
      penaltyMs: penalty,
      baselineMsPer1k: nextBaseline
    }
  }
  // 队列有等待、速度未劣化、且不在冻结/冷却期 → 试探加一档
  if (
    now >= state.freezeUntil &&
    now >= state.penaltyUntil &&
    (sample.queueDepth ?? 0) > 0 &&
    msPer1k <= (baseline ?? msPer1k) * 1.2 &&
    state.hardLimit < state.maxHard
  ) {
    return { ...state, hardLimit: state.hardLimit + 1, baselineMsPer1k: nextBaseline }
  }
  return { ...state, baselineMsPer1k: nextBaseline }
}

export function isLocalEndpoint(baseUrl?: string): boolean {
  if (!baseUrl) return false
  return /localhost|127\.0\.0\.1|\[::1\]|ollama|0\.0\.0\.0/i.test(baseUrl)
}

interface WorkItem {
  id: number
  priority: WorkPriority
  preemptible: boolean
  enqueueAt: number
  /** 已被抢占次数：重入 acquire 时由调用方透传，保证跨重试累积。 */
  preemptionCount: number
  resolve: (slot: SlotImpl) => void
  reject: (error: unknown) => void
  cleanupSignal?: () => void
  settled: boolean
}

class SlotImpl implements ScheduleSlot {
  readonly controller = new AbortController()
  emitted = false
  released = false
  preempted = false
  preemptionCount: number

  constructor(readonly item: WorkItem) {
    this.preemptionCount = item.preemptionCount
  }

  get preemptSignal(): AbortSignal {
    return this.controller.signal
  }
  markBodyEmitted(): void {
    this.emitted = true
  }
  release(): void {
    if (this.released) return
    this.released = true
    modelScheduler.onRelease(this)
  }
}

interface EndpointState extends LimitState {
  running: Set<SlotImpl>
  queue: WorkItem[]
  preemptions: number
}

function isForeground(priority: WorkPriority): boolean {
  return priority === 'approval' || priority === 'chat'
}

function abortError(): Error {
  return new DOMException('Aborted', 'AbortError')
}

class ModelScheduler {
  private endpoints = new Map<string, EndpointState>()
  private nextId = 1

  private endpoint(providerId: string, baseUrl?: string, isLocalEngine?: boolean): EndpointState {
    let state = this.endpoints.get(providerId)
    if (!state) {
      const local = isLocalEngine ?? isLocalEndpoint(baseUrl)
      const hardLimit = local ? 1 : 2
      state = {
        hardLimit,
        maxHard: local ? 2 : 8,
        freezeUntil: 0,
        penaltyUntil: 0,
        penaltyMs: BASE_PENALTY_MS,
        baselineMsPer1k: null,
        running: new Set(),
        queue: [],
        preemptions: 0
      }
      this.endpoints.set(providerId, state)
    }
    return state
  }

  acquire(options: AcquireOptions): Promise<ScheduleSlot> {
    const state = this.endpoint(options.providerId, options.baseUrl, options.isLocalEngine)
    const priority = options.priority ?? 'chat'
    return new Promise<ScheduleSlot>((resolve, reject) => {
      if (options.signal?.aborted) {
        reject(abortError())
        return
      }
      const item: WorkItem = {
        id: this.nextId++,
        priority,
        preemptible: options.preemptible ?? false,
        enqueueAt: options.enqueueAt ?? Date.now(),
        preemptionCount: options.preemptionCount ?? 0,
        resolve,
        reject,
        settled: false
      }
      if (options.signal) {
        const onAbort = (): void => {
          const index = state.queue.indexOf(item)
          if (index >= 0) state.queue.splice(index, 1)
          item.cleanupSignal?.()
          if (!item.settled) {
            item.settled = true
            item.reject(abortError())
          }
        }
        item.cleanupSignal = () => options.signal?.removeEventListener('abort', onAbort)
        options.signal.addEventListener('abort', onAbort, { once: true })
      }
      state.queue.push(item)
      this.pump(state)
    })
  }

  private pump(state: EndpointState): void {
    state.queue.sort(
      (a, b) =>
        PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority] ||
        a.enqueueAt - b.enqueueAt ||
        a.id - b.id
    )
    while (state.queue.length > 0) {
      const head = state.queue[0]
      const limit = isForeground(head.priority)
        ? state.hardLimit
        : Math.max(1, state.hardLimit - 1)
      if (state.running.size < limit) {
        state.queue.shift()
        const slot = new SlotImpl(head)
        state.running.add(slot)
        head.settled = true
        head.cleanupSignal?.()
        head.resolve(slot)
        continue
      }
      // 前台排队且槽位已满：抢占一个低优先级、可抢占且未吐正文（或后台单次）的请求
      if (isForeground(head.priority) && this.tryPreempt(state)) continue
      break
    }
  }

  private tryPreempt(state: EndpointState): boolean {
    const victims = [...state.running]
      .filter(
        (slot) =>
          slot.item.preemptible &&
          slot.preemptionCount < 2 &&
          (!slot.emitted || slot.item.priority === 'background')
      )
      .sort((a, b) => PRIORITY_ORDER[b.item.priority] - PRIORITY_ORDER[a.item.priority])
    const victim = victims[0]
    if (!victim) return false
    victim.preempted = true
    victim.preemptionCount += 1
    state.preemptions += 1
    // 立即腾出槽位给前台；网关捕获后重新 acquire（保持原 enqueueAt），不计失败。
    state.running.delete(victim)
    victim.controller.abort(new PreemptedError())
    return true
  }

  onRelease(slot: SlotImpl): void {
    const state = [...this.endpoints.values()].find((s) => s.running.has(slot))
    if (!state) return
    state.running.delete(slot)
    this.pump(state)
  }

  reportResult(providerId: string, sample: WorkSample, now = Date.now()): void {
    const state = this.endpoint(providerId)
    const adjusted = adjustHardLimit(state, sample, now)
    state.hardLimit = adjusted.hardLimit
    state.freezeUntil = adjusted.freezeUntil
    state.penaltyUntil = adjusted.penaltyUntil
    state.penaltyMs = adjusted.penaltyMs
    state.baselineMsPer1k = adjusted.baselineMsPer1k
    this.pump(state)
  }

  stats(providerId: string): EndpointStats {
    const state = this.endpoint(providerId)
    return {
      hardLimit: state.hardLimit,
      softLimit: Math.max(1, state.hardLimit - 1),
      running: state.running.size,
      queued: state.queue.length,
      preemptions: state.preemptions,
      freezeUntil: state.freezeUntil
    }
  }

  /** 单测用：清空所有端点状态。 */
  reset(): void {
    for (const state of this.endpoints.values()) {
      for (const item of state.queue) {
        if (!item.settled) {
          item.settled = true
          item.reject(new Error('调度器已重置'))
        }
      }
      state.queue = []
      state.running.clear()
    }
    this.endpoints.clear()
  }
}

export const modelScheduler = new ModelScheduler()
