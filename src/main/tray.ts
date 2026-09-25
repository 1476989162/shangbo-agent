import { Menu, Tray, app, nativeImage } from 'electron'
import log from 'electron-log/main'
import { markQuitting, showMainWindow, toggleMainWindow } from './windows/mainWindow'

let tray: Tray | null = null

/**
 * 用代码生成托盘图标，避免依赖外部图标资源。
 * 16×16 的品牌色圆点：createFromBitmap 在 Windows 上使用 BGRA 字节序。
 */
function buildTrayIcon(): Electron.NativeImage {
  const size = 16
  const buffer = Buffer.alloc(size * size * 4)
  const center = (size - 1) / 2
  const radius = 6.4

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      // 边缘做一点抗锯齿，避免托盘区出现毛刺
      const distance = Math.hypot(x - center, y - center)
      const alpha = distance <= radius - 0.5 ? 255 : distance <= radius + 0.5 ? 128 : 0
      const offset = (y * size + x) * 4
      buffer[offset] = 0x78 // B
      buffer[offset + 1] = 0xdc // G
      buffer[offset + 2] = 0x0f // R
      buffer[offset + 3] = alpha
    }
  }

  const image = nativeImage.createFromBitmap(buffer, { width: size, height: size })
  return image.resize({ width: 16, height: 16 })
}

export function createTray(): void {
  if (tray) return
  try {
    tray = new Tray(buildTrayIcon())
  } catch (error) {
    log.error('[tray] 创建托盘图标失败，应用将无法常驻后台', error)
    return
  }

  tray.setToolTip('尚搏 Agent')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: '打开尚搏 Agent', click: () => showMainWindow() },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          markQuitting()
          app.quit()
        }
      }
    ])
  )

  // 左键单击：在显示与隐藏之间切换，符合常见桌面助手习惯
  tray.on('click', () => toggleMainWindow())
  log.info('[tray] 托盘已就绪')
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
}