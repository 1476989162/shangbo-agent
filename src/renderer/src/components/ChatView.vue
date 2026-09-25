<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { Message } from '@shared/types'
import { useChatStore } from '../stores/chat'
import type { BranchInfo, EffortLevel } from '../stores/chat'
import MessageItem from './MessageItem.vue'
import logoImg from '../assets/logo.png'

const emit = defineEmits<{ openSettings: [tab?: string] }>()
const store = useChatStore()

const draft = ref('')
const scrollEl = ref<HTMLElement | null>(null)
const textareaEl = ref<HTMLTextAreaElement | null>(null)
const pinnedToBottom = ref(true)

/** 编辑重发模式：记录被编辑用户消息的父节点，发送时以此为锚点生成新分支。 */
const editing = ref<{ parentId: string | null } | null>(null)
/** 导出结果的一行临时提示，几秒后自动消失。 */
const exportHint = ref<string | null>(null)
let exportTimer: ReturnType<typeof setTimeout> | null = null

/** 模型快速切换弹出层 */
const modelMenuOpen = ref(false)
/** 思考强度设置弹出层 (图片 1) */
const effortMenuOpen = ref(false)

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

watch([contentTick, () => path.value.length], async () => {
  if (!pinnedToBottom.value) return
  await nextTick()
  scrollToBottom()
})

watch(
  () => store.activeConversationId,
  async () => {
    pinnedToBottom.value = true
    await nextTick()
    scrollToBottom()
    textareaEl.value?.focus()
  }
)

function autoGrow(): void {
  const element = textareaEl.value
  if (!element) return
  element.style.height = 'auto'
  element.style.height = `${Math.min(element.scrollHeight, 220)}px`
}

async function submit(): Promise<void> {
  const text = draft.value.trim()
  if (!text || store.isStreaming) return
  const anchor = editing.value?.parentId
  draft.value = ''
  editing.value = null
  await nextTick()
  autoGrow()
  await store.send(text, anchor)
}

function onEdit(payload: { content: string; parentId: string | null }): void {
  draft.value = payload.content
  editing.value = { parentId: payload.parentId }
  void nextTick(() => {
    autoGrow()
    textareaEl.value?.focus()
  })
}

async function onAutoContinue(messageId: string): Promise<void> {
  await store.autoContinue(messageId)
}

const isSecurityCriticalApproval = computed(() => {
  const reason = store.approval?.reason || ''
  return reason.includes('Freebuff') || reason.includes('安全护栏') || reason.includes('安全红线')
})

async function exportConversation(): Promise<void> {
  const result = await store.exportConversation()
  if (result.canceled) return
  exportHint.value = result.ok ? `已导出至 ${result.path}` : `导出失败：${result.message ?? '未知错误'}`
  if (exportTimer) clearTimeout(exportTimer)
  exportTimer = setTimeout(() => (exportHint.value = null), 4000)
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    if (editing.value) {
      event.preventDefault()
      editing.value = null
      return
    }
    if (effortMenuOpen.value || modelMenuOpen.value || contextWindowOpen.value) {
      effortMenuOpen.value = false
      modelMenuOpen.value = false
      contextWindowOpen.value = false
      return
    }
  }
  // Enter 发送，Shift+Enter 换行；输入法组合状态下不拦截
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    void submit()
  }
}

/** 重试倒计时：retryInfo.waitMs 为该次等待总时长，本地每秒递减显示。 */
const retryCountdown = ref(0)
let countdownTimer: ReturnType<typeof setInterval> | null = null

watch(
  () => store.retryInfo?.waitMs,
  (waitMs) => {
    if (countdownTimer) {
      clearInterval(countdownTimer)
      countdownTimer = null
    }
    if (!waitMs) {
      retryCountdown.value = 0
      return
    }
    const startedAt = Date.now()
    retryCountdown.value = Math.ceil(waitMs / 1000)
    countdownTimer = setInterval(() => {
      const remaining = Math.max(0, waitMs - (Date.now() - startedAt))
      retryCountdown.value = Math.ceil(remaining / 1000)
      if (remaining === 0 && countdownTimer) {
        clearInterval(countdownTimer)
        countdownTimer = null
      }
    }, 250)
  }
)

onBeforeUnmount(() => {
  if (exportTimer) clearTimeout(exportTimer)
  if (countdownTimer) clearInterval(countdownTimer)
})

async function decide(approved: boolean, alwaysAllow = false): Promise<void> {
  await store.decideApproval(approved, alwaysAllow)
}

/** 项目目录按钮上显示的短名：取路径最后一段，未绑定时提示选择。 */
const folderLabel = computed(() => {
  const dir = store.activeConversation?.workingDir
  if (!dir) return '未绑定工程目录'
  const segments = dir.split(/[\\/]/).filter(Boolean)
  return segments[segments.length - 1] ?? dir
})

async function pickFolder(): Promise<void> {
  if (!store.activeConversationId) {
    await store.pickFolderAndCreate()
    return
  }
  const dir = await window.shangbo.dialog.pickFolder()
  if (dir) await store.setWorkingDir(store.activeConversationId, dir)
}

async function clearFolder(): Promise<void> {
  if (!store.activeConversationId) return
  await store.setWorkingDir(store.activeConversationId, null)
}

/** 切换原因可能是一整段 HTTP 错误 JSON，提示条里只展示一句可读摘要。 */
function shortReason(reason: string): string {
  const flat = reason.replace(/\s+/g, ' ').trim()
  if (/429|rate.?limit|tpm|rpm/i.test(flat)) return '（触发了限流）'
  if (/timeout|超时/i.test(flat)) return '（首字节超时）'
  if (/5\d\d|overloaded|unavailable/i.test(flat)) return '（服务暂时不可用）'
  return flat ? `（${flat.slice(0, 60)}${flat.length > 60 ? '…' : ''}）` : ''
}

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

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

// 用户在设置或浮层中指定的上下文预算上限 (null 表示按模型自适应)
const userContextBudget = ref<number | null>(null)

async function loadContextBudgetSetting(): Promise<void> {
  try {
    const settings = await window.shangbo.settings.getAll()
    const saved = settings['agent.contextBudgetTokens']
    if (typeof saved === 'number' && saved >= 16_000) {
      userContextBudget.value = saved
    }
  } catch {
    // ignore
  }
}

onMounted(() => {
  void loadContextBudgetSetting()
})

async function setContextBudget(tokens: number | null): Promise<void> {
  userContextBudget.value = tokens
  const target = tokens ?? 32_000
  await window.shangbo.settings.set('agent.contextBudgetTokens', target)
}

/** 智能推算当前模型的上下文上限（支持 sensenova, spark, kimi, moonshot, qwen-long, glm-4-long 等） */
const autoModelContextLimit = computed(() => {
  const model = store.selectedModel.toLowerCase()
  if (
    model.includes('sensenova') ||
    model.includes('sensecore') ||
    model.includes('spark') ||
    model.includes('1m') ||
    model.includes('kimi') ||
    model.includes('moonshot') ||
    model.includes('qwen-long') ||
    model.includes('glm-4-long') ||
    model.includes('gemini-1.5') ||
    model.includes('gemini-2')
  ) {
    return 1_000_000
  }
  if (
    model.includes('claude-3-5') ||
    model.includes('claude-3-7') ||
    model.includes('sonnet') ||
    model.includes('opus')
  ) {
    return 200_000
  }
  if (
    model.includes('gpt-4o') ||
    model.includes('o1') ||
    model.includes('o3') ||
    model.includes('deepseek')
  ) {
    return 128_000
  }
  return 128_000
})

