import { stat, readdir, readFile } from 'node:fs/promises'
import { basename, extname, resolve, relative, sep } from 'node:path'
import { shell } from 'electron'
import { getConversation } from '../db/repo'
import { guardPrivatePath } from '../tools'
import { pythonBridge } from '../py/bridge'

/** 右侧查看器单文件上限：10MB，超出只提示用系统应用打开。 */
export const VIEWER_MAX_BYTES = 10 * 1024 * 1024
/** 文本预览上限：1MB，超出截断。 */
const TEXT_PREVIEW_MAX = 1 * 1024 * 1024

const TEXT_EXTS = new Set([
  'txt', 'md', 'markdown', 'json', 'jsonc', 'xml', 'yml', 'yaml', 'toml', 'ini', 'csv', 'tsv',
  'ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'vue', 'html', 'htm', 'css', 'scss', 'less',
  'py', 'rs', 'go', 'java', 'c', 'h', 'cpp', 'hpp', 'cs', 'rb', 'php', 'swift', 'kt',
  'sql', 'sh', 'bash', 'ps1', 'bat', 'cmd', 'dockerfile', 'gitignore', 'env', 'log'
])

const IMAGE_MIMES: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
  webp: 'image/webp', gif: 'image/gif', bmp: 'image/bmp', svg: 'image/svg+xml'
}

function mimeOf(name: string): string {
  const ext = extname(name).slice(1).toLowerCase()
  if (IMAGE_MIMES[ext]) return IMAGE_MIMES[ext]
  if (ext === 'pdf') return 'application/pdf'
  if (ext === 'html' || ext === 'htm') return 'text/html'
  if (ext === 'csv') return 'text/csv'
  if (ext === 'docx') return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  if (ext === 'xlsx') return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  if (ext === 'xls') return 'application/vnd.ms-excel'
  if (ext === 'doc') return 'application/msword'
  if (TEXT_EXTS.has(ext)) return ext === 'html' || ext === 'htm' ? 'text/html' : 'text/plain'
  return 'application/octet-stream'
}

/**
 * 会话工程目录解析 + 越界防护。
 * 无绑定 workingDir 直接拒绝；解析后必须仍在工程目录内；私有目录禁入。
 */
export function resolveViewerPath(conversationId: string, relPath: string): { root: string; abs: string } {
  const convo = getConversation(conversationId)
  const root = convo?.workingDir?.trim()
  if (!root) throw new Error('该会话未绑定工程目录，请先绑定后再预览文件。')
  const abs = resolve(root, relPath || '.')
  const normRoot = resolve(root)
  if (abs !== normRoot && !abs.startsWith(normRoot + sep)) {
    throw new Error('越界：只能预览当前工程目录内的文件。')
  }
  guardPrivatePath(abs)
  return { root: normRoot, abs }
}

export interface ViewerFile {
  name: string
  mime: string
  size: number
  text: string | null
  dataUrl: string | null
  /** docx/xlsx 经边车转出的 HTML（前端直接 v-html）。 */
  html: string | null
  truncated: boolean
}

export async function readViewerFile(conversationId: string, relPath: string): Promise<ViewerFile> {
  const { abs } = resolveViewerPath(conversationId, relPath)
  const info = await stat(abs)
  if (info.isDirectory()) throw new Error('这是目录，请用文件列表进入后再选文件。')
  if (info.size > VIEWER_MAX_BYTES) {
    throw new Error(`文件过大（${(info.size / 1024 / 1024).toFixed(1)}MB），请用系统默认应用打开查看。`)
  }
  const name = basename(abs)
  const mime = mimeOf(name)
  const ext = extname(name).slice(1).toLowerCase()

  // 图片 / PDF：dataUrl 直显（Chromium 原生可渲）。
  if (mime.startsWith('image/') || ext === 'svg' || mime === 'application/pdf') {
    const buf = await readFile(abs)
    return {
      name, mime, size: info.size, text: null, html: null, truncated: false,
      dataUrl: `data:${mime};base64,${buf.toString('base64')}`
    }
  }

  // HTML：文本下发，前端用 srcdoc 渲染（不暴露真实路径）。
  if (mime === 'text/html') {
    const buf = await readFile(abs)
    const slice = buf.subarray(0, TEXT_PREVIEW_MAX)
    return {
      name, mime, size: info.size, html: null, dataUrl: null,
      text: slice.toString('utf8'), truncated: buf.length > TEXT_PREVIEW_MAX
    }
  }

  // Word / 表格：走 Python 边车转 HTML，失败则回可读错误。
  if (['docx', 'xlsx', 'xls', 'csv'].includes(ext)) {
    try {
      const parsed = await pythonBridge.call<{ html: string; truncated: boolean }>(
        'parse_document', { path: abs }, 60_000
      )
      return { name, mime, size: info.size, text: null, dataUrl: null, html: parsed.html, truncated: parsed.truncated }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw new Error(`文档解析失败：${reason}`)
    }
  }

  // 文本 / 代码：按文本下发。
  if (mime === 'text/plain' || mime === 'text/csv' || TEXT_EXTS.has(ext) || !ext) {
    const buf = await readFile(abs)
    if (buf.includes(0)) throw new Error('二进制文件，无法以文本预览，请用系统默认应用打开。')
    const slice = buf.subarray(0, TEXT_PREVIEW_MAX)
    return {
      name, mime, size: info.size, html: null, dataUrl: null,
      text: slice.toString('utf8'), truncated: buf.length > TEXT_PREVIEW_MAX
    }
  }

  throw new Error(`暂不支持预览该类型（.${ext || '未知'}），请用系统默认应用打开。`)
}

export async function listViewerDir(conversationId: string, relPath = '.'): Promise<{
  dir: string
  entries: { name: string; isDirectory: boolean; size: number }[]
}> {
  const { root, abs } = resolveViewerPath(conversationId, relPath)
  const info = await stat(abs)
  if (!info.isDirectory()) throw new Error('不是目录。')
  const dirents = await readdir(abs, { withFileTypes: true })
  const entries = await Promise.all(
    dirents.slice(0, 500).map(async (entry) => {
      if (entry.isDirectory()) return { name: entry.name, isDirectory: true, size: 0 }
      try {
        const st = await stat(resolve(abs, entry.name))
        return { name: entry.name, isDirectory: false, size: st.size }
      } catch {
        return { name: entry.name, isDirectory: false, size: 0 }
      }
    })
  )
  entries.sort((a, b) =>
    a.isDirectory === b.isDirectory ? a.name.localeCompare(b.name) : a.isDirectory ? -1 : 1
  )
  return { dir: relative(root, abs) || '.', entries }
}

export async function openViewerFile(conversationId: string, relPath: string): Promise<boolean> {
  const { abs } = resolveViewerPath(conversationId, relPath)
  const info = await stat(abs)
  if (info.isDirectory()) throw new Error('这是目录，无法用系统应用打开。')
  const result = await shell.openPath(abs)
  if (result) throw new Error(result)
  return true
}
