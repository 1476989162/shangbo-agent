<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import type { Message } from '@shared/types'
import { useChatStore } from '../stores/chat'
import type { BranchInfo } from '../stores/chat'
import MessageItem from './MessageItem.vue'
import ApprovalPanel from './ApprovalPanel.vue'
import ComposerPanel from './ComposerPanel.vue'
import ChatStatusPanel from './ChatStatusPanel.vue'
import logoImg from '../assets/logo.png'

interface ComposerPanelExpose {
  editMessage(payload: { content: string; parentId: string | null }): void
  setDraft(text: string): void
}

const emit = defineEmits<{ openSettings: [tab?: string] }>()
const store = useChatStore()
const composerRef = ref<ComposerPanelExpose | null>(null)

const scrollEl = ref<HTMLElement | null>(null)
const pinnedToBottom = ref(true)

/** 导出结果的一行临时提示，几秒后自动消失。 */
const exportHint = ref<string | null>(null)
let exportTimer: ReturnType<typeof setTimeout> | null = null

const path = computed(() => store.activePath)

const lastAssistantId = computed(() => {
  for (let index = path.value.length - 1; index >= 0; index--) {
    if (path.value[index].role === 'assistant') return path.value[index].id
  }
  return null
})

/**
 * 计算某条助手消息的分支导航信息：
 * 同一条用户消息下的所有助手回复按时间排序，当前这条位于第几个。
 */
function branchInfo(message: Message): BranchInfo | null {
  if (message.role !== 'assistant' || !message.parentId) return null
  const siblings = store.messages.filter(
    (item) => item.parentId === message.parentId && item.role === 'assistant'
  )
  if (siblings.length < 2) return null
  const ordered = [...siblings].sort(
    (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)
  )
  const index = ordered.findIndex((item) => item.id === message.id)
  if (index < 0) return null
  return {
    index: index + 1,
    total: ordered.length,
    prevId: index > 0 ? ordered[index - 1].id : null,
    nextId: index < ordered.length - 1 ? ordered[index + 1].id : null
  }
}

/** 用最后一条消息的内容长度作为滚动触发器，避免对整个消息树做深度侦听。 */
const contentTick = computed(() => {
  const last = path.value[path.value.length - 1]
  if (!last) return 0
  return last.blocks.reduce((total, block) => {
    if (block.type === 'text' || block.type === 'reasoning') return total + block.text.length
    if (block.type === 'tool_result') return total + block.content.length
    return total
  }, 0)
})

let smoothScrolling = false

function onScroll(): void {
  if (smoothScrolling) return
  const element = scrollEl.value
  if (!element) return
  pinnedToBottom.value = element.scrollHeight - element.scrollTop - element.clientHeight < 90
}

function scrollToBottom(): void {
  const element = scrollEl.value
  if (element) element.scrollTop = element.scrollHeight
}

function scrollToBottomSmooth(): void {
  const element = scrollEl.value
  if (!element) return
  smoothScrolling = true
  pinnedToBottom.value = true
  element.scrollTo({
    top: element.scrollHeight,
    behavior: 'smooth'
  })
  setTimeout(() => {
    smoothScrolling = false
    const el = scrollEl.value
    if (el) {
      pinnedToBottom.value = el.scrollHeight - el.scrollTop - el.clientHeight < 90
    }
  }, 400)
}

/**
 * 首次挂载或切换会话时，Markdown、图片和折叠活动行可能在同一轮内继续改变高度。
 * 只在 nextTick 后滚一次会停在“旧高度”的底部；等两帧再按最终高度同步一次。
 */
async function scrollToBottomAfterLayout(): Promise<void> {
  await nextTick()
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
  scrollToBottom()
}

watch([contentTick, () => path.value.length], async () => {
  if (!pinnedToBottom.value) return
  await scrollToBottomAfterLayout()
})

watch(
  () => store.activeConversationId,
  async () => {
    pinnedToBottom.value = true
    await scrollToBottomAfterLayout()
  }
)

