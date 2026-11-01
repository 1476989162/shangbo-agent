<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useViewerStore, type WorkbenchTabKind } from '../stores/viewer'
import { useChatStore } from '../stores/chat'
import { renderMarkdown } from '../lib/markdown'
import { t } from '../i18n'

const viewer = useViewerStore()
const chat = useChatStore()

// ----------------------------------------------------
// 工作空间浏览器 (workspace)
// ----------------------------------------------------
const dirPath = ref('.')
const dirEntries = ref<{ name: string; isDirectory: boolean; size: number }[]>([])
const dirError = ref<string | null>(null)

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

function formatSize(bytes: number): string {
  if (bytes <= 0) return ''
  if (bytes < 1024) return `${bytes}B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`
  return `${(bytes / 1024 / 1024).toFixed(1)}MB`
}

// ----------------------------------------------------
// Git 变更视图 (changes)
// ----------------------------------------------------
const gitStatusText = ref('')
const gitDiffText = ref('')
const gitLoading = ref(false)

async function refreshGitChanges(): Promise<void> {
  const dir = chat.activeConversation?.workingDir
  if (!dir) {
    gitStatusText.value = '当前会话未绑定工程目录。'
    gitDiffText.value = ''
    return
  }
  gitLoading.value = true
  try {
    const [status, diff] = await Promise.all([
      window.shangbo.app.getGitStatus(dir),
      window.shangbo.app.getGitDiff(dir)
    ])
    gitStatusText.value = status || '无文件状态变更。'
    gitDiffText.value = diff || ''
  } catch (e: any) {
    gitStatusText.value = `获取 Git 状态失败：${e.message || String(e)}`
    gitDiffText.value = ''
  } finally {
    gitLoading.value = false
  }
}

// ----------------------------------------------------
// 终端控制台 (terminal)
// ----------------------------------------------------
const terminalCommand = ref('')
const terminalOutput = ref<Array<{ cmd: string; stdout: string; stderr: string; exitCode: number }>>([])
const terminalRunning = ref(false)
const terminalScrollEl = ref<HTMLElement | null>(null)
const commandHistory = ref<string[]>([])
let historyIndex = -1

async function runTerminalCommand(): Promise<void> {
  const cmd = terminalCommand.value.trim()
  if (!cmd || terminalRunning.value) return
  const dir = chat.activeConversation?.workingDir || null
  commandHistory.value.push(cmd)
  historyIndex = -1
  terminalRunning.value = true
  terminalCommand.value = ''
  try {
    const res = await window.shangbo.app.execCommand(cmd, dir)
    terminalOutput.value.push({
      cmd,
      stdout: res.stdout,
      stderr: res.stderr,
      exitCode: res.exitCode
    })
  } catch (err: any) {
    terminalOutput.value.push({
      cmd,
      stdout: '',
      stderr: err.message || String(err),
      exitCode: 1
    })
  } finally {
    terminalRunning.value = false
    await nextTick()
    if (terminalScrollEl.value) {
      terminalScrollEl.value.scrollTop = terminalScrollEl.value.scrollHeight
    }
  }
}

function handleTerminalKeydown(e: KeyboardEvent): void {
  if (e.key === 'ArrowUp') {
    if (commandHistory.value.length === 0) return
    e.preventDefault()
    if (historyIndex === -1) {
      historyIndex = commandHistory.value.length - 1
    } else if (historyIndex > 0) {
      historyIndex--
    }
    terminalCommand.value = commandHistory.value[historyIndex] ?? ''
  } else if (e.key === 'ArrowDown') {
    e.preventDefault()
    if (historyIndex !== -1 && historyIndex < commandHistory.value.length - 1) {
      historyIndex++
      terminalCommand.value = commandHistory.value[historyIndex] ?? ''
    } else {
      historyIndex = -1
      terminalCommand.value = ''
    }
  }
}

function clearTerminal(): void {
  terminalOutput.value = []
}

// ----------------------------------------------------
// 网页预览 (web)
// ----------------------------------------------------
const webUrlInput = ref('')

function navigateWeb(): void {
  let url = webUrlInput.value.trim()
  if (!url) return
  if (!/^https?:\/\//i.test(url)) {
    url = `https://${url}`
  }
  if (viewer.activeTab && viewer.activeTab.kind === 'web') {
    viewer.activeTab.url = url
    viewer.activeTab.title = url
  }
}

