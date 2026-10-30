<script setup lang="ts">
import { computed, ref } from 'vue'
import { useViewerStore } from '../stores/viewer'
import { useChatStore } from '../stores/chat'
import { renderMarkdown } from '../lib/markdown'

const viewer = useViewerStore()
const chat = useChatStore()
const dirPath = ref('.')
const dirEntries = ref<{ name: string; isDirectory: boolean; size: number }[]>([])
const dirError = ref<string | null>(null)

const isMarkdown = computed(() => {
  const title = viewer.current?.title.toLowerCase() ?? ''
  return title.endsWith('.md') || title.endsWith('.markdown')
})

const renderedMarkdown = computed(() => {
  if (!isMarkdown.value) return ''
  return renderMarkdown(viewer.current?.text ?? '', { highlight: true, dark: true })
})

function formatSize(bytes: number): string {
  if (bytes <= 0) return ''
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

async function refreshDir(): Promise<void> {
  const convo = chat.activeConversationId
  if (!convo) {
    dirError.value = '请先打开一个已绑定工程目录的会话。'
    return
  }
  try {
    dirError.value = null
    const result = await window.shangbo.file.list(convo, dirPath.value)
    dirPath.value = result.dir
    dirEntries.value = result.entries
  } catch (error) {
    dirError.value = error instanceof Error ? error.message : String(error)
  }
}

function enterDir(name: string): void {
  dirPath.value = dirPath.value === '.' ? name : `${dirPath.value}/${name}`
  void refreshDir()
}

function goUp(): void {
  if (dirPath.value === '.' || !dirPath.value.includes('/')) {
    dirPath.value = '.'
  } else {
    dirPath.value = dirPath.value.slice(0, dirPath.value.lastIndexOf('/'))
  }
  void refreshDir()
}

function openEntry(entry: { name: string; isDirectory: boolean }): void {
  const convo = chat.activeConversationId
  if (!convo) return
  const rel = dirPath.value === '.' ? entry.name : `${dirPath.value}/${entry.name}`
  if (entry.isDirectory) {
    enterDir(entry.name)
    return
  }
  void viewer.openFile(convo, rel)
}

async function openExternal(): Promise<void> {
  const convo = chat.activeConversationId
  const rel = viewer.current?.relPath
  if (!convo || !rel) return
  try {
    await window.shangbo.file.open(convo, rel)
  } catch (error) {
    viewer.error = error instanceof Error ? error.message : String(error)
  }
}
</script>

<template>
  <aside class="viewer" :class="{ collapsed: viewer.collapsed }">
    <header class="viewer-header">
      <button class="btn-icon" title="收起/展开查看器" @click="viewer.toggleCollapsed">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <path d="M10 3.5L5.5 8l4.5 4.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
        </svg>
      </button>
      <div class="viewer-title" :title="viewer.current?.title ?? '文件查看器'">
        {{ viewer.current?.title ?? '文件查看器' }}
      </div>
      <button
        v-if="viewer.current?.relPath"
        class="btn btn-ghost tiny"
        title="用系统默认应用打开"
        @click="openExternal"
      >
        外部打开
      </button>
      <button v-if="viewer.current" class="btn-icon" title="关闭" @click="viewer.close">✕</button>
    </header>

    <div v-if="!viewer.collapsed" class="viewer-body">
      <div v-if="viewer.loading" class="viewer-hint">加载中…</div>
      <div v-else-if="viewer.error" class="viewer-error">{{ viewer.error }}</div>

      <template v-else-if="viewer.current">
        <div v-if="viewer.current.truncated" class="viewer-truncated">
          内容过长，仅显示前 1MB；完整内容请点「外部打开」。
        </div>
        <!-- 图片：直接显 -->
        <img
          v-if="viewer.current.kind === 'image'"
          :src="viewer.current.dataUrl"
          class="viewer-image"
          :alt="viewer.current.title"
        />
        <!-- PDF：Chromium 原生渲染 -->
        <iframe
          v-else-if="viewer.current.kind === 'pdf'"
          :src="viewer.current.dataUrl ?? undefined"
          class="viewer-frame"
          title="PDF 预览"
        />
        <!-- 本地 HTML：srcdoc，不暴露真实路径 -->
        <iframe
          v-else-if="viewer.current.kind === 'html'"
          :srcdoc="viewer.current.text ?? ''"
          class="viewer-frame"
          sandbox="allow-scripts allow-same-origin"
          title="网页预览"
        />
        <!-- 外部网页 -->
        <iframe
          v-else-if="viewer.current.kind === 'web'"
          :src="viewer.current.url"
          class="viewer-frame"
          sandbox="allow-scripts allow-same-origin"
          title="网页预览"
        />
        <!-- Markdown：复用现有渲染 -->
        <div
          v-else-if="viewer.current.kind === 'text' && isMarkdown"
          class="markdown viewer-doc"
          v-html="renderedMarkdown"
        />
        <!-- Word/表格转出的 HTML -->
        <div
          v-else-if="viewer.current.kind === 'doc'"
          class="viewer-doc"
          v-html="viewer.current.html"
        />
        <!-- 文本/代码 -->
        <pre v-else class="viewer-pre mono">{{ viewer.current.text }}</pre>
      </template>

      <!-- 文件浏览：默认工程根目录 -->
      <div class="viewer-dir">
        <div class="viewer-dir-bar">
          <span class="mono">{{ dirPath }}</span>
          <button class="btn btn-ghost tiny" @click="goUp">上级</button>
          <button class="btn btn-ghost tiny" @click="refreshDir">刷新</button>
        </div>
        <div v-if="dirError" class="viewer-error">{{ dirError }}</div>
        <div v-else class="viewer-dir-list">
          <div
            v-for="entry in dirEntries"
            :key="entry.name"
            class="viewer-dir-entry"
            @click="openEntry(entry)"
          >
            <span>{{ entry.isDirectory ? '📁' : '📄' }} {{ entry.name }}</span>
            <span v-if="!entry.isDirectory" class="subtle">{{ formatSize(entry.size) }}</span>
          </div>
          <div v-if="dirEntries.length === 0" class="viewer-hint">空目录，或点击刷新加载。</div>
        </div>
      </div>
    </div>
  </aside>
</template>

<style scoped>
.viewer {
  display: flex;
  flex-direction: column;
  min-width: 0;
  width: 420px;
  border-left: 1px solid var(--border);
  background: var(--bg-elevated);
  height: 100%;
  overflow: hidden;
}
.viewer.collapsed {
  width: 40px;
}
.viewer-header {
  display: flex;
  align-items: center;
  gap: 6px;
  height: var(--titlebar-height);
  padding: 0 8px;
  border-bottom: 1px solid var(--border);
  flex: none;
}
.viewer-title {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  font-weight: 600;
}
.viewer.collapsed .viewer-title,
.viewer.collapsed .viewer-body {
  display: none;
}
.viewer-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.viewer-image {
  max-width: 100%;
  border-radius: 8px;
  border: 1px solid var(--border);
}
.viewer-frame {
  width: 100%;
  min-height: 480px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: #fff;
}
.viewer-pre {
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 12px;
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px;
  max-height: 480px;
  overflow: auto;
}
.viewer-doc {
  font-size: 13px;
  line-height: 1.6;
  background: #fff;
  color: #111;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
  max-height: 520px;
  overflow: auto;
}
.viewer-doc table {
  border-collapse: collapse;
  width: 100%;
}
.viewer-doc td,
.viewer-doc th {
  border: 1px solid #ccc;
  padding: 4px 8px;
  font-size: 12px;
}
.viewer-hint {
  color: var(--text-muted);
  font-size: 12px;
}
.viewer-error {
  color: var(--danger, #c00);
  font-size: 12px;
}
.viewer-truncated {
  font-size: 11px;
  color: var(--text-muted);
}
.viewer-dir {
  border-top: 1px solid var(--border);
  padding-top: 8px;
}
.viewer-dir-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  margin-bottom: 6px;
}
.viewer-dir-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  max-height: 260px;
  overflow: auto;
}
.viewer-dir-entry {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  font-size: 12px;
  padding: 4px 6px;
  border-radius: 6px;
  cursor: pointer;
}
.viewer-dir-entry:hover {
  background: var(--surface-hover);
}
.btn-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 6px;
  color: var(--text-muted);
}
.btn-icon:hover {
  background: var(--surface-hover);
  color: var(--text);
}
</style>