function onEdit(payload: { content: string; parentId: string | null }): void {
  composerRef.value?.editMessage(payload)
}

function applySuggestion(text: string): void {
  composerRef.value?.setDraft(text)
}

async function onAutoContinue(messageId: string): Promise<void> {
  await store.autoContinue(messageId)
}

async function exportConversation(): Promise<void> {
  const result = await store.exportConversation()
  if (result.canceled) return
  exportHint.value = result.ok ? `已导出至 ${result.path}` : `导出失败：${result.message ?? '未知错误'}`
  if (exportTimer) clearTimeout(exportTimer)
  exportTimer = setTimeout(() => (exportHint.value = null), 4000)
}

onBeforeUnmount(() => {
  if (exportTimer) clearTimeout(exportTimer)
})

/** 项目目录按钮上显示的短名：取路径最后一段，未绑定时提示选择。 */
const folderLabel = computed(() => {
  const dir = store.activeConversation?.workingDir
  if (!dir) return '未绑定工程目录'
  const segments = dir.split(/[\\/]/).filter(Boolean)
  return segments[segments.length - 1] ?? dir
})

function formatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp
  const minutes = Math.floor(diff / 60000)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes}分钟前`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}小时前`
  const days = Math.floor(hours / 24)
  if (days < 30) return `${days}天前`
  return `${Math.floor(days / 30)}个月前`
}

/**
 * 这条用户消息是否已经有助手回复挂在它下面。
 * 排队中的消息主进程尚未创建助手节点，用它区分
 * 「已发送、正在等回复」与「还在队列里没轮到」。
 */
function hasAssistantReply(userMessageId: string): boolean {
  return store.messages.some(
    (item) => item.parentId === userMessageId && item.role === 'assistant'
  )
}

const suggestions = [
  '分析当前工作区目录结构，并总结架构特点与核心模块',
  '检查 Git 提交状态与分支变更情况',
  '整理最近待办需求，生成一份 Markdown 任务计划表'
]
</script>