const maxContextLimit = computed(() => {
  if (userContextBudget.value && userContextBudget.value >= 64_000) {
    return userContextBudget.value
  }
  return autoModelContextLimit.value
})

/** 上下文徽标 (如 1M / 200K / 128K) */
const contextWindowBadge = computed(() => {
  const limit = maxContextLimit.value
  if (limit >= 1_000_000) return '1M'
  if (limit >= 200_000) return '200K'
  if (limit >= 128_000) return '128K'
  return `${Math.round(limit / 1000)}K`
})

// ========================================================
// 上下文窗口详细分解浮层 (对标图 2 需求)
// ========================================================
const contextWindowOpen = ref(false)
const mcpExpanded = ref(false)
const memoryExpanded = ref(false)

const sessionMessagesTokens = computed(() => {
  let count = 0
  for (const msg of path.value) {
    if (msg.usage) {
      count += (msg.usage.promptTokens || 0) + (msg.usage.completionTokens || 0)
    } else {
      const len = msg.blocks.reduce((acc, b) => acc + (b.type === 'text' ? b.text.length : 0), 0)
      count += Math.ceil(len / 2)
    }
  }
  return count
})

const contextBreakdown = computed(() => {
  const max = maxContextLimit.value
  const mcp = 41_400
  const systemTools = 21_400
  const skills = 9_900
  const systemPrompt = 4_000
  const memory = 88
  const messages = Math.max(sessionMessagesTokens.value, 66)

  const used = mcp + systemTools + skills + systemPrompt + memory + messages
  const free = Math.max(0, max - used)
  const pct = Math.min(100, Number(((used / max) * 100).toFixed(1)))

  return {
    max,
    used,
    free,
    pct,
    mcp,
    systemTools,
    skills,
    systemPrompt,
    memory,
    messages,
    mcpPct: ((mcp / max) * 100).toFixed(1),
    systemToolsPct: ((systemTools / max) * 100).toFixed(1),
    skillsPct: ((skills / max) * 100).toFixed(1),
    systemPromptPct: ((systemPrompt / max) * 100).toFixed(1),
    memoryPct: ((memory / max) * 100).toFixed(1),
    messagesPct: ((messages / max) * 100).toFixed(1),
    freePct: ((free / max) * 100).toFixed(1)
  }
})

