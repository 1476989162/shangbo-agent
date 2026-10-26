import type { UpdateState } from '../../shared/types'

/**
 * electron-updater 的事件太多且形态不一（不同平台字段不一样），这里先归一成一个
 * 窄 union，再由 reduceUpdateEvent 统一管状态迁移——状态机只在这一处定义，
 * 才能不依赖 Electron 直接单测。
 */
export type UpdaterEvent =
  | { type: 'checking-for-update' }
  | { type: 'update-available'; version: string; releaseNotes?: string; releaseDate?: string }
  | { type: 'update-not-available'; version?: string }
  | { type: 'download-progress'; percent: number; transferred: number; total: number }
  | { type: 'update-downloaded'; version: string }
  | { type: 'update-cancelled'; version?: string }
  | { type: 'install-requested' }
  | { type: 'error'; message: string }

export function initialUpdateState(currentVersion: string): UpdateState {
  return { status: 'idle', currentVersion, updatedAt: Date.now() }
}

export function unsupportedState(currentVersion: string, reason: string): UpdateState {
  return { status: 'unsupported', currentVersion, reason, updatedAt: Date.now() }
}

/** 手动重试：error/notAvailable/idle 都可以重新进入 checking。installing 之后不再接受事件。 */
export function canCheckAgain(state: UpdateState): boolean {
  return state.status !== 'installing' && state.status !== 'unsupported'
}

/**
 * 把一次更新事件折叠进状态。返回新对象（不改原状态）；事件与状态不匹配时
 * 原样返回，调用方据此跳过广播。
 */
export function reduceUpdateEvent(state: UpdateState, event: UpdaterEvent): UpdateState {
  if (state.status === 'unsupported' || state.status === 'installing') return state

  const base = { ...state, updatedAt: Date.now() }

  switch (event.type) {
    case 'checking-for-update':
      return {
        ...base,
        status: 'checking',
        error: undefined,
        newVersion: undefined,
        percent: undefined,
        transferred: undefined,
        total: undefined
      }

    case 'update-available':
      return {
        ...base,
        status: 'available',
        newVersion: event.version,
        releaseNotes: event.releaseNotes,
        releaseDate: event.releaseDate,
        checkedAt: Date.now(),
        error: undefined
      }

    case 'update-not-available':
      return {
        ...base,
        status: 'notAvailable',
        newVersion: undefined,
        percent: undefined,
        checkedAt: Date.now(),
        error: undefined
      }

    case 'download-progress': {
      // 进度只可能出现在 available→downloading→ready 之间，其他阶段收到就丢弃，
      // 否则渲染层的进度条会从「已是最新」这类状态里凭空冒出来。
      if (state.status !== 'available' && state.status !== 'downloading') return state
      return {
        ...base,
        status: 'downloading',
        percent: clampPercent(event.percent),
        transferred: Math.max(0, event.transferred),
        total: Math.max(0, event.total)
      }
    }

    case 'update-downloaded':
      if (!event.version) return state
      return {
        ...base,
        status: 'ready',
        newVersion: event.version,
        percent: 100,
        error: undefined
      }

    case 'update-cancelled':
      return {
        ...base,
        status: state.newVersion ? 'available' : 'idle',
        percent: undefined,
        transferred: undefined,
        total: undefined
      }

    case 'install-requested':
      // 只允许从 ready 进入安装：没下载完就退出并安装等于什么都没发生。
      if (state.status !== 'ready') return state
      return { ...base, status: 'installing' }

    case 'error':
      return { ...base, status: 'error', error: event.message || '更新失败' }

    default:
      return state
  }
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value) || value < 0) return 0
  return Math.min(100, Math.round(value * 10) / 10)
}

/** 状态是否允许再次下载（用于拒绝渲染层在下载已完成/未开始时的重复触发）。 */
export function canDownload(state: UpdateState): boolean {
  // 已知有新版本时才允许下载：available 是正常路径，error 是下载失败后的重试，
  // 其余状态（checking/notAvailable/ready/downloading）都不该再发起下载。
  return Boolean(state.newVersion) && (state.status === 'available' || state.status === 'error')
}

export function canInstall(state: UpdateState): boolean {
  return state.status === 'ready'
}