<template>
  <main class="chat" :class="{ 'code-mode': store.viewMode === 'code' }">
    <!-- 顶部导航栏 -->
    <header class="chat-header">
      <div class="header-left">
        <!-- 侧边栏展开按钮（折叠时显示） -->
        <button
          v-if="store.sidebarCollapsed"
          class="btn-icon"
          title="展开侧边栏"
          @click="store.sidebarCollapsed = false"
        >
          <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
            <rect x="2" y="2" width="12" height="12" rx="2" stroke="currentColor" stroke-width="1.3" />
            <line x1="6" y1="2" x2="6" y2="14" stroke="currentColor" stroke-width="1.3" />
          </svg>
        </button>

        <div class="breadcrumb">
          <span v-if="store.activeConversation?.workingDir" class="dir-badge">
            📁 {{ folderLabel }}
            <span class="crumb-separator">/</span>
          </span>
          <h1 class="chat-title">{{ store.activeConversation?.title ?? '尚搏 Agent' }}</h1>
        </div>
      </div>

      <div class="header-actions">
        <span v-if="exportHint" class="export-hint subtle">{{ exportHint }}</span>

        <button
          v-if="path.length > 0"
          class="btn btn-ghost tiny"
          :disabled="store.isStreaming"
          title="导出当前会话分支为 Markdown"
          @click="exportConversation"
        >
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
            <path d="M4 12h8M8 3v6M5.5 6.5L8 9l2.5-2.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
          </svg>
          导出
        </button>

        <button class="btn btn-ghost tiny" title="打开系统设置" @click="emit('openSettings', 'preferences')">
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
            <circle cx="8" cy="8" r="2.2" stroke="currentColor" stroke-width="1.3" />
            <path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
          </svg>
        </button>
      </div>
    </header>

    <!-- 主内容滚动区域 -->
    <div ref="scrollEl" class="chat-scroll" @scroll="onScroll">
      <div class="chat-column">
        <!-- 欢迎仪表盘 (对话为空时展示) -->
        <section v-if="path.length === 0" class="dashboard-welcome">
          <div class="welcome-banner">
            <img :src="logoImg" class="welcome-brand-logo" alt="尚搏 Logo" />
            <h2 class="welcome-heading">欢迎回来，{{ store.userName }}</h2>
          </div>

          <!-- 最近会话列表 -->
          <div v-if="store.recentSessions.length > 0" class="sessions-section">
            <h3 class="section-title">最近会话</h3>
            <div class="sessions-list">
              <div
                v-for="session in store.recentSessions.slice(0, 5)"
                :key="session.id"
                class="session-card"
                :class="{ active: session.id === store.activeConversationId }"
                @click="store.openConversation(session.id)"
              >
                <div class="session-left">
                  <span
                    class="session-status-badge"
                    :class="session.status"
                  >
                    <span class="status-indicator-dot" />
                    {{ session.status === 'needs_input' ? '等待操作' : session.status === 'in_progress' ? '正在生成' : '已就绪' }}
                  </span>
                  <span class="session-card-title">{{ session.title }}</span>
                </div>

                <div class="session-right">
                  <span class="session-project-tag" :title="session.projectDir ?? '通用项目'">
                    {{ session.projectName }}
                  </span>
                  <span class="session-time subtle">{{ formatRelativeTime(session.updatedAt) }}</span>
                  <svg class="session-arrow" width="12" height="12" viewBox="0 0 16 16" fill="none">
                    <path d="M6 3.5L10.5 8L6 12.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
                  </svg>
                </div>
              </div>
            </div>
          </div>

          <!-- 快速灵感建议条目 -->
          <div class="quick-suggestions">
            <div
              v-for="(item, index) in suggestions"
              :key="index"
              class="suggestion-chip"
              @click="applySuggestion(item)"
            >
              <span class="chip-spark">✦</span>
              <span class="chip-text">{{ item }}</span>
            </div>
          </div>
        </section>

        <!-- 正常对话消息流 (时间正序，提问在上，回答紧随其后) -->
        <template v-else>
          <MessageItem
            v-for="message in path"
            :key="message.id"
            :message="message"
            :is-last="message.id === lastAssistantId && !store.isStreaming"
            :branch="branchInfo(message)"
            :queued="message.role === 'user' && message.status !== 'aborted' && !hasAssistantReply(message.id)"
            @regenerate="store.regenerate"
            @switch-branch="store.switchBranch"
            @edit="onEdit"
            @auto-continue="onAutoContinue"
            @edit-queued="store.editQueued"
            @cancel-queued="store.cancelQueued"
            @steer-queued="store.steerQueued"
          />
        </template>
      </div>
    </div>

    <!-- 底部操作与通知区域 -->
    <div class="chat-footer">
      <div class="chat-column">
        <!-- 工具审批卡片 (整合 Freebuff 级安全审计与护栏) -->
        <ApprovalPanel
          v-if="store.approval"
          :approval="store.approval"
          @decide="store.decideApproval"
        />

        <!-- 任务清单、重试/降级/错误通知与回到底部按钮 -->
        <ChatStatusPanel
          :todos="store.todoItems"
          :retry="store.retryInfo"
          :switch-notice="store.switchNotice"
          :error="store.lastError"
          :can-scroll-to-bottom="!pinnedToBottom && path.length > 0"
          :streaming="store.isStreaming"
          @stop="store.stop()"
          @dismiss-switch-notice="store.dismissSwitchNotice()"
          @dismiss-error="store.dismissError()"
          @scroll-to-bottom="scrollToBottomSmooth"
        />
        <!-- 输入区、编辑提示与待发图片预览已拆至 ComposerPanel.vue -->
        <ComposerPanel ref="composerRef" @open-settings="emit('openSettings', $event)" />

        <p class="footer-note subtle">
          {{ store.usableProviders.length === 0 ? '提示：请在设置中配置有效 API Key 以激活 Agent 能力' : '回答基于本机 Agent 工作区上下文生成' }}
        </p>
      </div>
    </div>
  </main>