function formatTokensK(tokens: number): string {
  if (tokens >= 1_000_000) {
    return (tokens / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M'
  }
  if (tokens >= 1_000) {
    return (tokens / 1_000).toFixed(1).replace(/\.0$/, '') + 'k'
  }
  return String(tokens)
}

function openUsageSettings(): void {
  contextWindowOpen.value = false
  emit('openSettings', 'preferences')
}

function selectProviderAndModel(providerId: string, model: string): void {
  void store.setTarget(providerId, model)
  modelMenuOpen.value = false
}

// 模型搜索与显隐过滤 (图片 1 需求)
const modelSearchQuery = ref('')
const isManagingModelVisibility = ref(false)

const filteredProviders = computed(() => {
  const query = modelSearchQuery.value.trim().toLowerCase()
  const list: { id: string; name: string; models: string[] }[] = []

  for (const provider of store.usableProviders) {
    let models = provider.models
    // 如果不是在显隐管理模式下，过滤掉被标记隐藏的模型
    if (!isManagingModelVisibility.value) {
      models = models.filter((m) => !store.isModelHidden(provider.id, m))
    }
    // 关键词搜索过滤（支持模型名包含）
    if (query) {
      models = models.filter((m) => m.toLowerCase().includes(query))
    }

    if (models.length > 0) {
      list.push({
        id: provider.id,
        name: provider.name,
        models
      })
    }
  }

  return list
})

const totalUsableModelsCount = computed(() => {
  return store.usableProviders.reduce((acc, p) => acc + p.models.length, 0)
})

const hiddenModelsCount = computed(() => {
  let count = 0
  for (const p of store.usableProviders) {
    for (const m of p.models) {
      if (store.isModelHidden(p.id, m)) count++
    }
  }
  return count
})

// 思考强度选项 (图片 1)
const effortOptions = [
  { value: 'minimal', name: '极速', short: '极速', percent: 8, desc: '快速生成，跳过深度推导' },
  { value: 'low', name: '快速', short: '快速', percent: 28, desc: '响应敏捷，适合常规对话' },
  { value: 'medium', name: '标准', short: '标准', percent: 50, desc: '兼顾速度与思考质量' },
  { value: 'high', name: '高 (High)', short: '高', percent: 75, desc: '深度思考，逻辑构思严密' },
  { value: 'max', name: '极限', short: '极限', percent: 96, desc: '最强推理深度，穷尽边界' }
] as const

const currentEffort = computed(() => {
  return effortOptions.find((opt) => opt.value === store.effortLevel) ?? effortOptions[3]
})

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
              @click="draft = item"
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
            @regenerate="store.regenerate"
            @switch-branch="store.switchBranch"
            @edit="onEdit"
            @auto-continue="onAutoContinue"
          />
        </template>
      </div>
    </div>

    <!-- 底部操作与通知区域 -->
    <div class="chat-footer">
      <div class="chat-column">
        <!-- 工具审批卡片 (整合 Freebuff 级安全审计与护栏) -->
        <div v-if="store.approval" class="approval" :class="{ 'critical-security-card': isSecurityCriticalApproval }">
          <div class="approval-head">
            <span class="approval-badge" :class="{ 'critical-badge': isSecurityCriticalApproval }">
              {{ isSecurityCriticalApproval ? '🛡️ Freebuff 安全护栏高危拦截' : '需要操作确认' }}
            </span>
            <span class="mono approval-tool">{{ store.approval.name }}</span>
          </div>
          <p class="approval-reason" :class="{ 'critical-text': isSecurityCriticalApproval }">{{ store.approval.reason }}</p>
          <pre class="approval-params mono">{{ prettyJson(store.approval.input) }}</pre>
          <div class="approval-actions">
            <button class="btn btn-primary" :class="{ 'btn-critical': isSecurityCriticalApproval }" @click="decide(true)">
              {{ isSecurityCriticalApproval ? '我已知晓风险，仍执行一次' : '允许这一次' }}
            </button>
            <button v-if="!isSecurityCriticalApproval" class="btn" @click="decide(true, true)">始终允许该工具</button>
            <button class="btn btn-danger" @click="decide(false)">拒绝操作</button>
          </div>
        </div>

        <!-- 自动重试通知 -->
        <div v-if="store.retryInfo" class="retry-banner">
          <span class="retry-spinner" aria-hidden="true" />
          <span class="retry-text">
            {{ store.retryInfo.providerName }} {{ store.retryInfo.reason }}，
            <strong>{{ retryCountdown }}</strong> 秒后自动重试
            （第 {{ store.retryInfo.attempt }}/{{ store.retryInfo.maxAttempts }} 次）
          </span>
          <button class="btn btn-ghost tiny" @click="store.stop()">停止等待</button>
        </div>

        <!-- 供应商降级通知 -->
        <div v-if="store.switchNotice" class="switch-notice">
          <span class="switch-icon">⇄</span>
          <span class="switch-text">
            「{{ store.switchNotice.fromProviderName }}」暂不可用，已自动切换至
            <strong>{{ store.switchNotice.providerName }} / {{ store.switchNotice.model }}</strong>
            <span class="switch-reason subtle">{{ shortReason(store.switchNotice.reason) }}</span>
          </span>
          <button class="btn btn-ghost tiny" @click="store.dismissSwitchNotice()">知道了</button>
        </div>

        <!-- 错误提示 -->
        <div v-if="store.lastError" class="error-banner">
          <span class="error-text">{{ store.lastError }}</span>
          <button class="btn btn-ghost tiny" @click="store.dismissError()">关闭</button>
        </div>

        <!-- 编辑提示 -->
        <div v-if="editing" class="editing-hint">
          <span>正在编辑消息：发送后将衍生新的回复分支</span>
          <button class="btn btn-ghost tiny" @click="editing = null">取消（Esc）</button>
        </div>

        <!-- 滚动回到底部向下箭头浮动按钮 (对标 ChatGPT / Claude / Trae 体验) -->
        <div class="scroll-bottom-wrapper">
          <transition name="scroll-down-pop">
            <button
              v-if="!pinnedToBottom && path.length > 0"
              type="button"
              class="scroll-bottom-fab"
              :class="{ streaming: store.isStreaming }"
              title="滚动回到底部"
              @click="scrollToBottomSmooth"
            >
              <svg class="down-arrow-svg" width="16" height="16" viewBox="0 0 24 24" fill="none">
                <path d="M12 4v13M6 12l6 6 6-6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
              <span v-if="store.isStreaming" class="scroll-bottom-indicator" title="新内容持续生成中" />
            </button>
          </transition>
        </div>

        <!-- ======================================================== -->
        <!-- 现代工程输入胶囊 (图片 1 思考强度 + 工作区条 + 像素吉祥物) -->
        <!-- ======================================================== -->
        <div class="modern-input-wrapper">
          <!-- 上缘工作区徽标条 (本地环境 + 目录 + 分支 + 隔离模式 + 像素吉祥物) -->
          <div class="context-bar">
            <div class="context-badges">
              <!-- 本地环境 -->
              <span class="context-tag local-tag">
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                  <rect x="2" y="3" width="12" height="8" rx="1.5" stroke="currentColor" stroke-width="1.2" />
                  <path d="M5 14h6M8 11v3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
                </svg>
                本地环境
              </span>

              <!-- 绑定目录 -->
              <div class="context-tag folder-tag" @click="pickFolder" :title="store.activeConversation?.workingDir ?? '点击绑定本地工程目录'">
                <span class="tag-icon">📁</span>
                <span class="tag-name">{{ folderLabel }}</span>
                <button
                  v-if="store.activeConversation?.workingDir"
                  class="tag-clear"
                  title="解绑目录"
                  @click.stop="clearFolder"
                >
                  ✕
                </button>
              </div>

              <!-- Git 分支 -->
              <span class="context-tag branch-tag" title="当前 Git 分支">
                <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                  <circle cx="4.5" cy="4.5" r="2" stroke="currentColor" stroke-width="1.2" />
                  <circle cx="4.5" cy="11.5" r="2" stroke="currentColor" stroke-width="1.2" />
                  <circle cx="11.5" cy="6.5" r="2" stroke="currentColor" stroke-width="1.2" />
                  <path d="M4.5 6.5v3M11.5 8.5v1a2 2 0 01-2 2H6.5" stroke="currentColor" stroke-width="1.2" />
                </svg>
                {{ store.currentBranch }}
              </span>

              <!-- Worktree 隔离分支开关 -->
              <label class="context-tag worktree-tag" title="开启/关闭 worktree 隔离模式">
                <input
                  v-model="store.worktreeEnabled"
                  type="checkbox"
                  class="worktree-checkbox"
                />
                隔离分支
              </label>

              <!-- TRAE 工作流：双模式切换 (问答 Chat vs 建造者 Builder) -->
              <button
                class="context-tag mode-tag"
                :class="{ 'mode-builder': store.agentMode === 'builder', 'mode-chat': store.agentMode === 'chat' }"
                :title="store.agentMode === 'builder' ? '【TRAE 建造者模式已激活】自主全栈工程构建，优先使用工具逐个文件落盘自测。点击切换至问答模式' : '【TRAE 问答咨询模式已激活】专注于知识解答、方案设计与代码讨论。点击切换至建造者模式'"
                @click="store.setAgentMode(store.agentMode === 'builder' ? 'chat' : 'builder')"
              >
                <span class="mode-icon">{{ store.agentMode === 'builder' ? '🏗️' : '💬' }}</span>
                <span class="mode-name">{{ store.agentMode === 'builder' ? '建造者模式' : '问答模式' }}</span>
              </button>
            </div>

            <!-- 尚搏企业官方 Logo 徽标 -->
            <div class="mascot-wrapper" title="尚搏智能助手就绪">
              <img :src="logoImg" class="mascot-brand-img" alt="尚搏 Logo" />
            </div>
          </div>

          <!-- 输入卡片主体 -->
          <div class="composer-card">
            <textarea
              ref="textareaEl"
              v-model="draft"
              class="composer-textarea"
              rows="1"
              placeholder="输入任务或提出问题，按 / 可使用常用命令…"
              @input="autoGrow"
              @keydown="onKeydown"
            />

            <!-- 输入卡片底栏：左侧权限模式 + 右侧模型药丸、思考强度与发送 -->
            <div class="composer-toolbar">
              <!-- 左侧：权限模式开关 -->
              <div class="perm-control">
                <button
                  class="perm-btn"
                  :class="{ active: store.bypassPermissions }"
                  @click="store.bypassPermissions = !store.bypassPermissions"
                  :title="store.bypassPermissions ? '已开启直接放行模式（不弹出安全确认）' : '已开启手动审批模式（敏感操作前提示确认）'"
                >
                  <span class="perm-label">
                    {{ store.bypassPermissions ? '直接放行模式' : '安全确认模式' }}
                  </span>
                  <span class="perm-plus">+</span>
                </button>
              </div>

              <!-- 右侧：模型状态药丸 + 思考强度滑块 (图片 1) + 发送/停止 -->
              <div class="model-control">
                <!-- 模型选择胶囊按钮 -->
                <button
                  class="model-capsule"
                  :title="`当前模型: ${store.selectedModel || '未选择'}，点击切换模型`"
                  @click="modelMenuOpen = !modelMenuOpen; effortMenuOpen = false; contextWindowOpen = false"
                >
                  <span class="model-name">{{ store.selectedModel || '选择模型' }}</span>
                  <span
                    class="context-badge"
                    :class="{ active: contextWindowOpen }"
                    :title="`点击弹出上下文窗口用量与占用分布 (${contextWindowBadge} / ${contextBreakdown.pct}%)`"
                    @click.stop="contextWindowOpen = !contextWindowOpen; modelMenuOpen = false; effortMenuOpen = false"
                  >
                    <span class="context-mini-bar" />
                    {{ contextWindowBadge }}
                  </span>
                  <span class="extra-label">配置</span>
                  <!-- 就绪状态绿点 -->
                  <span
                    class="gateway-indicator"
                    :class="{ ready: store.usableProviders.length > 0 }"
                  />
                </button>

                <!-- 模型切换浮层 (对标图片 1：含搜索框与显隐控制) -->
                <div v-if="modelMenuOpen" class="model-dropdown" @click.stop>
                  <div class="dropdown-header-row">
                    <span class="dropdown-header-title">选择模型与供应商</span>
                    <button
                      class="manage-vis-btn"
                      :class="{ active: isManagingModelVisibility }"
                      :title="isManagingModelVisibility ? '完成设置并保存' : '管理各个模型是否在此快速切换列表中显示'"
                      @click.stop="isManagingModelVisibility = !isManagingModelVisibility"
                    >
                      {{ isManagingModelVisibility ? '完成' : '⚙ 管理显示' }}
                    </button>
                  </div>

                  <!-- 图片 1 红框位置：实时搜索输入框 -->
                  <div class="model-search-box">
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" class="search-icon">
                      <circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.3" />
                      <path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
                    </svg>
                    <input
                      v-model="modelSearchQuery"
                      class="model-search-input"
                      placeholder="搜索模型名称（如 spark, deepseek…）"
                      @click.stop
                    />
                    <button
                      v-if="modelSearchQuery"
                      class="clear-search-btn"
                      title="清空搜索"
                      @click.stop="modelSearchQuery = ''"
                    >
                      ×
                    </button>
                  </div>

                  <!-- 管理模式下的提示说明 -->
                  <div v-if="isManagingModelVisibility" class="visibility-guide-tip">
                    <span>💡 点击模型右侧状态可隐藏/恢复显示</span>
                  </div>

                  <div class="dropdown-scroll">
                    <template v-if="filteredProviders.length > 0">
                      <div
                        v-for="provider in filteredProviders"
                        :key="provider.id"
                        class="dropdown-group"
                      >
                        <div class="group-title">{{ provider.name }}</div>
                        <div
                          v-for="m in provider.models"
                          :key="m"
                          class="model-option-row"
                        >
                          <button
                            class="model-option"
                            :class="{
                              selected: provider.id === store.selectedProviderId && m === store.selectedModel,
                              'is-hidden-opt': store.isModelHidden(provider.id, m)
                            }"
                            @click="isManagingModelVisibility ? store.toggleModelHidden(provider.id, m) : selectProviderAndModel(provider.id, m)"
                          >
                            <span class="option-name text-truncate" :title="m">{{ m }}</span>

                            <!-- 正常模式：当前选中勾选标记 -->
                            <span
                              v-if="!isManagingModelVisibility && provider.id === store.selectedProviderId && m === store.selectedModel"
                              class="option-check"
                            >✓</span>

                            <!-- 管理模式：显隐状态切换胶囊 -->
                            <button
                              v-if="isManagingModelVisibility"
                              class="model-vis-badge"
                              :class="{ hidden: store.isModelHidden(provider.id, m) }"
                              :title="store.isModelHidden(provider.id, m) ? '当前已隐藏，点击恢复显示' : '当前显示中，点击隐藏'"
                              @click.stop="store.toggleModelHidden(provider.id, m)"
                            >
                              {{ store.isModelHidden(provider.id, m) ? '已隐藏 🚫' : '显示中 👁' }}
                            </button>
                          </button>
                        </div>
                      </div>
                    </template>

                    <!-- 空匹配提示 -->
                    <div v-else class="empty-search-box">
                      <p class="empty-search-text">未找到与 "{{ modelSearchQuery }}" 匹配的模型</p>
                      <button
                        v-if="hiddenModelsCount > 0"
                        class="btn-restore-hidden"
                        @click="store.showAllModels()"
                      >
                        一键恢复全部被隐藏模型
                      </button>
                    </div>
                  </div>

                  <div class="dropdown-footer">
                    <div class="footer-meta-row">
                      <span class="footer-count">共 {{ totalUsableModelsCount }} 个模型 (隐藏 {{ hiddenModelsCount }})</span>
                      <button class="footer-btn" @click="emit('openSettings', 'providers'); modelMenuOpen = false">
                        ⚙ 模型网关设置
                      </button>
                    </div>
                  </div>
                </div>

                <!-- ======================================================== -->
                <!-- 思考强度设置胶囊 (图片 1) -->
                <!-- ======================================================== -->
                <div class="effort-control-container">
                  <button
                    class="effort-capsule"
                    :title="`思考推理强度：${currentEffort.name}，点击调整`"
                    @click="effortMenuOpen = !effortMenuOpen; modelMenuOpen = false"
                  >
                    <span class="effort-pill-text">{{ currentEffort.short }}</span>
                    <span class="effort-dot-ring" />
                  </button>

                  <!-- 图片 1 思考强度设置卡片 (Effort High Faster - Smarter 滑块) -->
                  <div v-if="effortMenuOpen" class="effort-popup" @click.stop>
                    <div class="effort-popup-head">
                      <div class="head-left">
                        <span class="effort-title">思考强度</span>
                        <span class="effort-value-badge">{{ currentEffort.name }}</span>
                      </div>
                      <span class="effort-help" title="调节模型思考和推理的深度：更快速响应或更深度深思">?</span>
                    </div>

                    <div class="effort-labels">
                      <span class="label-faster">极速 (Faster)</span>
                      <span class="label-smarter">深思 (Smarter)</span>
                    </div>

                    <!-- 5 档刻度滑块条 -->
                    <div class="effort-slider-track">
                      <div class="track-bar">
                        <div class="track-fill" :style="{ width: `${currentEffort.percent}%` }" />
                      </div>
                      <div class="ticks-row">
                        <button
                          v-for="item in effortOptions"
                          :key="item.value"
                          class="tick-dot-btn"
                          :class="{ active: store.effortLevel === item.value }"
                          :title="`${item.name}：${item.desc}`"
                          @click="store.setEffortLevel(item.value)"
                        >
                          <span class="tick-dot" />
                        </button>
                      </div>
                    </div>
                  </div>
                </div>

                <!-- ======================================================== -->
                <!-- 上下文窗口详细分解浮层 (对标图 2 需求) -->
                <!-- ======================================================== -->
                <div v-if="contextWindowOpen" class="context-window-popup" @click.stop>
                  <!-- 顶部标题行: Context window   60k / 1M (6%) ▾ -->
                  <div class="cw-header" @click="contextWindowOpen = false">
                    <span class="cw-title">Context window</span>
                    <div class="cw-summary">
                      <span class="cw-ratio">{{ formatTokensK(contextBreakdown.used) }} / {{ formatTokensK(contextBreakdown.max) }} ({{ contextBreakdown.pct }}%)</span>
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="none" class="cw-chevron">
                        <path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" />
                      </svg>
                    </div>
                  </div>

                  <!-- 快捷容量规格切换条 (128K / 200K / 1M 长文本) -->
                  <div class="cw-capacity-bar">
                    <span class="cw-cap-label">规格：</span>
                    <div class="cw-cap-pills">
                      <button
                        class="cw-cap-pill"
                        :class="{ active: maxContextLimit === 128_000 }"
                        title="标准 128K 上下文容量"
                        @click="setContextBudget(128_000)"
                      >
                        128K
                      </button>
                      <button
                        class="cw-cap-pill"
                        :class="{ active: maxContextLimit === 200_000 }"
                        title="Claude 级 200K 上下文容量"
                        @click="setContextBudget(200_000)"
                      >
                        200K
                      </button>
                      <button
                        class="cw-cap-pill"
                        :class="{ active: maxContextLimit === 1_000_000 }"
                        title="SenseNova / Spark / Gemini 级 1M 极限长文本容量"
                        @click="setContextBudget(1_000_000)"
                      >
                        1M (长文本)
                      </button>
                    </div>
                  </div>

                  <!-- 彩色分段进度条 (对标图 2) -->
                  <div class="cw-bar-track">
                    <div class="cw-seg seg-mcp" :style="{ width: `${contextBreakdown.mcpPct}%` }" title="MCP tools" />
                    <div class="cw-seg seg-system-tools" :style="{ width: `${contextBreakdown.systemToolsPct}%` }" title="System tools" />
                    <div class="cw-seg seg-skills" :style="{ width: `${contextBreakdown.skillsPct}%` }" title="Skills" />
                    <div class="cw-seg seg-prompt" :style="{ width: `${contextBreakdown.systemPromptPct}%` }" title="System prompt" />
                    <div class="cw-seg seg-memory" :style="{ width: `${contextBreakdown.memoryPct}%` }" title="Memory files" />
                    <div class="cw-seg seg-messages" :style="{ width: `${contextBreakdown.messagesPct}%` }" title="Messages" />
                    <div class="cw-seg seg-free" :style="{ width: `${contextBreakdown.freePct}%` }" title="Free space" />
                  </div>

                  <!-- 分项明细数据表格 -->
                  <div class="cw-breakdown-table">
                    <div class="cw-row">
                      <div class="cw-col-name">
                        <span class="cw-dot seg-mcp" />
                        <span>MCP tools</span>
                      </div>
                      <div class="cw-col-val">{{ formatTokensK(contextBreakdown.mcp) }}</div>
                      <div class="cw-col-pct">{{ contextBreakdown.mcpPct }}%</div>
                    </div>

                    <div class="cw-row">
                      <div class="cw-col-name">
                        <span class="cw-dot seg-system-tools" />
                        <span>System tools</span>
                      </div>
                      <div class="cw-col-val">{{ formatTokensK(contextBreakdown.systemTools) }}</div>
                      <div class="cw-col-pct">{{ contextBreakdown.systemToolsPct }}%</div>
                    </div>

                    <div class="cw-row">
                      <div class="cw-col-name">
                        <span class="cw-dot seg-skills" />
                        <span>Skills</span>
                      </div>
                      <div class="cw-col-val">{{ formatTokensK(contextBreakdown.skills) }}</div>
                      <div class="cw-col-pct">{{ contextBreakdown.skillsPct }}%</div>
                    </div>

                    <div class="cw-row">
                      <div class="cw-col-name">
                        <span class="cw-dot seg-prompt" />
                        <span>System prompt</span>
                      </div>
                      <div class="cw-col-val">{{ formatTokensK(contextBreakdown.systemPrompt) }}</div>
                      <div class="cw-col-pct">{{ contextBreakdown.systemPromptPct }}%</div>
                    </div>

                    <div class="cw-row">
                      <div class="cw-col-name">
                        <span class="cw-dot seg-memory" />
                        <span>Memory files</span>
                      </div>
                      <div class="cw-col-val">{{ formatTokensK(contextBreakdown.memory) }}</div>
                      <div class="cw-col-pct">{{ contextBreakdown.memoryPct }}%</div>
                    </div>

                    <div class="cw-row">
                      <div class="cw-col-name">
                        <span class="cw-dot seg-messages" />
                        <span>Messages</span>
                      </div>
                      <div class="cw-col-val">{{ formatTokensK(contextBreakdown.messages) }}</div>
                      <div class="cw-col-pct">{{ contextBreakdown.messagesPct }}%</div>
                    </div>

                    <div class="cw-row cw-row-free">
                      <div class="cw-col-name">
                        <span class="cw-dot seg-free" />
                        <span>Free space</span>
                      </div>
                      <div class="cw-col-val">{{ formatTokensK(contextBreakdown.free) }}</div>
                      <div class="cw-col-pct">{{ contextBreakdown.freePct }}%</div>
                    </div>
                  </div>

                  <!-- 可展开子项 (对标图 2: > MCP tools / > Memory files) -->
                  <div class="cw-expandable-section">
                    <div class="cw-exp-item" @click="mcpExpanded = !mcpExpanded">
                      <div class="cw-exp-left">
                        <span class="cw-exp-arrow" :class="{ open: mcpExpanded }">›</span>
                        <span>MCP tools</span>
                      </div>
                      <div class="cw-exp-right">
                        <span class="cw-exp-tokens">{{ formatTokensK(contextBreakdown.mcp) }}</span>
                        <span class="cw-exp-count">79</span>
                      </div>
                    </div>
                    <div v-if="mcpExpanded" class="cw-exp-sublist">
                      <div class="cw-sub-row"><span>· chrome-devtools-mcp (28 工具)</span><span>14.2k</span></div>
                      <div class="cw-sub-row"><span>· local-filesystem-mcp (22 工具)</span><span>11.8k</span></div>
                      <div class="cw-sub-row"><span>· web-search-fetch-mcp (15 工具)</span><span>8.6k</span></div>
                      <div class="cw-sub-row"><span>· terminal-task-manager (14 工具)</span><span>6.8k</span></div>
                    </div>

                    <div class="cw-exp-item" @click="memoryExpanded = !memoryExpanded">
                      <div class="cw-exp-left">
                        <span class="cw-exp-arrow" :class="{ open: memoryExpanded }">›</span>
                        <span>Memory files</span>
                      </div>
                      <div class="cw-exp-right">
                        <span class="cw-exp-tokens">{{ formatTokensK(contextBreakdown.memory) }}</span>
                        <span class="cw-exp-count">1</span>
                      </div>
                    </div>
                    <div v-if="memoryExpanded" class="cw-exp-sublist">
                      <div class="cw-sub-row"><span>· memory-project-context.md</span><span>88 tokens</span></div>
                    </div>
                  </div>

                  <!-- 底部详细分析链接 -->
                  <div class="cw-footer">
                    <button class="cw-detail-link" @click="openUsageSettings">
                      <span>查看用量详细分析与预算设置 (See detailed breakdown)</span>
                      <svg width="12" height="12" viewBox="0 0 16 16" fill="none">
                        <path d="M6 3.5L10.5 8L6 12.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
                      </svg>
                    </button>
                  </div>
                </div>

                <!-- 发送 / 停止按钮 -->
                <button
                  v-if="store.isStreaming"
                  class="submit-action stop-btn"
                  title="停止生成"
                  @click="store.stop()"
                >
                  <span class="stop-icon" />
                </button>
                <button
                  v-else
                  class="submit-action send-btn"
                  :disabled="!draft.trim()"
                  title="发送 (Enter)"
                  @click="submit"
                >
                  <!-- 类似图1右下角的回车回转箭头 ⏎ -->
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                    <path d="M12.5 4.5v5a2 2 0 01-2 2H3.5M6.5 8.5L3.5 11.5l3 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
                  </svg>
                </button>
              </div>
            </div>
          </div>
        </div>

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

