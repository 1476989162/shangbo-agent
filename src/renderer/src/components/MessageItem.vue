<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ContentBlock, Message } from '@shared/types'
import MarkdownBlock from './MarkdownBlock.vue'

const props = defineProps<{ message: Message; isLast: boolean }>()
const emit = defineEmits<{ regenerate: [messageId: string] }>()
const copied = ref(false)

type RenderItem =
  | { kind: 'text'; key: string; text: string }
  | { kind: 'reasoning'; key: string; text: string }
  | {
      kind: 'tool'
      key: string
      name: string
      input: unknown
      result?: { content: string; isError: boolean }
    }

const isUser = computed(() => props.message.role === 'user')
const isStreaming = computed(() => props.message.status === 'streaming')

/** 文本块用于复制与判断"是否只有思考没有正文"。 */
const textContent = computed(() =>
  props.message.blocks
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('')
)

const renderItems = computed<RenderItem[]>(() => {
  const results = new Map<string, { content: string; isError: boolean }>()
  for (const block of props.message.blocks) {
    if (block.type === 'tool_result') {
      results.set(block.toolUseId, { content: block.content, isError: block.isError })
    }
  }

  const items: RenderItem[] = []
  let index = 0

  for (const block of props.message.blocks) {
    if (block.type === 'text') {
      items.push({ kind: 'text', key: `t${index++}`, text: block.text })
    } else if (block.type === 'reasoning') {
      items.push({ kind: 'reasoning', key: `r${index++}`, text: block.text })
    } else if (block.type === 'tool_use') {
      items.push({
        kind: 'tool',
        key: `u${index++}`,
        name: block.name,
        input: block.input,
        result: results.get(block.id)
      })
    }
  }

  return items
})

const usageLabel = computed(() => {
  const usage = props.message.usage
  if (!usage) return ''
  return `输入 ${usage.promptTokens} · 输出 ${usage.completionTokens} tokens`
})

/** 工具卡片标题上的一句话摘要，避免用户展开才能看懂调用了什么。 */
function summarizeInput(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const record = input as Record<string, unknown>
  if (name === 'run_command' && typeof record.command === 'string') return record.command
  if (typeof record.path === 'string') return record.path
  if (typeof record.query === 'string') return record.query
  const first = Object.values(record)[0]
  return typeof first === 'string' ? first : ''
}

function prettyJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

async function copy(): Promise<void> {
  const text = textContent.value
  if (!text) return
  try {
    await navigator.clipboard.writeText(text)
  } catch {
    const area = document.createElement('textarea')
    area.value = text
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    document.execCommand('copy')
    document.body.removeChild(area)
  }
  copied.value = true
  setTimeout(() => (copied.value = false), 1600)
}
</script>

<template>
  <article class="message" :class="isUser ? 'message-user' : 'message-assistant'">
    <div v-if="isUser" class="bubble">
      <p class="user-text">{{ textContent }}</p>
    </div>

    <template v-else>
      <div class="assistant-body">
        <template v-for="item in renderItems" :key="item.key">
          <MarkdownBlock v-if="item.kind === 'text'" :source="item.text" :streaming="isStreaming" />

          <details v-else-if="item.kind === 'reasoning'" class="reasoning">
            <summary>思考过程</summary>
            <p class="reasoning-text">{{ item.text }}</p>
          </details>

          <details v-else class="tool-card" :class="{ failed: item.result?.isError }">
            <summary>
              <span class="tool-name mono">{{ item.name }}</span>
              <span v-if="summarizeInput(item.name, item.input)" class="tool-summary">
                {{ summarizeInput(item.name, item.input) }}
              </span>
              <span v-if="!item.result" class="tool-pending subtle">执行中…</span>
            </summary>

            <div class="tool-detail">
              <p class="tool-section-label">参数</p>
              <pre class="tool-pre mono">{{ prettyJson(item.input) }}</pre>

              <template v-if="item.result">
                <p class="tool-section-label">
                  结果
                  <span v-if="item.result.isError" class="tool-error-tag">失败</span>
                </p>
                <pre class="tool-pre mono">{{ item.result.content }}</pre>
              </template>
            </div>
          </details>
        </template>

        <div v-if="isStreaming && renderItems.length === 0" class="thinking subtle">
          <span class="pulse" />
          正在思考…
        </div>

        <p v-if="message.status === 'error' && message.error" class="error-line">
          {{ message.error }}
        </p>
        <p v-else-if="message.status === 'aborted'" class="aborted subtle">已中断生成</p>

        <footer v-if="!isStreaming" class="message-actions">
          <button v-if="textContent" class="btn btn-ghost tiny" @click="copy">
            {{ copied ? '已复制' : '复制' }}
          </button>
          <button
            v-if="isLast"
            class="btn btn-ghost tiny"
            title="重新生成这条回复"
            @click="emit('regenerate', message.id)"
          >
            重新生成
          </button>
          <span v-if="usageLabel" class="usage subtle">{{ usageLabel }}</span>
        </footer>
      </div>
    </template>
  </article>