// ----------------------------------------------------
// 产物中心搜索与过滤 (new-tab)
// ----------------------------------------------------
const artifactFilter = ref('')
const filteredArtifacts = computed(() => {
  const q = artifactFilter.value.trim().toLowerCase()
  if (!q) return viewer.sessionArtifacts
  return viewer.sessionArtifacts.filter(
    (a) => a.name.toLowerCase().includes(q) || a.relPath.toLowerCase().includes(q)
  )
})

function getExtIcon(ext: string): string {
  switch (ext) {
    case 'ts':
    case 'tsx':
    case 'js':
    case 'jsx':
      return '📜'
    case 'vue':
      return '💚'
    case 'html':
    case 'htm':
      return '🌐'
    case 'css':
    case 'scss':
    case 'less':
      return '🎨'
    case 'json':
      return '🔧'
    case 'md':
    case 'markdown':
      return '📝'
    case 'png':
    case 'jpg':
    case 'jpeg':
    case 'svg':
    case 'gif':
    case 'webp':
      return '🖼️'
    case 'pdf':
      return '📑'
    case 'xlsx':
    case 'xls':
    case 'csv':
      return '📊'
    case 'docx':
    case 'doc':
      return '📄'
    case 'bat':
    case 'cmd':
    case 'ps1':
    case 'sh':
      return '⚙️'
    default:
      return '📄'
  }
}

function getTabIcon(kind: WorkbenchTabKind): string {
  switch (kind) {
    case 'new-tab':
      return '🧭'
    case 'workspace':
      return '📁'
    case 'changes':
      return '🔀'
    case 'terminal':
      return '🐚'
    case 'web':
      return '🌐'
    case 'image':
      return '🖼️'
    case 'pdf':
      return '📑'
    case 'doc':
      return '📊'
    case 'file':
    default:
      return '📄'
  }
}

async function openArtifactExternal(relPath: string): Promise<void> {
  const convo = chat.activeConversationId
  if (!convo) return
  const fullWorkingDir = chat.activeConversation?.workingDir
  if (fullWorkingDir) {
    const full = `${fullWorkingDir.replace(/[\\/]+$/, '')}/${relPath.replace(/^[\\/]+/, '')}`
    await window.shangbo.app.openPath(full)
  } else {
    await window.shangbo.file.open(convo, relPath)
  }
}

async function openExternal(): Promise<void> {
  const convo = chat.activeConversationId
  const rel = viewer.activeTab?.relPath
  if (!convo || !rel) return
  try {
    await window.shangbo.file.open(convo, rel)
  } catch (error) {
    viewer.error = error instanceof Error ? error.message : String(error)
  }
}

// ----------------------------------------------------
// Markdown 与文本渲染
// ----------------------------------------------------
const isMarkdown = computed(() => {
  const title = viewer.activeTab?.title.toLowerCase() ?? ''
  return title.endsWith('.md') || title.endsWith('.markdown')
})

const renderedMarkdown = computed(() => {
  if (!isMarkdown.value) return ''
  return renderMarkdown(viewer.activeTab?.text ?? '', { highlight: true, dark: true })
})

// 监听活动标签页变化
watch(
  () => viewer.activeTab?.kind,
  (newKind) => {
    if (newKind === 'workspace') {
      void refreshDir()
    } else if (newKind === 'changes') {
      void refreshGitChanges()
    } else if (newKind === 'web') {
      webUrlInput.value = viewer.activeTab?.url ?? 'https://cn.bing.com'
    }
  },
  { immediate: true }
)

onMounted(() => {
  if (viewer.tabs.length === 0) {
    viewer.openWorkbench('new-tab')
  }
})
</script>

