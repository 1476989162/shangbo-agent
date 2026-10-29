import { BrowserWindow, app } from 'electron'
import log from 'electron-log/main'
import { closeDatabase, getDb } from './db'
import { settleOrphanStreamingMessages } from './db/repo'
import { ensureDefaultProviders } from './providers/store'
import { registerIpcHandlers } from './ipc'
import { createTray, destroyTray } from './tray'
import { remoteService } from './remote/service'
import { updateService } from './update'
import { createMainWindow, getMainWindow, markQuitting } from './windows/mainWindow'
import { pythonBridge } from './py/bridge'
import { handleImageProtocol, registerImageProtocol } from './storage/images'
import { autonomousScheduler } from './autonomous/scheduler'
import { settleOrphanAutonomousRuns } from './autonomous/store'
import { mcpManager } from './mcp/manager'
// 固定应用名，让开发态与打包态落在同一个 userData 目录。
// 否则打包后 productName「尚搏 Agent」会另建一个目录，用户会以为数据丢了。
// 必须在 requestSingleInstanceLock 之前调用——单实例锁文件也在 userData 下。
app.setName('shangbo-agent')

// 必须在 app ready 之前声明：否则 Chromium 不会把 shangbo-image 当标准
// scheme 处理，<img src="shangbo-image://..."> 会直接加载失败。
registerImageProtocol()

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
    settleOrphanAutonomousRuns()
    ensureDefaultProviders()

    registerIpcHandlers()
    handleImageProtocol()
    createMainWindow()
    createTray()
    // 远程默认关闭：仅当用户在设置中手动开启后才连接中转
    try {
      remoteService.sync()
    } catch (error) {
      log.warn('[app] 远程模块初始化失败（不影响主流程）', error)
    }
    // 自动更新放在最后：它要读设置里的开关，且不参与首屏渲染，慢一点无妨
    updateService.init()
    // 许愿式自主任务：默认关闭；用户开启后由主进程常驻调度。
    autonomousScheduler.start()
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
    autonomousScheduler.stop()
    pythonBridge.dispose()
    // MCP 子进程必须在这里收尾：常驻复用是设计选择，但退出时没人杀就会留下
    // 孤儿 node 进程（npx 的 cmd → npx → node 三层，只杀第一层等于没杀）。
    // 用同步版：before-quit 是同步回调，异步 await 不阻塞退出。
    mcpManager.shutdownSync()
    destroyTray()
    closeDatabase()
  })}
