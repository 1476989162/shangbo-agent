import { computed, ref } from 'vue'
import { defineStore } from 'pinia'

/**
 * 右侧查看器状态：一次只看一个文件（或一个网页）。
 * kind 决定 FileViewer.vue 用哪种渲染器；远端 http(s) 网页直接 iframe，不走 file 通道。
 */
export type ViewerKind = 'image' | 'pdf' | 'html' | 'text' | 'doc' | 'web' | 'dir'

export interface ViewerState {
  kind: ViewerKind
  /** 标题栏显示名。 */
  title: string
  /** 工程内相对路径（kind=image/pdf/html/text/doc/dir 用）。 */
  relPath?: string
  /** 网页 URL（kind=web 用）。 */
  url?: string
  /** dataUrl（聊天图片直看用，不走 file 通道）。 */
  dataUrl?: string
  /** 文本/代码/HTML 源码内容。 */
  text?: string | null
  /** docx/xlsx 转出的 HTML。 */
  html?: string | null
  truncated?: boolean
}

export const useViewerStore = defineStore('viewer', () => {
  const current = ref<ViewerState | null>(null)
  const loading = ref(false)
  const error = ref<string | null>(null)
  const collapsed = ref(false)

  const open = computed(() => current.value !== null)

  function close(): void {
    current.value = null
    error.value = null
  }

  function toggleCollapsed(): void {
    collapsed.value = !collapsed.value
  }

  /** 聊天里的图片（已有 dataUrl / shangbo-image URL）：直接看，不走 file 通道。 */
  function openImage(title: string, src: string): void {
    collapsed.value = false
    error.value = null
    current.value = { kind: 'image', title, dataUrl: src }
  }

  /** 外部网页：iframe 直嵌。 */
  function openWeb(url: string): void {
    collapsed.value = false
    error.value = null
    current.value = { kind: 'web', title: url, url }
  }

  /** 工程内文件：经 file:read 拉回后按 mime 分发。 */
  async function openFile(conversationId: string, relPath: string): Promise<void> {
    collapsed.value = false
    loading.value = true
    error.value = null
    try {
      const file = await window.shangbo.file.read(conversationId, relPath)
      const name = file.name
      if (file.mime.startsWith('image/') || file.mime === 'image/svg+xml') {
        current.value = { kind: 'image', title: name, relPath, dataUrl: file.dataUrl ?? undefined }
      } else if (file.mime === 'application/pdf') {
        current.value = { kind: 'pdf', title: name, relPath, dataUrl: file.dataUrl ?? undefined }
      } else if (file.mime === 'text/html') {
        current.value = { kind: 'html', title: name, relPath, text: file.text, truncated: file.truncated }
      } else if (file.html) {
        current.value = { kind: 'doc', title: name, relPath, html: file.html, truncated: file.truncated }
      } else {
        current.value = {
          kind: 'text', title: name, relPath,
          text: file.text ?? '（空文件）', truncated: file.truncated
        }
      }
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
      current.value = { kind: 'text', title: relPath, relPath, text: null, truncated: false }
    } finally {
      loading.value = false
    }
  }

  return { current, loading, error, collapsed, open, close, toggleCollapsed, openImage, openWeb, openFile }
})
