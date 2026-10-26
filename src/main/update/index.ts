import { BrowserWindow, Notification, app } from 'electron'
import log from 'electron-log/main'
import { autoUpdater } from 'electron-updater'
import type { UpdateInfo } from 'electron-updater'
import { IPC } from '../../shared/ipc'
import type { UpdateState } from '../../shared/types'
import { getSetting } from '../settings'
import { FEED_URL_ENV } from '../installInfo'
import { showMainWindow } from '../windows/mainWindow'
import {
  canDownload as canDownloadState,
  canInstall as canInstallState,
  initialUpdateState,
  reduceUpdateEvent,
  unsupportedState,
  type UpdaterEvent
} from './state'

/** 启动后延迟首检：避开冷启动（数据库、MCP 探测、Python 边车）最忙的那几十秒。 */
const FIRST_CHECK_DELAY_MS = 20_000
/** 之后每 24 小时检查一次。 */
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

/**
 * GitHub Release 的 releaseNotes 形态不稳定：单条时是字符串，多条时是
 * [{note, url}] 数组，老版本还可能是 [{version, url}]。渲染层只要纯文本，
 * 这里统一折叠，取不到就留空，不让界面显示 [object Object]。
 */
export function normalizeReleaseNotes(info: UpdateInfo): string | undefined {
  const notes = info.releaseNotes
  if (typeof notes === 'string') return notes.trim() || undefined
  if (Array.isArray(notes)) {
    const parts = notes
      .map((item) => {
        if (typeof item === 'string') return item
        const obj = item as { note?: unknown; version?: unknown }
        const value = obj?.note ?? obj?.version
        return typeof value === 'string' ? value : ''
      })
      .filter(Boolean)
    return parts.length ? parts.join('\n\n') : undefined
  }
  return undefined
}

class UpdateService {
  private state: UpdateState | null = null
  private timer: NodeJS.Timeout | null = null
  private firstCheck: NodeJS.Timeout | null = null
  private wired = false

  /** 当前状态快照；未 init 时给出 idle，渲染层不会拿到 undefined。 */
  getState(): UpdateState {
    return this.state ?? initialUpdateState(safeVersion())
  }

  init(): void {
    const version = safeVersion()

    if (!app.isPackaged) {
      // 开发态没有 resources/app-update.yml，electron-updater 会直接抛
      // ERR_UPDATER_INVALID_UPDATE_CONFIGURATION，这里只记录状态不接入。
      this.state = unsupportedState(version, '开发环境不启用自动更新（未打包，缺少 app-update.yml）')
      log.info('[update] 开发环境，跳过自动更新初始化')
      return
    }

    if (this.wired) return
    this.wired = true

    if (!this.state) this.state = initialUpdateState(version)

    autoUpdater.logger = log
    autoUpdater.autoInstallOnAppQuit = true
    // 只发布完整安装包，不提供 web installer：关掉它，避免更新器去下载不存在的 block 文件。
    autoUpdater.disableWebInstaller = true
    autoUpdater.autoDownload = getSetting<boolean>('app.update.autoDownload', true)

    const feedOverride = process.env[FEED_URL_ENV]
    if (feedOverride) {
      autoUpdater.setFeedURL({ provider: 'generic', url: feedOverride })
      log.warn(`[update] 更新源被 ${FEED_URL_ENV} 覆盖为 ${feedOverride}（仅用于本地验证）`)
    }

    autoUpdater.on('checking-for-update', () => this.apply({ type: 'checking-for-update' }))

    autoUpdater.on('update-available', (info) =>
      this.apply({
        type: 'update-available',
        version: String(info.version),
        releaseNotes: normalizeReleaseNotes(info),
        releaseDate: info.releaseDate
      })
    )

    autoUpdater.on('update-not-available', () => this.apply({ type: 'update-not-available' }))

    autoUpdater.on('download-progress', (info) =>
      this.apply({
        type: 'download-progress',
        percent: Number(info.percent) || 0,
        transferred: Number(info.transferred) || 0,
        total: Number(info.total) || 0
      })
    )

    autoUpdater.on('update-downloaded', (event) => {
      this.apply({ type: 'update-downloaded', version: String(event.version) })
      this.notifyReady(String(event.version))
    })

    autoUpdater.on('update-cancelled', () => this.apply({ type: 'update-cancelled' }))

    autoUpdater.on('error', (error) =>
      this.apply({ type: 'error', message: error?.message || String(error) })
    )

    if (getSetting<boolean>('app.update.check', true)) this.schedule()
    log.info(`[update] 已就绪，当前版本 ${version}`)
  }

