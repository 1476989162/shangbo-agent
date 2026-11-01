import { computed, ref } from 'vue'
import { defineStore } from 'pinia'
import { useChatStore } from './chat'

export type WorkbenchTabKind =
  | 'new-tab'
  | 'file'
  | 'workspace'
  | 'changes'
  | 'terminal'
  | 'web'
  | 'image'
  | 'pdf'
  | 'doc'

export type ViewerKind = WorkbenchTabKind | 'text' | 'html' | 'dir'

export interface WorkbenchTab {
  id: string
  kind: WorkbenchTabKind
  title: string
  relPath?: string
  url?: string
  dataUrl?: string
  text?: string | null
  html?: string | null
  truncated?: boolean
}

export type ViewerState = WorkbenchTab

export interface ArtifactItem {
  name: string
  relPath: string
  ext: string
  toolName?: string
  size?: number
}

export const useViewerStore = defineStore('viewer', () => {
  const isOpen = ref(false)
  const collapsed = ref(false)
  const loading = ref(false)
  const error = ref<string | null>(null)
  const tabs = ref<WorkbenchTab[]>([])
  const activeTabId = ref<string>('')

  // 兼容老调用：viewer.open
  const open = computed(() => isOpen.value)

  // 兼容老调用：viewer.current
  const current = computed<ViewerState | null>(() => {
    return tabs.value.find((t) => t.id === activeTabId.value) ?? null
  })

  const activeTab = computed<WorkbenchTab | null>(() => current.value)

  function openWorkbench(tabKind: WorkbenchTabKind = 'new-tab', extra?: Partial<WorkbenchTab>): void {
    isOpen.value = true
    collapsed.value = false
    error.value = null

    const existing = tabs.value.find((t) => t.id === tabKind || (extra?.id && t.id === extra.id))
    if (existing) {
      activeTabId.value = existing.id
      return
    }

    const titles: Record<WorkbenchTabKind, string> = {
      'new-tab': '新建标签页',
      'workspace': '工作空间',
      'changes': 'Git 变更',
      'terminal': '终端',
      'file': extra?.title ?? '文件预览',
      'web': extra?.title ?? '网页预览',
      'image': extra?.title ?? '图片预览',
      'pdf': extra?.title ?? 'PDF 预览',
      'doc': extra?.title ?? '文档预览'
    }

    const newTab: WorkbenchTab = {
      id: extra?.id ?? tabKind,
      kind: tabKind,
      title: extra?.title ?? titles[tabKind] ?? '标签页',
      ...extra
    }

    tabs.value.push(newTab)
    activeTabId.value = newTab.id
  }

  function openTab(tab: WorkbenchTab): void {
    isOpen.value = true
    collapsed.value = false
    error.value = null
    const existingIndex = tabs.value.findIndex((t) => t.id === tab.id)
    if (existingIndex >= 0) {
      tabs.value[existingIndex] = { ...tabs.value[existingIndex], ...tab }
      activeTabId.value = tab.id
    } else {
      tabs.value.push(tab)
      activeTabId.value = tab.id
    }
  }

  function closeTab(tabId: string): void {
    const index = tabs.value.findIndex((t) => t.id === tabId)
    if (index < 0) return
    tabs.value.splice(index, 1)

    if (activeTabId.value === tabId) {
      if (tabs.value.length > 0) {
        const nextIndex = Math.max(0, index - 1)
        activeTabId.value = tabs.value[nextIndex].id
      } else {
        // 关闭最后一个标签页后，保持工作台打开并回到新建标签页仪表盘
        openWorkbench('new-tab')
      }
    }
  }

  function close(): void {
    isOpen.value = false
    error.value = null
  }

  function toggleCollapsed(): void {
    collapsed.value = !collapsed.value
  }

  /** 聊天里的图片：直接看，不走 file 通道。 */
  function openImage(title: string, src: string): void {
    openTab({
      id: `img:${src}`,
      kind: 'image',
      title,
      dataUrl: src
    })
  }

  /** 外部网页：iframe 直嵌。 */
  function openWeb(url: string): void {
    openTab({
      id: `web:${url}`,
      kind: 'web',
      title: url,
      url
    })
  }

  /** 工程内文件：经 file:read 拉回后按 mime 分发。 */
  async function openFile(conversationId: string, relPath: string): Promise<void> {
    isOpen.value = true
    collapsed.value = false
    loading.value = true
    error.value = null

    try {
      const file = await window.shangbo.file.read(conversationId, relPath)
      const name = file.name
      let kind: WorkbenchTabKind = 'file'
      let dataUrl: string | undefined
      let text: string | null | undefined
      let html: string | null | undefined

      if (file.mime.startsWith('image/') || file.mime === 'image/svg+xml') {
        kind = 'image'
        dataUrl = file.dataUrl ?? undefined
      } else if (file.mime === 'application/pdf') {
        kind = 'pdf'
        dataUrl = file.dataUrl ?? undefined
      } else if (file.mime === 'text/html') {
        kind = 'file'
        text = file.text
      } else if (file.html) {
        kind = 'doc'
        html = file.html
      } else {
        kind = 'file'
        text = file.text ?? '（空文件）'
      }

      openTab({
        id: `file:${relPath}`,
        kind,
        title: name,
        relPath,
        dataUrl,
        text,
        html,
        truncated: file.truncated
      })
    } catch (err) {
      error.value = err instanceof Error ? err.message : String(err)
      openTab({
        id: `file:${relPath}`,
        kind: 'file',
        title: relPath,
        relPath,
        text: null,
        truncated: false
      })
    } finally {
      loading.value = false
    }
  }

  /**
   * 自动扫描当前会话中的产物文件列表（去重）。
   * 涵盖 write_file, patch_file, create_file 等工具调用中生成的文件。
   */
  const sessionArtifacts = computed<ArtifactItem[]>(() => {
    const chat = useChatStore()
    const seen = new Set<string>()
    const artifacts: ArtifactItem[] = []

    for (const msg of chat.messages) {
      for (const block of msg.blocks) {
        if (block.type === 'tool_use') {
          const input = (block.input ?? {}) as Record<string, unknown>
          const candidatePath =
            (typeof input['path'] === 'string' && input['path']) ||
            (typeof input['filePath'] === 'string' && input['filePath']) ||
            (typeof input['targetFile'] === 'string' && input['targetFile']) ||
            (typeof input['relPath'] === 'string' && input['relPath']) ||
            (typeof input['file'] === 'string' && input['file']) ||
            null

          const isReadOrInspect =
            block.name.startsWith('read') ||
            block.name.includes('search') ||
            block.name.includes('find') ||
            block.name.includes('list')
          const isWriteOrGen =
            !isReadOrInspect &&
            (block.name.includes('write') ||
              block.name.includes('patch') ||
              block.name.includes('create') ||
              block.name === 'replace_file_content')

          if (candidatePath && isWriteOrGen) {
            const normalized = candidatePath.replace(/\\/g, '/').replace(/^\.\//, '')
            if (!seen.has(normalized)) {
              seen.add(normalized)
              const name = normalized.split('/').pop() ?? normalized
              const ext = name.includes('.') ? name.split('.').pop()?.toLowerCase() ?? '' : ''
              artifacts.push({
                name,
                relPath: normalized,
                ext,
                toolName: block.name
              })
            }
          }
        }
      }
    }

    return artifacts
  })

  return {
    isOpen,
    open,
    collapsed,
    loading,
    error,
    tabs,
    activeTabId,
    current,
    activeTab,
    openWorkbench,
    openTab,
    closeTab,
    close,
    toggleCollapsed,
    openImage,
    openWeb,
    openFile,
    sessionArtifacts
  }
})