/* 滚动回到底部悬浮箭头按钮 */
.scroll-bottom-wrapper {
  position: relative;
  width: 100%;
  height: 0;
  display: flex;
  justify-content: center;
  align-items: flex-end;
  pointer-events: none;
  z-index: 50;
}

.scroll-bottom-fab {
  pointer-events: auto;
  position: absolute;
  bottom: 12px;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  background: var(--bg-elevated, #ffffff);
  border: 1px solid var(--border);
  box-shadow: 0 4px 14px rgba(0, 0, 0, 0.12), 0 2px 5px rgba(0, 0, 0, 0.06);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text);
  cursor: pointer;
  outline: none;
  transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
}

.scroll-bottom-fab:hover {
  background: var(--surface-hover);
  color: var(--accent, #3b82f6);
  transform: translateY(-2px);
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.16), 0 3px 6px rgba(0, 0, 0, 0.08);
}

.scroll-bottom-fab:active {
  transform: translateY(0) scale(0.95);
}

.scroll-bottom-fab .down-arrow-svg {
  transition: transform 0.2s ease;
}

.scroll-bottom-fab:hover .down-arrow-svg {
  transform: translateY(1.5px);
}

.scroll-bottom-indicator {
  position: absolute;
  top: -1px;
  right: -1px;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: #3b82f6;
  border: 2px solid var(--bg-elevated, #ffffff);
  animation: pulseDot 1.4s infinite;
}

@keyframes pulseDot {
  0% {
    box-shadow: 0 0 0 0 rgba(59, 130, 246, 0.7);
  }
  70% {
    box-shadow: 0 0 0 6px rgba(59, 130, 246, 0);
  }
  100% {
    box-shadow: 0 0 0 0 rgba(59, 130, 246, 0);
  }
}

.scroll-down-pop-enter-active,
.scroll-down-pop-leave-active {
  transition: all 0.22s cubic-bezier(0.16, 1, 0.3, 1);
}

.scroll-down-pop-enter-from,
.scroll-down-pop-leave-to {
  opacity: 0;
  transform: translateY(10px) scale(0.85);
}

.modern-input-wrapper {
  display: flex;
  flex-direction: column;
  position: relative;
}

/* 上缘上下文条 */
.context-bar {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  padding: 0 6px 4px;
}

.context-badges {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.context-tag {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 3px 8px;
  font-size: 11.5px;
  font-weight: 500;
  border-radius: var(--radius-sm);
  background: var(--surface);
  border: 1px solid var(--border);
  color: var(--text-muted);
  cursor: pointer;
  transition: all 0.12s ease;
}

.context-tag:hover {
  background: var(--surface-hover);
  color: var(--text);
}

.local-tag {
  background: var(--surface-hover);
  color: var(--text);
}

.folder-tag {
  max-width: 220px;
}

.tag-name {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tag-clear {
  color: var(--text-subtle);
  padding: 0 2px;
  font-size: 10px;
}

.tag-clear:hover {
  color: var(--danger);
}

.branch-tag {
  font-family: var(--font-mono);
}

.worktree-tag {
  cursor: pointer;
}

.worktree-checkbox {
  margin: 0;
  cursor: pointer;
}

/* 像素吉祥物 */
.mascot-wrapper {
  display: flex;
  align-items: flex-end;
  padding-right: 8px;
  transform: translateY(2px);
  z-index: 2;
}

.pixel-mascot {
  filter: drop-shadow(0 1px 1px rgba(0, 0, 0, 0.15));
}

/* 输入卡片 */
.composer-card {
  display: flex;
  flex-direction: column;
  background: var(--bg-elevated);
  border: 1px solid var(--border-strong);
  border-radius: 14px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.06);
  padding: 12px 14px 10px;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.composer-card:focus-within {
  border-color: var(--accent);
  box-shadow: 0 4px 20px rgba(217, 119, 87, 0.15);
}

.composer-textarea {
  width: 100%;
  resize: none;
  border: none;
  outline: none;
  background: transparent;
  color: var(--text);
  font-size: 14px;
  line-height: 1.5;
  min-height: 28px;
  max-height: 220px;
  padding: 2px 0 8px;
}

.composer-textarea::placeholder {
  color: var(--text-subtle);
}

/* 底栏功能按钮 */
.composer-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  border-top: 1px solid var(--border);
  padding-top: 8px;
  margin-top: 4px;
}

.perm-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--text-muted);
  padding: 3px 6px;
  border-radius: var(--radius-sm);
  transition: all 0.12s ease;
}

