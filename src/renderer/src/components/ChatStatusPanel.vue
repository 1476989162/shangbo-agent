<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { RetryInfo, SwitchNotice } from '../stores/chat'
import type { TodoItem } from '@shared/types'

const props = defineProps<{
  todos: TodoItem[]
  retry: RetryInfo | null
  switchNotice: SwitchNotice | null
  error: string | null
  canScrollToBottom: boolean
  streaming: boolean
}>()

const emit = defineEmits<{
  stop: []
  dismissSwitchNotice: []
  dismissError: []
  scrollToBottom: []
}>()

/** 重试倒计时：retry.waitMs 为该次等待总时长，本地每 250ms 递减显示。 */
const retryCountdown = ref(0)
let countdownTimer: ReturnType<typeof setInterval> | null = null

watch(
  () => props.retry?.waitMs,
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
  if (countdownTimer) clearInterval(countdownTimer)
})

const completedTodoCount = computed(
  () => props.todos.filter((item) => item.status === 'completed').length
)

/** 任务清单默认收起，只留进度；点标题展开看明细。 */
const todosCollapsed = ref(true)

/** 切换原因可能是一整段 HTTP 错误 JSON，提示条里只展示一句可读摘要。 */
function shortReason(reason: string): string {
  const flat = reason.replace(/\s+/g, ' ').trim()
  if (/429|rate.?limit|tpm|rpm/i.test(flat)) return '（触发了限流）'
  if (/timeout|超时/i.test(flat)) return '（首字节超时）'
  if (/5\d\d|overloaded|unavailable/i.test(flat)) return '（服务暂时不可用）'
  return flat ? `（${flat.slice(0, 60)}${flat.length > 60 ? '…' : ''}）` : ''
}
</script>

<template>
  <div v-if="todos.length > 0" class="todo-panel">
    <div class="todo-panel-head todo-toggle" @click="todosCollapsed = !todosCollapsed">
      <span>{{ todosCollapsed ? '›' : '▾' }} 任务清单</span>
      <span class="todo-panel-count">{{ completedTodoCount }}/{{ todos.length }}</span>
    </div>
    <ul v-if="!todosCollapsed" class="todo-list">
      <li v-for="item in todos" :key="item.id" class="todo-item" :class="item.status">
        <span class="todo-status" aria-hidden="true">
          {{ item.status === 'completed' ? '✓' : item.status === 'in_progress' ? '◌' : '○' }}
        </span>
        <span class="todo-content">{{ item.content }}</span>
      </li>
    </ul>
  </div>

  <div v-if="retry" class="retry-banner">
    <span class="retry-spinner" aria-hidden="true" />
    <span class="retry-text">
      {{ retry.providerName }} {{ retry.reason }}，
      <strong>{{ retryCountdown }}</strong> 秒后自动重试
      （第 {{ retry.attempt }}/{{ retry.maxAttempts }} 次）
    </span>
    <button class="btn btn-ghost tiny" @click="emit('stop')">停止等待</button>
  </div>

  <div v-if="switchNotice" class="switch-notice">
    <span class="switch-icon">⇄</span>
    <span class="switch-text">
      「{{ switchNotice.fromProviderName }}」暂不可用，已自动切换至
      <strong>{{ switchNotice.providerName }} / {{ switchNotice.model }}</strong>
      <span class="switch-reason subtle">{{ shortReason(switchNotice.reason) }}</span>
    </span>
    <button class="btn btn-ghost tiny" @click="emit('dismissSwitchNotice')">知道了</button>
  </div>

  <div v-if="error" class="error-banner">
    <span class="error-text">{{ error }}</span>
    <button class="btn btn-ghost tiny" @click="emit('dismissError')">关闭</button>
  </div>

  <div class="scroll-bottom-wrapper">
    <transition name="scroll-down-pop">
      <button
        v-if="canScrollToBottom"
        type="button"
        class="scroll-bottom-fab"
        :class="{ streaming }"
        title="滚动回到底部"
        @click="emit('scrollToBottom')"
      >
        <svg class="down-arrow-svg" width="16" height="16" viewBox="0 0 24 24" fill="none">
          <path
            d="M12 4v13M6 12l6 6 6-6"
            stroke="currentColor"
            stroke-width="2.2"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
        <span v-if="streaming" class="scroll-bottom-indicator" title="新内容持续生成中" />
      </button>
    </transition>
  </div>
</template>

<style scoped>
.todo-panel {
  margin-bottom: 12px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
}

.todo-panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 6px;
  color: var(--text-muted);
  font-size: 12px;
  font-weight: 600;
}

.todo-toggle {
  cursor: pointer;
  user-select: none;
}

.todo-toggle:hover {
  color: var(--text);
}

.todo-panel-count {
  font-variant-numeric: tabular-nums;
  color: var(--text-subtle);
}

.todo-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.todo-item {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.45;
}

.todo-status {
  flex: none;
  width: 14px;
  color: var(--text-subtle);
  text-align: center;
}

.todo-item.in_progress .todo-status {
  color: var(--accent);
}

.todo-item.completed .todo-status {
  color: var(--success, #2f9e62);
}

.todo-item.completed .todo-content {
  color: var(--text-subtle);
  text-decoration: line-through;
}

.retry-banner,
.switch-notice,
.error-banner {
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
  to {
    transform: rotate(360deg);
  }
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
</style>
