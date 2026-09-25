<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useChatStore } from '../stores/chat'
import MessageItem from './MessageItem.vue'

const store = useChatStore()

const draft = ref('')
const scrollEl = ref<HTMLElement | null>(null)
const textareaEl = ref<HTMLTextAreaElement | null>(null)
const pinnedToBottom = ref(true)

const path = computed(() => store.activePath)

const lastAssistantId = computed(() => {
  for (let index = path.value.length - 1; index >= 0; index--) {
    if (path.value[index].role === 'assistant') return path.value[index].id
  }
  return null
})

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

function onScroll(): void {
  const element = scrollEl.value
  if (!element) return
  pinnedToBottom.value = element.scrollHeight - element.scrollTop - element.clientHeight < 90
}

function scrollToBottom(): void {
  const element = scrollEl.value
  if (element) element.scrollTop = element.scrollHeight
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
  draft.value = ''
  await nextTick()
  autoGrow()
  await store.send(text)
}

function onKeydown(event: KeyboardEvent): void {
  // Enter 发送，Shift+Enter 换行；输入法组合状态下不拦截
  if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
    event.preventDefault()
    void submit()
  }
}

async function decide(approved: boolean, alwaysAllow = false): Promise<void> {
  await store.decideApproval(approved, alwaysAllow)
}

function onProviderChange(event: Event): void {
  const providerId = (event.target as HTMLSelectElement).value
  const provider = store.providers.find((item) => item.id === providerId)
  void store.setTarget(providerId, provider?.models[0] ?? '')
}

function onModelChange(event: Event): void {
  void store.setTarget(store.selectedProviderId, (event.target as HTMLSelectElement).value)
}

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

const suggestions = [
  '看一下我当前项目的目录结构，然后总结这个项目在做什么',
  '帮我查一下今天的日期，并算一下距离今年结束还剩多少天',
  '把这段需求整理成一份 Markdown 任务清单：做一个支持多模型切换的桌面助手'
]
</script>

<template>
  <main class="chat">
    <header class="chat-header">
      <h1 class="chat-title">{{ store.activeConversation?.title ?? '尚搏 Agent' }}</h1>
    </header>

    <div ref="scrollEl" class="chat-scroll" @scroll="onScroll">
      <div class="chat-column">
        <section v-if="path.length === 0" class="welcome">
          <h2 class="welcome-title">今天想让我做点什么？</h2>
          <p class="welcome-sub muted">
            我可以读取本机文件、执行命令、联网查资料，并把多步任务拆开一步步完成。
          </p>
          <div class="suggestions">
            <button
              v-for="(item, index) in suggestions"
              :key="index"
              class="suggestion"
              @click="draft = item"
            >
              {{ item }}
            </button>
          </div>
        </section>

        <template v-else>
          <MessageItem
            v-for="message in path"
            :key="message.id"
            :message="message"
            :is-last="message.id === lastAssistantId && !store.isStreaming"
            @regenerate="store.regenerate"
          />
        </template>
      </div>
    </div>

    <div class="chat-footer">
      <div class="chat-column">
        <div v-if="store.approval" class="approval">
          <div class="approval-head">
            <span class="approval-badge">需要确认</span>
            <span class="mono approval-tool">{{ store.approval.name }}</span>
          </div>
          <p class="approval-reason">{{ store.approval.reason }}</p>
          <pre class="approval-params mono">{{ prettyJson(store.approval.input) }}</pre>
          <div class="approval-actions">
            <button class="btn btn-primary" @click="decide(true)">允许这一次</button>
            <button class="btn" @click="decide(true, true)">始终允许</button>
            <button class="btn btn-danger" @click="decide(false)">拒绝</button>
          </div>
        </div>

        <div v-if="store.lastError" class="error-banner">
          <span class="error-text">{{ store.lastError }}</span>
          <button class="btn btn-ghost tiny" @click="store.dismissError()">关闭</button>
        </div>

        <div class="composer">
          <textarea
            ref="textareaEl"
            v-model="draft"
            class="composer-input"
            rows="1"
            placeholder="输入消息，Enter 发送，Shift + Enter 换行"
            @input="autoGrow"
            @keydown="onKeydown"
          />

          <div class="composer-bar">
            <div class="target">
              <select
                class="target-select"
                :value="store.selectedProviderId"
                @change="onProviderChange"
              >
                <option v-if="store.usableProviders.length === 0" value="">未配置供应商</option>
                <option v-for="provider in store.usableProviders" :key="provider.id" :value="provider.id">
                  {{ provider.name }}
                </option>
              </select>

              <select
                class="target-select"
                :value="store.selectedModel"
                :disabled="store.availableModels.length === 0"
                @change="onModelChange"
              >
                <option v-for="model in store.availableModels" :key="model" :value="model">
                  {{ model }}
                </option>
              </select>
            </div>

            <button
              v-if="store.isStreaming"
              class="btn send"
              @click="store.stop()"
            >
              停止
            </button>
            <button
              v-else
              class="btn btn-primary send"
              :disabled="!draft.trim()"
              @click="submit"
            >
              发送
            </button>
          </div>
        </div>

        <p class="footer-note subtle">
          {{ store.usableProviders.length === 0 ? '请先在「设置 → 模型供应商」中填入 API Key' : '回复可能不准确，重要信息请自行核实' }}
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
  background: var(--bg);
}