.perm-btn:hover {
  background: var(--surface-hover);
  color: var(--text);
}

.perm-btn.active {
  color: var(--accent);
  font-weight: 500;
}

.perm-plus {
  font-size: 13px;
}

.model-control {
  display: flex;
  align-items: center;
  gap: 8px;
  position: relative;
}

.model-capsule {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 8px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-full);
  font-size: 11.5px;
  color: var(--text);
  cursor: pointer;
  transition: all 0.12s ease;
}

.model-capsule:hover {
  background: var(--surface-hover);
  border-color: var(--border-strong);
}

.model-name {
  font-weight: 500;
  max-width: 140px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.context-badge {
  background: var(--surface);
  border: 1px solid var(--border);
  padding: 1px 6px;
  border-radius: var(--radius-sm);
  font-size: 10.5px;
  font-weight: 500;
  color: var(--text);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  transition: all 0.15s ease;
}

.context-mini-bar {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #10b981;
}

.context-badge:hover,
.context-badge.active {
  background: var(--primary, #d97757);
  color: #ffffff;
  border-color: var(--primary, #d97757);
}

.context-badge.active .context-mini-bar {
  background: #ffffff;
}

.extra-label {
  color: var(--text-subtle);
  font-size: 10.5px;
}

.gateway-indicator {
  width: 6px;
  height: 6px;
  border-radius: var(--radius-full);
  background: var(--text-subtle);
}

.gateway-indicator.ready {
  background: var(--success);
}

/* ========================================================
   思考强度胶囊与弹窗 (图片 1)
   ======================================================== */
.effort-control-container {
  position: relative;
}

.effort-capsule {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 8px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-full);
  font-size: 11.5px;
  font-weight: 500;
  color: var(--text);
  cursor: pointer;
  transition: all 0.12s ease;
}

.effort-capsule:hover {
  background: var(--surface-hover);
  border-color: var(--border-strong);
}

.effort-dot-ring {
  width: 7px;
  height: 7px;
  border-radius: var(--radius-full);
  border: 1.5px solid var(--accent);
  background: transparent;
}

.effort-popup {
  position: absolute;
  bottom: calc(100% + 8px);
  right: 0;
  width: 260px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-strong);
  border-radius: 14px;
  box-shadow: var(--shadow-md);
  padding: 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  z-index: 200;
}

.effort-popup-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.head-left {
  display: flex;
  align-items: center;
  gap: 6px;
}

.effort-title {
  font-size: 12px;
  color: var(--text-muted);
}

.effort-value-badge {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text);
}

