import { randomUUID } from 'node:crypto'

/**
 * Screen Lane：全局唯一的屏幕键鼠互斥车道（对标 Linger architecture.md）。
 *
 * 三条硬规则：
 * 1. 带副作用的物理输入严格 FIFO 串行；只读的截图/快照/列窗口不进车道，可并发。
 * 2. 每次物理动作执行前预写 WAL（in_flight）；执行结果未知（超时/异常）时记为
 *    unknown，并永久禁止用同一 opId 重放——防止重复点击「支付 / 发送」类按钮。
 * 3. 用户提供过目标窗口（desktop_snapshot 的 windowId / app）时，动作前检查前台
 *    焦点；用户切走就停手，绝不把窗口拉回来抢焦点。
 *
 * 纯内存实现，不依赖 electron / DB / 具体桌面后端，可独立单测。
 */
export type ScreenOperationState = 'in_flight' | 'done' | 'unknown' | 'aborted'

export interface ScreenOperationMeta {
  conversationId: string
  toolName: string
  /** 目标摘要（坐标 / ref / 文本），只用于审计，不含敏感内容。 */
  target?: string
  opId?: string
  /** 上一次快照锁定的窗口 id */
  expectedWindowId?: string
  /** 上一次快照锁定的应用名 */
  expectedApp?: string
}

export interface ScreenLogEntry extends ScreenOperationMeta {
  opId: string
  timestamp: number
  state: ScreenOperationState
  detail?: string
}

export interface FocusSnapshot {
  windowId?: string
  app?: string
}

export type FocusProvider = () => Promise<FocusSnapshot | null>

export class FocusLostError extends Error {
  constructor() {
    super('检测到用户已切换前台窗口，已暂停自动键鼠输入以免干扰你的操作')
    this.name = 'FocusLostError'
  }
}

export class ScreenLaneError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ScreenLaneError'
  }
}

const MAX_LOG_ENTRIES = 100

class ScreenLane {
  private queue: Array<() => void> = []
  private locked = false
  private log: ScreenLogEntry[] = []
  private focusProvider: FocusProvider | null = null

  setFocusProvider(provider: FocusProvider | null): void {
    this.focusProvider = provider
  }

  /** 审计日志快照（内存环状缓冲区，最多 100 条）。 */
  getLog(): ScreenLogEntry[] {
    return this.log.map((entry) => ({ ...entry }))
  }

  /** 状态未知的操作禁止重放：调用方必须重新截图/快照确认界面状态。 */
  isReplayForbidden(opId: string): boolean {
    return this.log.some((entry) => entry.opId === opId && entry.state === 'unknown')
  }

  async runExclusive<T>(meta: ScreenOperationMeta, operation: () => Promise<T> | T): Promise<T> {
    const opId = meta.opId ?? randomUUID()
    if (this.isReplayForbidden(opId)) {
      throw new ScreenLaneError(
        `操作 ${opId} 上次执行状态未知，已禁止自动重放。请先重新 desktop_snapshot / computer_screenshot 确认界面状态。`
      )
    }
    const entry: ScreenLogEntry = {
      ...meta,
      opId,
      timestamp: Date.now(),
      state: 'in_flight'
    }
    this.append(entry)

    await this.acquire()
    try {
      await this.assertFocus(entry)
      const result = await operation()
      entry.state = 'done'
      return result
    } catch (error) {
      if (error instanceof FocusLostError) {
        // 明确没有执行，状态确定，可标记为 aborted（不属于「未知」）
        entry.state = 'aborted'
        entry.detail = error.message
        throw error
      }
      entry.state = 'unknown'
      entry.detail = error instanceof Error ? error.message : String(error)
      throw new ScreenLaneError(
        `桌面操作状态未知（opId=${opId}），已禁止自动重放。请先重新 desktop_snapshot / computer_screenshot 确认界面状态，再决定是否继续。原始错误：${entry.detail}`
      )
    } finally {
      this.release()
    }
  }

  private async assertFocus(entry: ScreenLogEntry): Promise<void> {
    if (!this.focusProvider || !(entry.expectedWindowId || entry.expectedApp)) return
    let current: FocusSnapshot | null
    try {
      current = await this.focusProvider()
    } catch {
      // 焦点探测本身失败不阻断操作（宁可放行，也不要因为辅助进程没起就卡死）
      return
    }
    if (!current) return
    const windowMismatch =
      !!entry.expectedWindowId &&
      !!current.windowId &&
      current.windowId !== entry.expectedWindowId
    const appMismatch =
      !windowMismatch &&
      !!entry.expectedApp &&
      !!current.app &&
      !current.app.toLowerCase().includes(entry.expectedApp.toLowerCase())
    if (windowMismatch || appMismatch) throw new FocusLostError()
  }

  private acquire(): Promise<void> {
    return new Promise((resolve) => {
      if (!this.locked) {
        this.locked = true
        resolve()
        return
      }
      this.queue.push(() => {
        this.locked = true
        resolve()
      })
    })
  }

  private release(): void {
    this.locked = false
    const next = this.queue.shift()
    if (next) next()
  }

  private append(entry: ScreenLogEntry): void {
    if (this.log.length >= MAX_LOG_ENTRIES) this.log.shift()
    this.log.push(entry)
  }

  /** 单测用：清空队列、日志与焦点提供者。 */
  resetForTesting(): void {
    this.queue = []
    this.locked = false
    this.log = []
    this.focusProvider = null
  }
}

export const screenLane = new ScreenLane()