</template>

<style scoped>
.chat {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  height: 100%;
  background: var(--bg);
  position: relative;
}

/* 顶部导航 */
.chat-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  height: var(--titlebar-height);
  padding: 0 20px;
  flex: none;
  border-bottom: 1px solid var(--border);
  -webkit-app-region: drag;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  -webkit-app-region: no-drag;
}

.btn-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  transition: all 0.12s ease;
}

.btn-icon:hover {
  background: var(--surface-hover);
  color: var(--text);
}

.breadcrumb {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.dir-badge {
  font-size: 12px;
  color: var(--text-muted);
  display: flex;
  align-items: center;
  gap: 4px;
}

.crumb-separator {
  color: var(--text-subtle);
  margin-left: 2px;
}

.chat-title {
  margin: 0;
  font-size: var(--text-sm);
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  -webkit-app-region: no-drag;
}

.export-hint {
  font-size: 11px;
}

/* 滚动区 */
.chat-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 24px 0;
}

.chat-column {
  max-width: var(--content-max);
  margin: 0 auto;
  padding: 0 20px;
  display: flex;
  flex-direction: column;
}

/* 欢迎仪表盘 */
.dashboard-welcome {
  display: flex;
  flex-direction: column;
  padding: 40px 0 20px;
  gap: 32px;
}

.welcome-banner {
  display: flex;
  align-items: center;
  gap: 12px;
}

.coral-asterisk {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: none;
}

.welcome-heading {
  margin: 0;
  font-size: 22px;
  font-weight: 600;
  letter-spacing: -0.3px;
  color: var(--text);
}

.sessions-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.section-title {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-muted);
  letter-spacing: 0.2px;
}

.sessions-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.session-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  cursor: pointer;
  transition: all 0.15s ease;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
}

.session-card:hover {
  background: var(--surface-hover);
  border-color: var(--border-strong);
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.06);
}

.session-left {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.session-status-badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 7px;
  border-radius: var(--radius-full);
  font-size: 11px;
  font-weight: 500;
  background: var(--surface);
  color: var(--text-muted);
}

.session-status-badge.needs_input {
  background: #fff4e5;
  color: #c05621;
}

.session-status-badge.in_progress {
  background: var(--success-soft);
  color: var(--success);
}

.status-indicator-dot {
  width: 6px;
  height: 6px;
  border-radius: var(--radius-full);
  background: currentColor;
}

.session-card-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.session-right {
  display: flex;
  align-items: center;
  gap: 12px;
  flex: none;
}

.session-project-tag {
  font-size: 11.5px;
  font-family: var(--font-mono), var(--font-sans);
  color: var(--text-subtle);
  background: var(--surface);
  padding: 2px 6px;
  border-radius: var(--radius-sm);
}

.session-time {
  font-size: 11px;
}

.session-arrow {
  color: var(--text-subtle);
}

/* 快速建议 Chips */
.quick-suggestions {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-top: 8px;
}

.suggestion-chip {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 10px 14px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  font-size: 12.5px;
  color: var(--text);
  cursor: pointer;
  transition: all 0.12s ease;
}

.suggestion-chip:hover {
  background: var(--surface-hover);
  border-color: var(--border-strong);
}

.chip-spark {
  color: var(--accent);
}

/* 现代工程输入胶囊 */
.chat-footer {
  flex: none;
  padding: 0 0 16px;
  position: relative;
}

.footer-note {
  margin: 6px 0 0;
  font-size: 11px;
  text-align: center;
}

/* 尚搏企业官方 Logo 样式 */
.welcome-brand-logo {
  width: 32px;
  height: 32px;
  object-fit: contain;
  border-radius: 6px;
  flex-shrink: 0;
}</style>
