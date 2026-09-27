import { desktopCapturer, screen as electronScreen } from 'electron'

/**
 * Computer Use 能力层：主屏截图 + 键鼠输入。
 *
 * - 截图走 Electron 原生 desktopCapturer，不依赖第三方。
 * - 键鼠走 nut-js，原生模块缺失（dev 模式未 rebuild）时报人话，不炸进程。
 * - 坐标系：模型永远按"截图像素"给坐标，本层按比例换算到物理像素。
 *   Windows 缩放下物理像素 = DIP × scaleFactor，nut-js 的绝对坐标与之一致。
 */

export interface Screenshot {
  mimeType: 'image/jpeg'
  dataUrl: string
  /** 截图宽高（模型给坐标用的坐标系）。 */
  shotWidth: number
  shotHeight: number
  /** 物理屏幕宽高（换算目标）。 */
  realWidth: number
  realHeight: number
}

const SHOT_WIDTH = 1280

type NutApi = typeof import('@nut-tree-fork/nut-js')

let nutPromise: Promise<NutApi> | null = null

/** 延迟加载原生模块：缺失时给人话错误，而不是启动即崩。 */
export function loadNut(): Promise<NutApi> {
  if (!nutPromise) {
    nutPromise = import('@nut-tree-fork/nut-js').catch((error: unknown) => {
      nutPromise = null
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(
        `键鼠原生模块不可用（${message}）。开发模式请跑一次 npm run dist 触发 rebuild，或确认已安装 @nut-tree-fork/nut-js。`
      )
    })
  }
  return nutPromise
}

/** 截图像素 → 物理像素（钳制到屏幕内）。 */
export function toPhysical(
  x: number,
  y: number,
  shot: Pick<Screenshot, 'shotWidth' | 'shotHeight' | 'realWidth' | 'realHeight'>
): { x: number; y: number } {
  const px = Math.round((x * shot.realWidth) / shot.shotWidth)
  const py = Math.round((y * shot.realHeight) / shot.shotHeight)
  return {
    x: Math.min(Math.max(px, 0), shot.realWidth - 1),
    y: Math.min(Math.max(py, 0), shot.realHeight - 1)
  }
}

/** 常用键名 → nut Key。返回 null 表示不支持（调用方报出候选）。 */
export async function resolveKey(nut: NutApi, name: string): Promise<unknown> {
  const key = name.trim()
  const lower = key.toLowerCase()
  const aliases: Record<string, string> = {
    esc: 'Escape',
    enter: 'Enter',
    return: 'Enter',
    tab: 'Tab',
    space: 'Space',
    backspace: 'Backspace',
    delete: 'Delete',
    up: 'Up',
    down: 'Down',
    left: 'Left',
    right: 'Right',
    home: 'Home',
    end: 'End',
    pageup: 'PageUp',
    pagedown: 'PageDown'
  }
  if (/^f([1-9]|1[0-9]|2[0-4])$/i.test(key)) return readKey(nut, key.toUpperCase())
  if (aliases[lower]) return readKey(nut, aliases[lower])
  if (/^[a-z0-9]$/i.test(key)) return readKey(nut, key.toUpperCase())
  return null
}

function readKey(nut: NutApi, name: string): unknown {
  const value = (nut.Key as Record<string, unknown>)[name]
  return value === undefined ? null : value
}

export function supportedKeysHint(): string {
  return 'Enter Tab Escape Space Backspace Delete，上/下/左/右，Home End PageUp PageDown，F1～F24，单字母数字'
}

export async function takeScreenshot(): Promise<Screenshot> {
  const display = electronScreen.getPrimaryDisplay()
  const scale = display.scaleFactor || 1
  const realWidth = Math.round(display.size.width * scale)
  const realHeight = Math.round(display.size.height * scale)

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: SHOT_WIDTH, height: Math.round((SHOT_WIDTH * realHeight) / realWidth) }
  })
  const primary = sources.find((s) => s.display_id === String(display.id)) ?? sources[0]
  if (!primary) throw new Error('截不到屏幕画面：没有可用的显示源')
  const size = primary.thumbnail.getSize()
  const jpeg = primary.thumbnail.toJPEG(70)
  return {
    mimeType: 'image/jpeg',
    dataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}`,
    shotWidth: size.width,
    shotHeight: size.height,
    realWidth,
    realHeight
  }
}

export async function clickAt(x: number, y: number, button: 'left' | 'right' | 'middle', shot: Screenshot): Promise<string> {
  const nut = await loadNut()
  const pt = toPhysical(x, y, shot)
  const { Point } = nut
  await nut.mouse.setPosition(new Point(pt.x, pt.y))
  if (button === 'right') await nut.mouse.rightClick()
  else if (button === 'middle') await nut.mouse.click(nut.Button.MIDDLE)
  else await nut.mouse.leftClick()
  return `已${button === 'left' ? '左键' : button === 'right' ? '右键' : '中键'}点击（${pt.x}, ${pt.y}）`
}

export async function typeText(text: string): Promise<string> {
  const nut = await loadNut()
  await nut.keyboard.type(text)
  return `已输入 ${text.length} 个字符`
}

export async function pressKey(name: string): Promise<string> {
  const nut = await loadNut()
  const key = await resolveKey(nut, name)
  if (key === null || key === undefined) throw new Error(`不支持的按键：${name}。可用：${supportedKeysHint()}`)
  await nut.keyboard.pressKey(key as never)
  await nut.keyboard.releaseKey(key as never)
  return `已按键：${name}`
}

export async function scrollAt(direction: 'up' | 'down' | 'left' | 'right', amount: number): Promise<string> {
  const nut = await loadNut()
  const steps = Math.min(Math.max(Math.floor(amount), 1), 10)
  if (direction === 'up') await nut.mouse.scrollUp(steps)
  else if (direction === 'down') await nut.mouse.scrollDown(steps)
  else if (direction === 'left') await nut.mouse.scrollLeft(steps)
  else await nut.mouse.scrollRight(steps)
  return `已向${direction === 'up' ? '上' : direction === 'down' ? '下' : direction === 'left' ? '左' : '右'}滚动 ${steps} 格`
}