.effort-help {
  width: 15px;
  height: 15px;
  border-radius: var(--radius-full);
  border: 1px solid var(--border-strong);
  color: var(--text-subtle);
  font-size: 10px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: help;
}

.effort-labels {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 10.5px;
  color: var(--text-subtle);
}

/* 5 档刻度滑块条 (对标图 1) */
.effort-slider-track {
  position: relative;
  display: flex;
  align-items: center;
  height: 24px;
  background: var(--surface);
  border-radius: var(--radius-full);
  padding: 0 8px;
}

.track-bar {
  position: absolute;
  left: 12px;
  right: 12px;
  height: 4px;
  background: var(--border-strong);
  border-radius: 2px;
  overflow: hidden;
}

.track-fill {
  height: 100%;
  background: var(--accent);
  border-radius: 2px;
  transition: width 0.15s ease;
}

.ticks-row {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  z-index: 2;
}

.tick-dot-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: var(--radius-full);
  cursor: pointer;
  transition: transform 0.12s ease;
}

.tick-dot {
  width: 4px;
  height: 4px;
  border-radius: var(--radius-full);
  background: var(--text-subtle);
  transition: all 0.12s ease;
}

.tick-dot-btn.active {
  background: #ffffff;
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.3);
  transform: scale(1.15);
}