<template>
  <aside class="viewer" :class="{ collapsed: viewer.collapsed }">
    <!-- 顶部工作台多标签页栏 -->
    <header class="viewer-header">
      <button class="btn-icon" title="收起/展开工作台" @click="viewer.toggleCollapsed">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <path
            d="M10 3.5L5.5 8l4.5 4.5"
            stroke="currentColor"
            stroke-width="1.4"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
      </button>

      <div class="tabs-scroll-area">
        <div class="tabs-list">
          <div
            v-for="tab in viewer.tabs"
            :key="tab.id"
            class="workbench-tab"
            :class="{ active: tab.id === viewer.activeTabId }"
            :title="tab.title"
            @click="viewer.activeTabId = tab.id"
          >
            <span class="tab-glyph">{{ getTabIcon(tab.kind) }}</span>
            <span class="tab-title">{{ tab.title }}</span>
            <button
              class="tab-close-btn"
              title="关闭标签页"
              @click.stop="viewer.closeTab(tab.id)"
            >
              ×
            </button>
          </div>
        </div>
        <button
          class="btn-new-tab"
          title="新建标签页"
          @click="viewer.openWorkbench('new-tab')"
        >
          +
        </button>
      </div>

      <div class="header-actions">
        <button
          v-if="viewer.activeTab?.relPath"
          class="btn btn-ghost tiny"
          title="用系统默认应用打开"
          @click="openExternal"
        >
          {{ t('workbench.externalOpen') }}
        </button>
        <button class="btn-icon" title="关闭工作台" @click="viewer.close">✕</button>
      </div>
    </header>

    <!-- 工作台正文区 -->
    <div v-if="!viewer.collapsed" class="viewer-body">
      <div v-if="viewer.loading" class="viewer-loading-state">
        <div class="loading-spinner" />
        <span>加载中…</span>
      </div>
      <div v-else-if="viewer.error" class="viewer-error">{{ viewer.error }}</div>

      <template v-else-if="viewer.activeTab">
        <!-- 1. 新建标签页 / 仪表盘与产物中心 -->
        <div v-if="viewer.activeTab.kind === 'new-tab'" class="dashboard-pane">
          <div class="dashboard-hero">
            <div class="hero-badge">{{ t('workbench.title') }}</div>
            <h3 class="hero-heading">智能辅助与会话产物中心</h3>
            <p class="hero-desc">
              快速访问工程工作空间、实时查看 Git 代码变更、运行终端指令，或管理对话过程中生成的文件产物。
            </p>
          </div>

          <!-- 4 大核心快捷卡片 -->
          <div class="quick-cards-grid">
            <div
              class="quick-card"
              @click="viewer.openWorkbench('web', { id: 'web:default', title: '网页预览', url: 'https://cn.bing.com' })"
            >
              <div class="card-icon">🌐</div>
              <div class="card-info">
                <div class="card-title">{{ t('workbench.openBrowser') }}</div>
                <div class="card-sub">内置 Chromium 页面沙盒</div>
              </div>
            </div>

            <div
              class="quick-card"
              @click="viewer.openWorkbench('workspace', { id: 'workspace', title: '工作空间' })"
            >
              <div class="card-icon">📁</div>
              <div class="card-info">
                <div class="card-title">{{ t('workbench.viewWorkspace') }}</div>
                <div class="card-sub">浏览工程目录树与结构</div>
              </div>
            </div>

            <div
              class="quick-card"
              @click="viewer.openWorkbench('changes', { id: 'changes', title: 'Git 变更' })"
            >
              <div class="card-icon">🔀</div>
              <div class="card-info">
                <div class="card-title">{{ t('workbench.viewChanges') }}</div>
                <div class="card-sub">追踪文件修改与彩色 Diff</div>
              </div>
            </div>

            <div
              class="quick-card"
              @click="viewer.openWorkbench('terminal', { id: 'terminal', title: '终端' })"
            >
              <div class="card-icon">🐚</div>
              <div class="card-info">
                <div class="card-title">{{ t('workbench.openTerminal') }}</div>
                <div class="card-sub">在工作目录下执行命令</div>
              </div>
            </div>
          </div>

          <!-- 产物 (N) 视图与管理 -->
          <div class="artifacts-section">
            <div class="artifacts-header">
              <div class="artifacts-title">
                <span class="artifacts-icon">📦</span>
                <span>{{ t('workbench.artifacts') }}</span>
                <span class="artifacts-badge">{{ viewer.sessionArtifacts.length }}</span>
              </div>
              <input
                v-if="viewer.sessionArtifacts.length > 3"
                v-model="artifactFilter"
                type="text"
                placeholder="搜索产物文件名..."
                class="artifacts-search"
              />
            </div>

            <div v-if="filteredArtifacts.length > 0" class="artifacts-list">
              <div
                v-for="item in filteredArtifacts"
                :key="item.relPath"
                class="artifact-card"
                @click="chat.activeConversationId && viewer.openFile(chat.activeConversationId, item.relPath)"
              >
                <div class="artifact-main">
                  <span class="artifact-ext-icon">{{ getExtIcon(item.ext) }}</span>
                  <div class="artifact-details">
                    <div class="artifact-name" :title="item.relPath">{{ item.name }}</div>
                    <div class="artifact-path">{{ item.relPath }}</div>
                  </div>
                </div>
                <div class="artifact-actions">
                  <span v-if="item.toolName" class="artifact-tag">{{ item.toolName }}</span>
                  <button
                    class="btn-artifact-open"
                    title="用外部应用打开"
                    @click.stop="openArtifactExternal(item.relPath)"
                  >
                    ↗
                  </button>
                </div>
              </div>
            </div>
            <div v-else class="artifacts-empty">
              <div class="empty-icon">📂</div>
              <p class="empty-text">{{ t('workbench.noArtifacts') }}</p>
              <span class="empty-sub">智能体执行写入、修补或创建的文件将自动收录在此</span>
            </div>
          </div>
        </div>

        <!-- 2. 工作空间浏览 -->
        <div v-else-if="viewer.activeTab.kind === 'workspace'" class="workspace-pane">
          <div class="dir-nav-bar">
            <span class="dir-path-mono mono" :title="dirPath">{{ dirPath }}</span>
            <div class="dir-nav-btns">
              <button class="btn btn-ghost tiny" @click="goUp">上级</button>
              <button class="btn btn-ghost tiny" @click="refreshDir">刷新</button>
            </div>
          </div>
          <div v-if="dirError" class="viewer-error">{{ dirError }}</div>
          <div v-else class="dir-entries-list">
            <div
              v-for="entry in dirEntries"
              :key="entry.name"
              class="dir-entry-row"
              @click="openEntry(entry)"
            >
              <span class="entry-icon">{{ entry.isDirectory ? '📁' : '📄' }}</span>
              <span class="entry-name">{{ entry.name }}</span>
              <span v-if="!entry.isDirectory" class="entry-size subtle">{{ formatSize(entry.size) }}</span>
            </div>
            <div v-if="dirEntries.length === 0" class="viewer-hint">目录为空或正在加载中。</div>
          </div>
        </div>

        <!-- 3. Git 变更 -->
        <div v-else-if="viewer.activeTab.kind === 'changes'" class="changes-pane">
          <div class="changes-header">
            <div class="changes-meta">
              <span class="branch-pill">🌿 {{ chat.currentBranch || '未初始化 Git' }}</span>
            </div>
            <button class="btn btn-ghost tiny" :disabled="gitLoading" @click="refreshGitChanges">
              {{ gitLoading ? '刷新中…' : '刷新变更' }}
            </button>
          </div>

          <div class="git-status-section">
            <div class="section-title">文件修改状态</div>
            <pre class="git-status-pre mono">{{ gitStatusText }}</pre>
          </div>

          <div class="git-diff-section">
            <div class="section-title">差异内容 (Diff)</div>
            <div v-if="!gitDiffText" class="viewer-hint">工作区干净，无未暂存的代码改动。</div>
            <pre v-else class="git-diff-pre mono"><code><template v-for="(line, idx) in gitDiffText.split('\n')" :key="idx"><span :class="{ 'diff-add': line.startsWith('+') && !line.startsWith('+++'), 'diff-del': line.startsWith('-') && !line.startsWith('---'), 'diff-chunk': line.startsWith('@@'), 'diff-header': line.startsWith('diff ') || line.startsWith('index ') }">{{ line }}
