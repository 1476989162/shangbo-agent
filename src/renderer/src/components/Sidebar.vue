<script setup lang="ts">
import { computed, ref } from 'vue'
import { useChatStore } from '../stores/chat'

const emit = defineEmits<{ openSettings: [] }>()
const store = useChatStore()
const pendingDeleteId = ref<string | null>(null)

const sortedConversations = computed(() => store.conversations)

function formatTime(timestamp: number): string {
  const date = new Date(timestamp)
  const now = new Date()
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate()

  if (sameDay) {
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
  }

  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  const isYesterday =
    date.getFullYear() === yesterday.getFullYear() &&
    date.getMonth() === yesterday.getMonth() &&
    date.getDate() === yesterday.getDate()

  if (isYesterday) return '昨天'
  if (date.getFullYear() === now.getFullYear()) return `${date.getMonth() + 1}月${date.getDate()}日`
  return `${date.getFullYear()}/${date.getMonth() + 1}/${date.getDate()}`
}

async function confirmDelete(id: string): Promise<void> {
  await store.removeConversation(id)
  pendingDeleteId.value = null
}
</script>

<template>
  <aside class="sidebar">
    <header class="sidebar-header">
      <span class="brand-dot" />
      <span class="brand-name">尚搏 Agent</span>
    </header>

    <div class="sidebar-actions">
      <button class="btn btn-primary new-chat" @click="store.createConversation()">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M8 3v10M3 8h10"
            stroke="currentColor"
            stroke-width="1.6"
            stroke-linecap="round"
          />
        </svg>
        新建对话
      </button>
    </div>

    <nav class="conversation-list">
      <p v-if="sortedConversations.length === 0" class="empty subtle">还没有对话</p>

      <div
        v-for="conversation in sortedConversations"
        :key="conversation.id"
        class="conversation"
        :class="{ active: conversation.id === store.activeConversationId }"
        @click="store.openConversation(conversation.id)"
      >
        <div class="conversation-body">
          <p class="conversation-title">{{ conversation.title }}</p>
          <p class="conversation-time subtle">{{ formatTime(conversation.updatedAt) }}</p>
        </div>

        <div v-if="pendingDeleteId === conversation.id" class="confirm" @click.stop>
          <button class="btn btn-ghost tiny btn-danger" @click="confirmDelete(conversation.id)">
            删除
          </button>
          <button class="btn btn-ghost tiny" @click="pendingDeleteId = null">取消</button>
        </div>
        <button
          v-else
          class="btn btn-ghost icon-only delete"
          title="删除对话"
          @click.stop="pendingDeleteId = conversation.id"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M3.5 4.5h9M6.5 4.5V3h3v1.5M5 4.5l.6 8h4.8l.6-8"
              stroke="currentColor"
              stroke-width="1.3"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>
      </div>
    </nav>

    <footer class="sidebar-footer">
      <button class="btn btn-ghost settings" @click="emit('openSettings')">
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <circle cx="8" cy="8" r="2.2" stroke="currentColor" stroke-width="1.3" />
          <path
            d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1"
            stroke="currentColor"
            stroke-width="1.3"
            stroke-linecap="round"
          />
        </svg>
        设置
      </button>
    </footer>
  </aside>
</template>

<style scoped>
.sidebar {
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: var(--sidebar-bg);
  border-right: 1px solid var(--border);
}

.sidebar-header {
  display: flex;
  align-items: center;
  gap: 8px;
  height: var(--titlebar-height);
  padding: 0 16px;
  flex: none;
  -webkit-app-region: drag;
}

.brand-dot {
  width: 9px;
  height: 9px;
  border-radius: var(--radius-full);
  background: var(--accent);
  flex: none;
}

.brand-name {
  font-size: var(--text-sm);
  font-weight: 600;
  letter-spacing: 0.2px;
}

.sidebar-actions {
  padding: 4px 12px 12px;
  flex: none;
}

.new-chat {
  width: 100%;
}

.conversation-list {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 0 8px 8px;
}

.empty {
  padding: 12px 8px;
  font-size: var(--text-sm);
}

.conversation {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 8px 10px;
  border-radius: var(--radius);
  cursor: pointer;
  transition: background 0.12s ease;
}

.conversation:hover {
  background: var(--surface-hover);
}

.conversation.active {
  background: var(--surface);
  box-shadow: inset 0 0 0 1px var(--border);
}

.conversation-body {
  flex: 1;
  min-width: 0;
}

.conversation-title {
  margin: 0;
  font-size: var(--text-sm);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.conversation-time {
  margin: 1px 0 0;
  font-size: 11px;
}

.icon-only {
  padding: 4px;
  border-radius: var(--radius-sm);
  opacity: 0;
  flex: none;
}

.conversation:hover .icon-only {
  opacity: 1;
}

.delete:hover {
  color: var(--danger);
}

.confirm {
  display: flex;
  gap: 2px;
  flex: none;
}

.tiny {
  padding: 2px 6px;
  font-size: 11px;
  border-radius: var(--radius-sm);
}

.sidebar-footer {
  flex: none;
  padding: 8px 12px 12px;
  border-top: 1px solid var(--border);
}

.settings {
  width: 100%;
  justify-content: flex-start;
  gap: 8px;
  color: var(--text-muted);
}
</style>