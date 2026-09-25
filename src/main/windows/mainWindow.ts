import { BrowserWindow, app, shell } from 'electron'
import { join } from 'node:path'

let mainWindow: BrowserWindow | null = null
let quitting = false

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

export function markQuitting(): void {
  quitting = true
}

export function isQuitting(): boolean {
  return quitting
}

export function createMainWindow(): BrowserWindow {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 940,
    minHeight: 620,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#F7F7F8',
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#F7F7F8',
      symbolColor: '#171717',
      height: 40
    },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // 主进程与 preload 之间需要共享 Node 能力（后续接 MCP / 文件能力），故关闭沙箱
      sandbox: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
  })

  // 关闭按钮收起到托盘，而不是退出进程
  mainWindow.on('close', (event) => {
    if (!quitting) {
      event.preventDefault()
      mainWindow?.hide()
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // 外部链接一律交给系统浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url)
    return { action: 'deny' }
  })

  const devServerUrl = process.env['ELECTRON_RENDERER_URL']
  if (!app.isPackaged && devServerUrl) {
    void mainWindow.loadURL(devServerUrl)
  } else {
    void mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return mainWindow
}

export function showMainWindow(): void {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow()
    return
  }
  if (mainWindow.isMinimized()) mainWindow.restore()
  mainWindow.show()
  mainWindow.focus()
}

export function toggleMainWindow(): void {
  if (mainWindow && mainWindow.isVisible() && mainWindow.isFocused()) {
    mainWindow.hide()
    return
  }
  showMainWindow()
}