</template>

<style scoped>
.message {
  padding: 0 0 20px;
}

.message-user {
  display: flex;
  justify-content: flex-end;
}

.bubble {
  max-width: 78%;
  padding: 10px 14px;
  border-radius: var(--radius-lg);
  background: var(--surface);
  border: 1px solid var(--border);
}

.user-text {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
}

.assistant-body {
  max-width: 100%;
}

.reasoning {
  margin: 0 0 12px;
  border-left: 2px solid var(--border-strong);
  padding-left: 12px;
}

.reasoning summary {
  cursor: pointer;
  font-size: var(--text-xs);
  color: var(--text-muted);
  list-style: none;
}

.reasoning summary::-webkit-details-marker {
  display: none;
}

.reasoning-text {
  margin: 8px 0 0;
  font-size: var(--text-sm);
  color: var(--text-muted);
  white-space: pre-wrap;
}

.tool-card {
  margin: 0 0 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
  overflow: hidden;
}

.tool-card.failed {
  border-color: color-mix(in srgb, var(--danger) 40%, var(--border));
}

.tool-card summary {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 12px;
  cursor: pointer;
  list-style: none;
  font-size: var(--text-sm);
}

.tool-card summary::-webkit-details-marker {
  display: none;
}

.tool-name {
  font-weight: 600;
  flex: none;
}

.tool-summary {
  flex: 1;
  min-width: 0;
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.tool-pending {
  flex: none;
  font-size: var(--text-xs);
}

.tool-detail {
  padding: 4px 12px 12px;
  border-top: 1px solid var(--border);
}

.tool-section-label {
  margin: 10px 0 4px;
  font-size: var(--text-xs);
  color: var(--text-muted);
}

.tool-error-tag {
  margin-left: 6px;
  padding: 1px 6px;
  border-radius: var(--radius-full);
  background: var(--danger-soft);
  color: var(--danger);
}

.tool-pre {
  margin: 0;
  padding: 8px 10px;
  max-height: 320px;
  overflow: auto;
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  white-space: pre-wrap;
  word-break: break-word;
}

.thinking {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: var(--text-sm);
}

.pulse {
  width: 7px;
  height: 7px;
  border-radius: var(--radius-full);
  background: var(--accent);
  animation: pulse 1.2s ease-in-out infinite;
}

@keyframes pulse {
  0%,
  100% {
    opacity: 0.3;
    transform: scale(0.9);
  }
  50% {
    opacity: 1;
    transform: scale(1.1);
  }
}

.error-line {
  margin: 8px 0 0;
  padding: 8px 12px;
  border-radius: var(--radius);
  background: var(--danger-soft);
  color: var(--danger);
  font-size: var(--text-sm);
  white-space: pre-wrap;
}

.aborted {
  margin: 8px 0 0;
  font-size: var(--text-sm);
}

.message-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 6px;
  min-height: 24px;
}

.tiny {
  padding: 2px 8px;
  font-size: var(--text-xs);
  border-radius: var(--radius-sm);
  color: var(--text-muted);
}

.usage {
  margin-left: auto;
  font-size: 11px;
}
</style>