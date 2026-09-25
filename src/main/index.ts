import { BrowserWindow, app } from 'electron'
import log from 'electron-log/main'
import { closeDatabase, getDb } from './db'
import { settleOrphanStreamingMessages } from './db/repo'
import { ensureDefaultProviders } from './providers/store'
import { registerIpcHandlers } from './ipc'
import { createTray, destroyTray } from './tray'
import { createMainWindow, getMainWindow, markQuitting } from './windows/mainWindow'
import { pythonBridge } from './py/bridge'

// 固定应用名，让开发态与打包态落在同一个 userData 目录。
// 否则打包后 productName「尚搏 Agent」会另建一个目录，用户会以为数据丢了。
// 必须在 requestSingleInstanceLock 之前调用——单实例锁文件也在 userData 下。
app.setName('shangbo-agent')

// 单实例：第二次启动时唤出已有窗口，而不是再开一个进程
const gotLock = app.requestSingleInstanceLock()

if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    const window = getMainWindow()
    if (!window) return
    if (window.isMinimized()) window.restore()
    window.show()
    window.focus()
  })

  app.whenReady().then(() => {
    log.initialize()
    log.transports.file.level = 'info'
    log.info(`[app] 尚搏 Agent ${app.getVersion()} 启动`)

    // 数据库必须在任何 IPC 之前就绪
    getDb()
    settleOrphanStreamingMessages()
    ensureDefaultProviders()

    registerIpcHandlers()
    createMainWindow()
    createTray()
  })

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
  })

  // 托盘常驻：窗口关闭时不退出，只有托盘菜单的「退出」才真正结束进程
  app.on('window-all-closed', () => {
    // 故意留空
  })

  app.on('before-quit', () => {
    markQuitting()
    pythonBridge.dispose()
    destroyTray()
    closeDatabase()
  })
}