</span></template></code></pre>
          </div>
        </div>

        <!-- 4. 终端控制台 -->
        <div v-else-if="viewer.activeTab.kind === 'terminal'" class="terminal-pane">
          <div class="terminal-header">
            <span class="terminal-cwd mono" :title="chat.activeConversation?.workingDir || '未绑定工作目录'">
              📁 {{ chat.activeConversation?.workingDir || '未绑定工作目录' }}
            </span>
            <button class="btn btn-ghost tiny" @click="clearTerminal">清空</button>
          </div>

          <div ref="terminalScrollEl" class="terminal-output-container mono">
            <div v-if="terminalOutput.length === 0" class="terminal-welcome">
              WorkBuddy 终端控制台已就绪。在下方输入 Shell 命令并按回车执行。
            </div>
            <div v-for="(item, idx) in terminalOutput" :key="idx" class="terminal-entry">
              <div class="entry-cmd">
                <span class="cmd-prompt">&gt;</span>
                <span class="cmd-text">{{ item.cmd }}</span>
                <span
                  class="cmd-code"
                  :class="item.exitCode === 0 ? 'exit-ok' : 'exit-fail'"
                >
                  [{{ item.exitCode }}]
                </span>
              </div>
              <pre v-if="item.stdout" class="cmd-stdout">{{ item.stdout }}</pre>
              <pre v-if="item.stderr" class="cmd-stderr">{{ item.stderr }}</pre>
            </div>
          </div>

          <div class="terminal-input-bar">
            <span class="input-prompt mono">&gt;</span>
            <input
              v-model="terminalCommand"
              type="text"
              class="terminal-input mono"
              placeholder="输入命令（如 git status, npm run test）..."
              :disabled="terminalRunning"
              @keydown.enter="runTerminalCommand"
              @keydown="handleTerminalKeydown"
            />
            <button
              class="btn btn-primary tiny"
              :disabled="terminalRunning || !terminalCommand.trim()"
              @click="runTerminalCommand"
            >
              {{ terminalRunning ? '运行中…' : '执行' }}
            </button>
          </div>
        </div>

        <!-- 5. 网页预览 -->
        <div v-else-if="viewer.activeTab.kind === 'web'" class="web-pane">
          <div class="web-nav-bar">
            <input
              v-model="webUrlInput"
              type="text"
              class="web-url-input"
              placeholder="https://..."
              @keydown.enter="navigateWeb"
            />
            <button class="btn btn-ghost tiny" @click="navigateWeb">转到</button>
          </div>
          <iframe
            :src="viewer.activeTab.url"
            class="viewer-frame"
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            title="网页预览"
          />
        </div>

        <!-- 6. 图片预览 -->
        <div v-else-if="viewer.activeTab.kind === 'image'" class="image-pane">
          <img
            :src="viewer.activeTab.dataUrl"
            class="viewer-image"
            :alt="viewer.activeTab.title"
          />
        </div>

        <!-- 7. PDF 预览 -->
        <div v-else-if="viewer.activeTab.kind === 'pdf'" class="frame-pane">
          <iframe
            :src="viewer.activeTab.dataUrl ?? undefined"
            class="viewer-frame"
            title="PDF 预览"
          />
        </div>

        <!-- 8. Word/表格等 HTML 预览 -->
        <div
          v-else-if="viewer.activeTab.kind === 'doc'"
          class="viewer-doc"
          v-html="viewer.activeTab.html"
        />

        <!-- 9. 文件文本 / 代码 / Markdown 预览 -->
        <div v-else class="file-content-pane">
          <div v-if="viewer.activeTab.truncated" class="viewer-truncated">
            内容过长，仅显示前 1MB；完整内容请点右上角「外部打开」。
          </div>

          <div
            v-if="isMarkdown"
            class="markdown viewer-doc"
            v-html="renderedMarkdown"
          />

          <pre v-else class="viewer-pre mono"><code>{{ viewer.activeTab.text }}</code></pre>
        </div>
      </template>
    </div>
  </aside>
