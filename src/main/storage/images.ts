import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { app, protocol } from 'electron'
import type { ContentBlock, StoredImage } from '../../shared/types'
import { IMAGE_PROTOCOL } from '../../shared/imageUrl'

/** 落盘后的图片引用，与 shared/types 的 StoredImage 同义，此处沿用旧名以便调用方少一层转换。 */
export type ResolvedImage = StoredImage

/**
 * 粘贴图片的落盘存储。
 *
 * 为什么不把图片以 base64 存进 SQLite 的 blocks 字段：
 * 1. base64 比原图大 33%，一张 2MB 截图会变成 2.7MB 永久写进 DB；
 * 2. listMessages / getActivePath 每次都会 JSON.parse 整个 blocks，
 *    意味着读任意一条历史消息都要把所有历史图片一次性读进内存；
 * 3. 流式回复期间每轮都会重写 blocks，图片跟着被反复序列化。
 *
 * 改为「文件存盘、DB 只存相对路径」后，图片仅在真正要发给模型的瞬间
 * 才被读回成 base64，其余时间都躺在磁盘上。
 */

/** 相对路径的路径分隔符统一用 /，与平台无关，保证 DB 内容可移植。 */
const EXT_BY_MIME: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/bmp': 'bmp'
}

/** 与主进程 IPC 校验保持一致的体积上限，防止超大截图把磁盘和上下文一起打爆。 */
export const MAX_IMAGE_BYTES = 6 * 1024 * 1024

/** 图片根目录：userData/images。 */
function imagesRoot(): string {
  return join(app.getPath('userData'), 'images')
}

/** 单个会话的目录。会话 id 来自内部生成，不含路径分隔符，但仍做一次净化。 */
function conversationDir(conversationId: string): string {
  const safe = conversationId.replace(/[^A-Za-z0-9_-]/g, '_')
  return join(imagesRoot(), safe)
}

/**
 * 注册自定义协议，让渲染层能用 <img src="shangbo-image://..."> 显示磁盘上的图片。
 * 必须注册为 privileged scheme，否则 Electron 不会把它当标准 scheme 处理。
 */
export function registerImageProtocol(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: IMAGE_PROTOCOL,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true }
    }
  ])
}

/**
 * 协议处理：把 shangbo-image://img/<相对路径> 映射到真实文件。
 * 固定用 img 作为 host，相对路径只走 pathname——因为 standard scheme 下
 * Chromium 会把 host 段强制小写化，路径若塞在 host 里含大写字母就会取不到文件。
 * 任何试图逃出 images 根目录的请求一律拒绝。
 */
export function handleImageProtocol(): void {
  const root = join(imagesRoot()).replace(/\\/g, '/')
  protocol.handle(IMAGE_PROTOCOL, async (request) => {
    const url = new URL(request.url)
    const relative = decodeURIComponent(url.pathname.replace(/^\/+/, ''))
    if (!relative) return new Response('not found', { status: 404 })

    const target = join(imagesRoot(), relative).replace(/\\/g, '/')

    // 目录穿越防护：规范化后必须仍在 images 根目录内
    if (target !== root && !target.startsWith(root + '/')) {
      return new Response('forbidden', { status: 403 })
    }

    try {
      const data = await readFile(target)
      return new Response(new Uint8Array(data), {
        headers: { 'Content-Type': mimeFromPath(target), 'Cache-Control': 'no-cache' }
      })
    } catch {
      return new Response('not found', { status: 404 })
    }
  })
}

function mimeFromPath(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  for (const [mime, extension] of Object.entries(EXT_BY_MIME)) {
    if (extension === ext) return mime
  }
  return 'application/octet-stream'
}

/**
 * 把一张图片写入磁盘，返回可直接入库的相对路径（如 `abc123/9f8e....png`）。
 * 文件名用 uuid，不使用原始文件名——既避免同名冲突，也不把用户本机
 * 的目录名/截图名泄漏进数据库。
 */
export async function saveImage(
  conversationId: string,
  mimeType: string,
  data: Uint8Array
): Promise<string> {
  const ext = EXT_BY_MIME[mimeType.toLowerCase()]
  if (!ext) throw new Error(`不支持的图片类型：${mimeType}`)

  const safeId = conversationId.replace(/[^A-Za-z0-9_-]/g, '_')
  const fileName = `${randomUUID()}.${ext}`

  const dir = join(imagesRoot(), safeId)
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, fileName), data)

  // 用 / 分隔，保证 DB 里的相对路径与平台无关
  return `${safeId}/${fileName}`
}

/** 把相对路径读回成 data URL，仅在即将发给模型时调用。 */
export async function readImageAsDataUrl(relative: string): Promise<string | null> {
  try {
    const data = await readFile(join(imagesRoot(), relative))
    const mime = mimeFromPath(relative)
    return `data:${mime};base64,${data.toString('base64')}`
  } catch {
    // 图片文件丢失不应让整轮对话失败：降级为不带图的请求
    return null
  }
}

/**
 * 给一组内容块补齐 dataUrl（就地修改并返回同一数组）。
 * 已在内存里的图片（dataUrl 存在）不做任何磁盘读取。
 */
export async function hydrateImages(blocks: ContentBlock[]): Promise<ContentBlock[]> {
  for (const block of blocks) {
    if (block.type !== 'image' || block.dataUrl || !block.file) continue
    const dataUrl = await readImageAsDataUrl(block.file)
    if (dataUrl) block.dataUrl = dataUrl
  }
  return blocks
}

/** 删除会话时同步清掉它的图片目录，不留垃圾（方案 A）。 */
/** 删除单个图片文件。撤回一条排队消息时用它清理附件，避免留下孤儿文件。 */
export async function deleteImageFile(relative: string): Promise<void> {
  try {
    await rm(join(imagesRoot(), relative))
  } catch {
    // 文件可能已不存在，删除失败不应阻断撤回流程
  }
}

export async function deleteConversationImages(conversationId: string): Promise<void> {
  try {
    await rm(conversationDir(conversationId), { recursive: true, force: true })
  } catch {
    // 清理失败不应阻断会话删除
  }
}