  /** 手动检查（设置页按钮 / 托盘菜单）。 */
  async check(): Promise<UpdateState> {
    if (!app.isPackaged) return this.getState()
    autoUpdater.autoDownload = getSetting<boolean>('app.update.autoDownload', true)
    try {
      await autoUpdater.checkForUpdates()
    } catch (error) {
      // 事件里已经报过一次，这里只兜住 checkForUpdates 自身的 reject
      this.apply({ type: 'error', message: (error as Error)?.message || String(error) })
    }
    return this.getState()
  }

  /** 手动下载。状态不允许时直接返回当前状态，不抛错给渲染层。 */
  async download(): Promise<UpdateState> {
    if (!canDownloadState(this.getState())) return this.getState()
    try {
      await autoUpdater.downloadUpdate()
    } catch (error) {
      this.apply({ type: 'error', message: (error as Error)?.message || String(error) })
    }
    return this.getState()
  }

  /** 退出并安装。只在更新已下载完成时执行。 */
  install(): UpdateState {
    if (!canInstallState(this.getState())) return this.getState()
    this.apply({ type: 'install-requested' })
    log.info('[update] 用户确认安装，退出并安装更新')
    // 静默安装 + 装完自动重启，引导式安装器在 /S 下不会再弹目录页
    autoUpdater.quitAndInstall(true, true)
    return this.getState()
  }

  /** 设置改动后同步定时器与开关。 */
  syncSettings(): void {
    if (!app.isPackaged) return
    autoUpdater.autoDownload = getSetting<boolean>('app.update.autoDownload', true)
    if (getSetting<boolean>('app.update.check', true)) this.schedule()
    else this.stopSchedule()
  }

  stopSchedule(): void {
    if (this.timer) clearInterval(this.timer)
    if (this.firstCheck) clearTimeout(this.firstCheck)
    this.timer = null
    this.firstCheck = null
  }

  private schedule(): void {
    this.stopSchedule()
    this.firstCheck = setTimeout(() => void this.check(), FIRST_CHECK_DELAY_MS)
    this.timer = setInterval(() => void this.check(), CHECK_INTERVAL_MS)
  }

  private apply(event: UpdaterEvent): void {
    const current = this.getState()
    const next = reduceUpdateEvent(current, event)
    if (next === current) return
    this.state = next
    if (next.status === 'error') log.warn(`[update] ${next.error}`)
    else if (next.status !== 'downloading') log.info(`[update] 状态 → ${next.status}`)
    this.broadcast(next)
  }

  private broadcast(state: UpdateState): void {
    for (const win of BrowserWindow.getAllWindows()) {
      if (win.isDestroyed()) continue
      win.webContents.send(IPC.updateEvent, state)
    }
  }

  /** 下载完成时提醒；用户没开通知开关就只更新设置页状态。 */
  private notifyReady(version: string): void {
    if (!getSetting<boolean>('agent.notifyCompletion', true)) return
    try {
      new Notification({
        title: '尚搏 Agent 更新已下载',
        body: `新版本 ${version} 已就绪，重启后自动安装。`
      }).show()
    } catch (error) {
      log.warn('[update] 系统通知发送失败', error)
    }
  }
}

function safeVersion(): string {
  try {
    return app.getVersion()
  } catch {
    return '0.0.0'
  }
}

export const updateService = new UpdateService()

/** 托盘「检查更新」用：唤出主窗口后再检查，让用户能看到进度。 */
export function checkFromTray(): void {
  showMainWindow()
  void updateService.check()
}