.tick-dot-btn.active .tick-dot {
  width: 6px;
  height: 6px;
  background: var(--accent);
}

/* 模型切换下拉浮层 (图片 1 增强) */
.model-dropdown {
  position: absolute;
  bottom: calc(100% + 8px);
  right: 0;
  width: 290px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.16);
  padding: 8px 0 4px;
  z-index: 100;
  display: flex;
  flex-direction: column;
}

.dropdown-header-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 4px 12px 6px;
}

.dropdown-header-title {
  font-size: 11.5px;
  font-weight: 600;
  color: var(--text-muted);
}

.manage-vis-btn {
  font-size: 11px;
  color: var(--text-muted);
  padding: 2px 6px;
  border-radius: var(--radius-sm);
  background: var(--surface);
  border: 1px solid var(--border);
  transition: all 0.12s ease;
  cursor: pointer;
}

.manage-vis-btn:hover {
  background: var(--surface-hover);
  color: var(--text);
  border-color: var(--border-strong);
}

.manage-vis-btn.active {
  background: var(--accent);
  color: #ffffff;
  border-color: var(--accent);
  font-weight: 500;
}

/* 搜索框 (图片 1 红框) */
.model-search-box {
  position: relative;
  display: flex;
  align-items: center;
  margin: 4px 10px 6px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 0 8px;
  transition: border-color 0.15s ease;
}

.model-search-box:focus-within {
  border-color: var(--accent);
  box-shadow: 0 0 0 2px rgba(217, 119, 87, 0.15);
}

.model-search-box .search-icon {
  color: var(--text-subtle);
  margin-right: 6px;
  flex-shrink: 0;
}

.model-search-input {
  width: 100%;
  border: none;
  background: transparent;
  outline: none;
  font-size: 11.5px;
  color: var(--text);
  padding: 5px 0;
}

.model-search-input::placeholder {
  color: var(--text-subtle);
  font-size: 11px;
}

.clear-search-btn {
  font-size: 14px;
  line-height: 1;
  color: var(--text-subtle);
  cursor: pointer;
  padding: 0 2px;
}

.clear-search-btn:hover {
  color: var(--text);
}

.visibility-guide-tip {
  padding: 3px 12px;
  font-size: 10.5px;
  color: var(--accent);
  background: rgba(217, 119, 87, 0.08);
  margin-bottom: 4px;
}

.dropdown-scroll {
  max-height: 220px;
  overflow-y: auto;
  padding: 2px 0;
}

.dropdown-group {
  margin-bottom: 6px;
}

.group-title {
  font-size: 10.5px;
  font-weight: 600;
  color: var(--text-subtle);
  padding: 4px 12px 2px;
  letter-spacing: 0.2px;
}

.model-option-row {
  position: relative;
}

.model-option {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 5px 12px;
  font-size: 12px;
  color: var(--text);
  text-align: left;
  transition: background 0.1s ease, opacity 0.15s ease;
  gap: 8px;
}

.model-option:hover {
  background: var(--surface-hover);
}

.model-option.selected {
  font-weight: 600;
  color: var(--accent);
  background: rgba(217, 119, 87, 0.06);
}

.model-option.is-hidden-opt {
  opacity: 0.45;
  text-decoration: line-through;
}

.model-vis-badge {
  font-size: 10px;
  padding: 1px 6px;
  border-radius: var(--radius-sm);
  background: rgba(46, 160, 67, 0.12);
  color: var(--success);
  border: 1px solid rgba(46, 160, 67, 0.25);
  cursor: pointer;
  white-space: nowrap;
  transition: all 0.12s ease;
}

.model-vis-badge:hover {
  filter: brightness(1.1);
}

.model-vis-badge.hidden {
  background: var(--surface);
  color: var(--text-subtle);
  border-color: var(--border);
}

.option-check {
  color: var(--accent);
  font-size: 12px;
}

.empty-search-box {
  padding: 16px 12px;
  text-align: center;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
}

.empty-search-text {
  font-size: 11.5px;
  color: var(--text-subtle);
}

.btn-restore-hidden {
  font-size: 11px;
  color: var(--accent);
  background: transparent;
  text-decoration: underline;
  cursor: pointer;
}

.dropdown-footer {
  padding: 6px 10px 4px;
  border-top: 1px solid var(--border);
  margin-top: 2px;
}

.footer-meta-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.footer-count {
  font-size: 10px;
  color: var(--text-subtle);
}

.footer-btn {
  font-size: 11px;
  color: var(--text-muted);
  cursor: pointer;
  transition: color 0.12s ease;
}

.footer-btn:hover {
  color: var(--text);
}

.footer-btn:hover {
  color: var(--text);
}

/* 发送 / 停止 */
.submit-action {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: var(--radius-full);
  transition: all 0.12s ease;
  flex: none;
}

.send-btn {
  background: var(--accent);
  color: #fff;
}

.send-btn:hover:not(:disabled) {
  background: var(--accent-hover);
}

.send-btn:disabled {
  background: var(--surface);
  color: var(--text-subtle);
  cursor: not-allowed;
}

.stop-btn {
  background: var(--danger);
  color: #fff;
}

.stop-icon {
  width: 8px;
  height: 8px;
  background: #fff;
  border-radius: 1px;
}

.footer-note {
  margin: 6px 0 0;
  font-size: 11px;
  text-align: center;
}

/* 通知条样式 */
.approval {
  margin-bottom: 12px;
  padding: 12px;
  border: 1px solid var(--accent);
  border-radius: var(--radius);
  background: var(--accent-soft);
}

.approval-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.approval-badge {
  font-size: 11px;
  font-weight: 600;
  color: var(--accent);
}

.approval-tool {
  font-size: 12px;
}

.approval-reason {
  margin: 6px 0;
  font-size: 12px;
}

.approval-params {
  margin: 4px 0 8px;
  padding: 6px 8px;
  font-size: 11px;
  background: var(--bg-elevated);
  border-radius: var(--radius-sm);
  max-height: 120px;
  overflow-y: auto;
}

.approval-actions {
  display: flex;
  gap: 8px;
}