.chat-header {
  display: flex;
  align-items: center;
  height: var(--titlebar-height);
  padding: 0 24px;
  flex: none;
  border-bottom: 1px solid transparent;
  -webkit-app-region: drag;
}

.chat-title {
  margin: 0;
  font-size: var(--text-sm);
  font-weight: 500;
  color: var(--text-muted);
  max-width: 60%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.chat-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
}

.chat-column {
  width: 100%;
  max-width: var(--content-max);
  margin: 0 auto;
  padding: 12px 24px;
}

.welcome {
  padding: 64px 0 24px;
}

.welcome-title {
  margin: 0 0 8px;
  font-size: var(--text-xl);
  font-weight: 500;
}

.welcome-sub {
  margin: 0 0 24px;
  font-size: var(--text-sm);
}

.suggestions {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.suggestion {
  text-align: left;
  padding: 11px 14px;
  border-radius: var(--radius);
  border: 1px solid var(--border);
  background: var(--bg-elevated);
  color: var(--text-muted);
  font-size: var(--text-sm);
  transition: border-color 0.12s ease, color 0.12s ease, background 0.12s ease;
}

.suggestion:hover {
  border-color: var(--border-strong);
  background: var(--surface);
  color: var(--text);
}

.chat-footer {
  flex: none;
  padding-bottom: 12px;
  background: linear-gradient(to top, var(--bg) 78%, transparent);
}

.chat-footer .chat-column {
  padding-top: 8px;
}

.approval,
.error-banner {
  margin-bottom: 10px;
  padding: 12px 14px;
  border-radius: var(--radius);
}

.approval {
  border: 1px solid color-mix(in srgb, var(--accent) 45%, var(--border));
  background: var(--accent-soft);
}

.approval-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.approval-badge {
  padding: 1px 8px;
  border-radius: var(--radius-full);
  background: var(--accent);
  color: var(--accent-contrast);
  font-size: 11px;
  font-weight: 600;
}

.approval-tool {
  font-weight: 600;
}

.approval-reason {
  margin: 8px 0 0;
  font-size: var(--text-sm);
  color: var(--text-muted);
}

.approval-params {
  margin: 8px 0 0;
  padding: 8px 10px;
  max-height: 180px;
  overflow: auto;
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  white-space: pre-wrap;
  word-break: break-word;
}

.approval-actions {
  display: flex;
  gap: 8px;
  margin-top: 12px;
}

.error-banner {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  border: 1px solid color-mix(in srgb, var(--danger) 40%, var(--border));
  background: var(--danger-soft);
}

.error-text {
  flex: 1;
  font-size: var(--text-sm);
  color: var(--danger);
  white-space: pre-wrap;
  word-break: break-word;
}

.tiny {
  padding: 2px 8px;
  font-size: var(--text-xs);
}

.composer {
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--bg-elevated);
  box-shadow: var(--shadow-sm);
  transition: border-color 0.12s ease, box-shadow 0.12s ease;
}

.composer:focus-within {
  border-color: var(--border-strong);
  box-shadow: var(--shadow-md);
}

.composer-input {
  display: block;
  width: 100%;
  max-height: 220px;
  padding: 14px 16px 6px;
  border: none;
  background: transparent;
  outline: none;
  resize: none;
  line-height: 1.6;
}

.composer-input::placeholder {
  color: var(--text-subtle);
}

.composer-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 6px 10px 10px;
}

.target {
  display: flex;
  gap: 6px;
  min-width: 0;
}

.target-select {
  max-width: 190px;
  padding: 4px 8px;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-muted);
  font-size: var(--text-xs);
  outline: none;
  cursor: pointer;
}

.target-select:hover {
  background: var(--surface);
}

.target-select:focus {
  border-color: var(--border-strong);
}

.send {
  padding: 5px 16px;
  font-size: var(--text-sm);
  border-radius: var(--radius);
}

.footer-note {
  margin: 8px 0 0;
  text-align: center;
  font-size: 11px;
}
</style>