</template>

<style scoped>
.viewer {
  display: flex;
  flex-direction: column;
  min-width: 0;
  width: 100%;
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
  height: var(--titlebar-height, 38px);
  padding: 0 6px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-card, #1c1d22);
  flex: none;
}
.tabs-scroll-area {
  display: flex;
  align-items: center;
  flex: 1;
  min-width: 0;
  overflow-x: auto;
  gap: 4px;
}
.tabs-scroll-area::-webkit-scrollbar {
  display: none;
}
.tabs-list {
  display: flex;
  align-items: center;
  gap: 3px;
}
.workbench-tab {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 8px;
  border-radius: 6px;
  font-size: 11px;
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  max-width: 140px;
  user-select: none;
  transition: all 0.15s ease;
  border: 1px solid transparent;
}
.workbench-tab:hover {
  background: var(--surface-hover);
  color: var(--text);
}
.workbench-tab.active {
  background: var(--bg);
  color: var(--primary, #3b82f6);
  border-color: var(--border);
  font-weight: 500;
}
.tab-glyph {
  font-size: 12px;
}
.tab-title {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tab-close-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  border-radius: 3px;
  font-size: 11px;
  line-height: 1;
  color: var(--text-muted);
  opacity: 0.6;
}
.tab-close-btn:hover {
  background: var(--surface-hover);
  color: var(--danger, #f43f5e);
  opacity: 1;
}
.btn-new-tab {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 4px;
  font-size: 14px;
  color: var(--text-muted);
  cursor: pointer;
}
.btn-new-tab:hover {
  background: var(--surface-hover);
  color: var(--text);
}
.header-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: none;
}
.viewer.collapsed .tabs-scroll-area,
.viewer.collapsed .header-actions,
.viewer.collapsed .viewer-body {
  display: none;
}
.viewer-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
}
.viewer-loading-state {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  height: 100%;
  color: var(--text-muted);
  font-size: 12px;
}
.loading-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid var(--border);
  border-top-color: var(--primary, #3b82f6);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}
.viewer-error {
  padding: 12px;
  color: var(--danger, #f43f5e);
  font-size: 12px;
}
.viewer-hint {
  color: var(--text-muted);
  font-size: 12px;
  padding: 8px 0;
}

/* 1. Dashboard Pane */
.dashboard-pane {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 18px;
}
.dashboard-hero {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.hero-badge {
  align-self: flex-start;
  padding: 2px 8px;
  border-radius: 9999px;
  font-size: 10px;
  font-weight: 600;
  background: rgba(59, 130, 246, 0.12);
  color: var(--primary, #3b82f6);
  border: 1px solid rgba(59, 130, 246, 0.2);
}
.hero-heading {
  font-size: 15px;
  font-weight: 700;
  color: var(--text);
  margin: 0;
}
.hero-desc {
  font-size: 11px;
  line-height: 1.5;
  color: var(--text-muted);
  margin: 0;
}
.quick-cards-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 10px;
}
.quick-card {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--bg);
  border: 1px solid var(--border);
  cursor: pointer;
  transition: all 0.15s ease;
}
.quick-card:hover {
  border-color: var(--primary, #3b82f6);
  background: var(--surface-hover);
  transform: translateY(-1px);
}
.card-icon {
  font-size: 18px;
}
.card-info {
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow: hidden;
}
.card-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--text);
}
.card-sub {
  font-size: 10px;
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Artifacts Section */
.artifacts-section {
  display: flex;
  flex-direction: column;
  gap: 10px;
  border-top: 1px solid var(--border);
  padding-top: 14px;
}
.artifacts-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}
.artifacts-title {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}
.artifacts-badge {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  padding: 1px 6px;
  border-radius: 9999px;
  font-size: 10px;
  background: rgba(59, 130, 246, 0.15);
  color: var(--primary, #3b82f6);
}
.artifacts-search {
  padding: 3px 8px;
  border-radius: 4px;
  border: 1px solid var(--border);
  background: var(--bg);
  color: var(--text);
  font-size: 11px;
  width: 140px;
}
.artifacts-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.artifact-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 7px 10px;
  border-radius: 6px;
  background: var(--bg);
  border: 1px solid var(--border);
  cursor: pointer;
  transition: all 0.15s ease;
}
.artifact-card:hover {
  background: var(--surface-hover);
  border-color: var(--primary, #3b82f6);
}
.artifact-main {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 1;
}
.artifact-ext-icon {
  font-size: 16px;
  flex: none;
}
.artifact-details {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.artifact-name {
  font-size: 12px;
  font-weight: 500;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.artifact-path {
  font-size: 10px;
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.artifact-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
}
.artifact-tag {
  font-size: 9px;
  padding: 1px 5px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.05);
  color: var(--text-muted);
}
.btn-artifact-open {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  border-radius: 4px;
  font-size: 11px;
  color: var(--text-muted);
}
.btn-artifact-open:hover {
  background: var(--surface-hover);
  color: var(--primary, #3b82f6);
}
.artifacts-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 28px 12px;
  border: 1px dashed var(--border);
  border-radius: 8px;
  gap: 6px;
  text-align: center;
}
.empty-icon {
  font-size: 24px;
  opacity: 0.6;
}
.empty-text {
  font-size: 12px;
  color: var(--text);
  margin: 0;
}
.empty-sub {
  font-size: 10px;
  color: var(--text-muted);
}

/* 2. Workspace Pane */
.workspace-pane {
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  height: 100%;
}
.dir-nav-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--border);
}
.dir-path-mono {
  font-size: 11px;
  color: var(--text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dir-nav-btns {
  display: flex;
  gap: 4px;
  flex: none;
}
.dir-entries-list {
  display: flex;
  flex-direction: column;
  gap: 2px;
  overflow-y: auto;
  flex: 1;
}
.dir-entry-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  border-radius: 5px;
  cursor: pointer;
  font-size: 12px;
}
.dir-entry-row:hover {
  background: var(--surface-hover);
}
.entry-icon {
  font-size: 13px;
  flex: none;
}
.entry-name {
  flex: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.entry-size {
  font-size: 10px;
  flex: none;
}

/* 3. Changes Pane */
.changes-pane {
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: 100%;
  overflow-y: auto;
}
.changes-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.branch-pill {
  font-size: 11px;
  font-weight: 500;
  padding: 2px 7px;
  border-radius: 4px;
  background: var(--surface-hover);
  color: var(--text);
}
.section-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-muted);
  margin-bottom: 4px;
}
.git-status-pre {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 11px;
  max-height: 140px;
  overflow-y: auto;
  white-space: pre-wrap;
  color: var(--text);
}
.git-diff-pre {
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 10px;
  font-size: 11px;
  overflow-x: auto;
  line-height: 1.45;
  color: var(--text);
}
.diff-add {
  color: #10b981;
  background: rgba(16, 185, 129, 0.1);
  display: block;
}
.diff-del {
  color: #ef4444;
  background: rgba(239, 68, 68, 0.1);
  display: block;
}
.diff-chunk {
  color: #06b6d4;
  font-weight: 600;
  display: block;
}
.diff-header {
  color: var(--text-muted);
  font-weight: 600;
  display: block;
}

/* 4. Terminal Pane */
.terminal-pane {
  display: flex;
  flex-direction: column;
  height: 100%;
  background: #0d1117;
}
.terminal-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 10px;
  background: #161b22;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}
.terminal-cwd {
  font-size: 10px;
  color: #8b949e;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.terminal-output-container {
  flex: 1;
  overflow-y: auto;
  padding: 10px;
  font-size: 11px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  color: #c9d1d9;
}
.terminal-welcome {
  color: #8b949e;
  font-style: italic;
  font-size: 11px;
}
.terminal-entry {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.entry-cmd {
  display: flex;
  align-items: center;
  gap: 6px;
  font-weight: 600;
  color: #58a6ff;
}
.cmd-code {
  font-size: 10px;
  padding: 1px 4px;
  border-radius: 3px;
}
.cmd-code.exit-ok {
  color: #3fb950;
}
.cmd-code.exit-fail {
  color: #f85149;
}
.cmd-stdout {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-all;
  color: #c9d1d9;
  line-height: 1.4;
}
.cmd-stderr {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-all;
  color: #f85149;
  line-height: 1.4;
}
.terminal-input-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  background: #161b22;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}
.input-prompt {
  color: #58a6ff;
  font-weight: 700;
}
.terminal-input {
  flex: 1;
  background: transparent;
  border: none;
  outline: none;
  color: #f0f6fc;
  font-size: 11px;
}

/* 5. Web Pane */
.web-pane {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.web-nav-bar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-bottom: 1px solid var(--border);
  background: var(--bg);
}
.web-url-input {
  flex: 1;
  padding: 4px 8px;
  border-radius: 4px;
  border: 1px solid var(--border);
  background: var(--bg-elevated);
  color: var(--text);
  font-size: 11px;
}

/* 6, 7, 8, 9. Standard content panes */
.file-content-pane,
.image-pane,
.frame-pane {
  padding: 12px;
  display: flex;
  flex-direction: column;
  gap: 10px;
  height: 100%;
}
.viewer-image {
  max-width: 100%;
  border-radius: 8px;
  border: 1px solid var(--border);
}
.viewer-frame {
  width: 100%;
  flex: 1;
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
  overflow: auto;
  line-height: 1.5;
  margin: 0;
  flex: 1;
}
.viewer-doc {
  font-size: 13px;
  line-height: 1.6;
  background: #fff;
  color: #111;
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 12px;
  overflow: auto;
  flex: 1;
}
.viewer-truncated {
  font-size: 11px;
  color: var(--text-muted);
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
