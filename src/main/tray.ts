import { Menu, Tray, app, nativeImage } from 'electron'
import log from 'electron-log/main'
import { markQuitting, showMainWindow, toggleMainWindow } from './windows/mainWindow'
import { checkFromTray } from './update'
import { remoteService, type PairingInfo } from './remote/service'
import type { RemoteStatus } from './remote/client'

let tray: Tray | null = null
/** 当前远程状态（托盘菜单与图标用，remoteService 回调更新）。 */
let remoteState: RemoteStatus = 'off'
let remoteDetail = ''

/**
 * 用代码生成托盘图标，避免依赖外部图标资源。
 * 16×16 的品牌色圆点：createFromBitmap 在 Windows 上使用 BGRA 字节序。
 * 远程开启时图标变色（绿点加白环），有手机在线时 tooltip 显示“手机已连接”。
 */
function buildTrayIcon(remoteOn: boolean): Electron.NativeImage {
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
      if (remoteOn) {
        // 远程开启：绿色圆点（B=0x2e G=0xcc R=0x71，#71cc2e 近似）
        buffer[offset] = 0x2e // B
        buffer[offset + 1] = 0xcc // G
        buffer[offset + 2] = 0x22 // R
      } else {
        buffer[offset] = 0x78 // B
        buffer[offset + 1] = 0xdc // G
        buffer[offset + 2] = 0x0f // R
      }
      buffer[offset + 3] = alpha
    }
  }

  const image = nativeImage.createFromBitmap(buffer, { width: size, height: size })
  return image.resize({ width: 16, height: 16 })
}

function refreshTrayMenu(): void {
  if (!tray) return
  const remoteOn = remoteState === 'online' || remoteState === 'connecting' || remoteState === 'reconnecting'
  const template: Electron.MenuItemConstructorOptions[] = [
    { label: '打开尚搏 Agent', click: () => showMainWindow() },
    { label: '检查更新…', click: () => checkFromTray() },
    { type: 'separator' },
    remoteOn
      ? {
          label: '立即断开所有远程设备并关闭远程功能',
          click: () => {
            remoteService.disconnectAll()
            showMainWindow()
          }
        }
      : {
          label: '手机远程：未开启（在设置中开启）',
          enabled: false
        },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        markQuitting()
        app.quit()
      }
    }
  ]
  tray.setContextMenu(Menu.buildFromTemplate(template))
  tray.setImage(buildTrayIcon(remoteOn))
  tray.setToolTip(remoteOn ? `尚搏 Agent（手机远程${remoteState === 'online' ? '已连接' : remoteState}）` : '尚搏 Agent')
}

export function createTray(): void {
  if (tray) return
  try {
    tray = new Tray(buildTrayIcon(false))
  } catch (error) {
    log.error('[tray] 创建托盘图标失败，应用将无法常驻后台', error)
    return
  }

  tray.setToolTip('尚搏 Agent')
  refreshTrayMenu()

  // 订阅远程状态：图标变色 + 菜单项切换 + 一键断开
  remoteService.onStatus((status, detail) => {
    remoteState = status
    remoteDetail = detail ?? ''
    void remoteDetail
    refreshTrayMenu()
  })

  // 左键单击：在显示与隐藏之间切换，符合常见桌面助手习惯
  tray.on('click', () => toggleMainWindow())
  log.info('[tray] 托盘已就绪')
}

export function destroyTray(): void {
  tray?.destroy()
  tray = null
}

/** 供单测：当前托盘记录的远程状态。 */
export function getTrayRemoteState(): { status: RemoteStatus; detail: string } {
  return { status: remoteState, detail: remoteDetail }
}

export type { PairingInfo }