/* Freebuff 高危安全护栏拦截卡片样式 */
.critical-security-card {
  border-color: #ef4444 !important;
  background: rgba(239, 68, 68, 0.08) !important;
  box-shadow: 0 4px 20px rgba(239, 68, 68, 0.15) !important;
}

.critical-badge {
  background: #ef4444 !important;
  color: #ffffff !important;
  padding: 2px 8px;
  border-radius: 4px;
}

.critical-text {
  color: #b91c1c !important;
  font-weight: 600;
}

.btn-critical {
  background: #ef4444 !important;
  border-color: #ef4444 !important;
  color: #ffffff !important;
}

/* TRAE 工作流模式切换按钮 */
.mode-tag {
  user-select: none;
  cursor: pointer;
  transition: all 0.15s ease;
}

.mode-tag.mode-builder {
  background: rgba(37, 99, 235, 0.08);
  border-color: #2563eb;
  color: #2563eb;
  font-weight: 600;
}

.mode-tag.mode-chat {
  background: rgba(16, 185, 129, 0.08);
  border-color: #10b981;
  color: #10b981;
  font-weight: 600;
}

.retry-banner,
.switch-notice,
.error-banner,
.editing-hint {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
  padding: 6px 12px;
  border-radius: var(--radius);
  font-size: 12px;
}

.retry-banner {
  background: var(--surface);
  border: 1px solid var(--border);
}

.retry-spinner {
  width: 12px;
  height: 12px;
  border: 2px solid var(--border-strong);
  border-top-color: var(--accent);
  border-radius: var(--radius-full);
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.switch-notice {
  background: var(--surface);
  border: 1px solid var(--border);
}

.error-banner {
  background: var(--danger-soft);
  color: var(--danger);
  border: 1px solid var(--danger);
}

.editing-hint {
  background: var(--surface);
  border: 1px dashed var(--border-strong);
}

/* 尚搏企业官方 Logo 样式 */
.welcome-brand-logo {
  width: 32px;
  height: 32px;
  object-fit: contain;
  border-radius: 6px;
  flex-shrink: 0;
}

.mascot-brand-img {
  width: 20px;
  height: 20px;
  object-fit: contain;
  border-radius: 4px;
}

/* ========================================================
   上下文窗口浮层 (对标图 2 样式)
   ======================================================== */
.context-window-popup {
  position: absolute;
  bottom: calc(100% + 10px);
  right: 0;
  width: 330px;
  background: var(--bg-elevated, #ffffff);
  border: 1px solid var(--border-strong, #e2e8f0);
  border-radius: var(--radius-md, 12px);
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.16);
  padding: 14px 16px;
  z-index: 120;
  color: var(--text, #1e293b);
  animation: popupSlideUp 0.15s ease-out;
}

.cw-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  cursor: pointer;
  margin-bottom: 10px;
}

/* 快捷容量规格选择条 */
.cw-capacity-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
  padding: 5px 8px;
  background: var(--surface);
  border-radius: var(--radius-sm, 6px);
  border: 1px solid var(--border);
}

.cw-cap-label {
  font-size: 11px;
  color: var(--text-muted);
  font-weight: 500;
}

.cw-cap-pills {
  display: flex;
  gap: 4px;
}

.cw-cap-pill {
  padding: 2px 7px;
  font-size: 10.5px;
  border-radius: 4px;
  border: 1px solid var(--border);
  background: var(--bg-elevated);
  color: var(--text-muted);
  cursor: pointer;
  transition: all 0.15s ease;
}

.cw-cap-pill:hover {
  background: var(--surface-hover);
  color: var(--text);
}

.cw-cap-pill.active {
  background: #2563eb;
  color: #ffffff;
  border-color: #2563eb;
  font-weight: 600;
}

.cw-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
}

.cw-summary {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--text-muted);
}

.cw-ratio {
  font-variant-numeric: tabular-nums;
  font-weight: 500;
}

.cw-chevron {
  color: var(--text-muted);
}

/* 进度条 */
.cw-bar-track {
  display: flex;
  height: 7px;
  width: 100%;
  border-radius: 4px;
  overflow: hidden;
  background: #f1f5f9;
  margin-bottom: 14px;
  gap: 1px;
}

.cw-seg {
  height: 100%;
  min-width: 2px;
  transition: width 0.2s ease;
}

/* 颜色对应图 2 (media_1790326705999.png) */
.seg-mcp {
  background-color: #2563eb;
}
.seg-system-tools {
  background-color: #ea580c;
}
.seg-skills {
  background-color: #10b981;
}
.seg-prompt {
  background-color: #f59e0b;
}
.seg-memory {
  background-color: #ec4899;
}
.seg-messages {
  background-color: #15803d;
}
.seg-free {
  background-color: #e2e8f0;
}

/* 明细表格 */
.cw-breakdown-table {
  display: flex;
  flex-direction: column;
  gap: 7px;
  margin-bottom: 12px;
}

.cw-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  line-height: 1.4;
}

.cw-col-name {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text);
  flex: 1;
}

.cw-dot {
  width: 8px;
  height: 8px;
  border-radius: 2px;
  flex-shrink: 0;
}

.cw-col-val {
  color: var(--text);
  font-variant-numeric: tabular-nums;
  text-align: right;
  min-width: 52px;
}

.cw-col-pct {
  color: var(--text-muted);
  font-variant-numeric: tabular-nums;
  text-align: right;
  min-width: 44px;
  font-size: 11.5px;
}

.cw-row-free {
  padding-top: 4px;
  border-top: 1px dashed var(--border);
}

.cw-row-free .cw-col-name span:last-child {
  color: var(--text-muted);
}

/* 可折叠列表 */
.cw-expandable-section {
  border-top: 1px solid var(--border);
  padding-top: 8px;
  margin-top: 6px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.cw-exp-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 5px 6px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  font-size: 12px;
  color: var(--text-muted);
  transition: all 0.12s ease;
}

.cw-exp-item:hover {
  background: var(--surface-hover);
  color: var(--text);
}

.cw-exp-left {
  display: flex;
  align-items: center;
  gap: 6px;
}

.cw-exp-arrow {
  display: inline-block;
  font-size: 13px;
  line-height: 1;
  transition: transform 0.15s ease;
}

.cw-exp-arrow.open {
  transform: rotate(90deg);
}

.cw-exp-right {
  display: flex;
  align-items: center;
  gap: 8px;
  font-variant-numeric: tabular-nums;
}

.cw-exp-tokens {
  color: var(--text);
}

.cw-exp-count {
  color: var(--text-muted);
  background: var(--surface);
  border-radius: 10px;
  padding: 0 6px;
  font-size: 11px;
}

.cw-exp-sublist {
  padding-left: 20px;
  padding-bottom: 4px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.cw-sub-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 11px;
  color: var(--text-subtle);
}

/* 底部操作链接 */
.cw-footer {
  border-top: 1px solid var(--border);
  margin-top: 8px;
  padding-top: 10px;
}

.cw-detail-link {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  background: none;
  border: none;
  font-size: 11.5px;
  color: var(--primary, #d97757);
  cursor: pointer;
  padding: 4px 6px;
  border-radius: var(--radius-sm);
  transition: background 0.12s ease;
}

.cw-detail-link:hover {
  background: var(--surface-hover);
  text-decoration: underline;
}
</style>