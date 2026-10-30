import { BrowserWindow, app, protocol, session, shell } from 'electron'
import { join } from 'node:path'
import log from 'electron-log/main'
import { IMAGE_PROTOCOL } from '../../shared/imageUrl'

let mainWindow: BrowserWindow | null = null
let quitting = false

// 与 index.html 的 meta CSP 保持一致。'wasm-unsafe-eval' 是窄指令：只允许
// WebAssembly 编译（Shiki 的 oniguruma 引擎需要），不放开 JS eval。
// img-src 额外放开 shangbo-image: 以便直接 <img> 渲染落在 userData 下的图片，
// 而不必把整张图以 base64 塞进页面内存。
const CSP_IMG_SRC = `'self' data: blob: ${IMAGE_PROTOCOL}:`

const DEV_CSP = `default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src ${CSP_IMG_SRC}; font-src 'self' data:; frame-src 'self' data: blob: https: http:; connect-src 'self' ws://localhost:* http://localhost:*`

let devCspRegistered = false

function registerDevCsp(devServerUrl: string): void {
  if (devCspRegistered) return
  devCspRegistered = true
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    if (details.url.startsWith(devServerUrl)) {
      callback({
        responseHeaders: {
          ...details.responseHeaders,
          'Content-Security-Policy': [DEV_CSP]
        }
      })
    } else {
      callback({})
    }
  })
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow
}

export function markQuitting(): void {
  quitting = true
}

export function isQuitting(): boolean {
  return quitting
}

/**
 * 外部链接协议白名单：只允许 http/https/mailto，其余（file://、ms-msdt:、
 * search-ms:、UNC 路径等）一律拦截。模型输出的链接会被 linkify，
 * 用户点击即触发，若不收口可能被 file:// 或伪协议带到本地执行。
 */
export function isSafeExternalUrl(raw: string): boolean {
  const url = raw.trim()
  // UNC 路径（\\server\share）直接拒绝，不走协议解析
  if (url.startsWith('\\\\')) return false
  const lower = url.toLowerCase()
  return lower.startsWith('http://') || lower.startsWith('https://') || lower.startsWith('mailto:')
}

export function safeOpenExternal(raw: string): void {
  if (isSafeExternalUrl(raw)) {
    void shell.openExternal(raw)
    return
  }
  log.warn(`[window] 已拦截不安全外部链接：${raw.slice(0, 200)}`)
}

export function createMainWindow(): BrowserWindow {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 840,
    minWidth: 940,
    minHeight: 620,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#FBFAF6',
    icon: join(__dirname, '../../resources/icon.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#FBFAF6',
      symbolColor: '#1D1B18',
      height: 40
    },
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      // preload 只用 ipcRenderer / contextBridge，完全满足 sandbox 约束；
      // 沙箱下渲染进程无法直接触碰 Node，即使 Markdown 渲染被绕过也多一层硬隔离。
      sandbox: true
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
    safeOpenExternal(url)
    return { action: 'deny' }
  })

  const devServerUrl = process.env['ELECTRON_RENDERER_URL']

  // 禁止渲染层导航到本地页面之外的位置（file:// 加载时 'self' 就是本地文件）
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = app.isPackaged ? 'file://' : devServerUrl
    if (!allowed || !url.startsWith(allowed)) {
      event.preventDefault()
      log.warn(`[window] 已拦截渲染层导航：${url}`)
      safeOpenExternal(url)
    }
  })

  if (!app.isPackaged && devServerUrl) {
    // dev 走 http://localhost，统一在响应头层面下发与 index.html 相同的策略，
    // 响应头优先于 meta，双保险。模块级只注册一次，避免窗口重建时叠加。
    registerDevCsp(devServerUrl)
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