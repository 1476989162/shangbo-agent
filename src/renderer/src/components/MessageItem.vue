<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ContentBlock, Message } from '@shared/types'
import type { BranchInfo } from '../stores/chat'
import MarkdownBlock from './MarkdownBlock.vue'

const props = defineProps<{ message: Message; isLast: boolean; branch?: BranchInfo | null }>()
const emit = defineEmits<{
  regenerate: [messageId: string]
  switchBranch: [messageId: string]
  edit: [payload: { content: string; parentId: string | null }]
  autoContinue: [messageId: string]
}>()
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

/** 思考过程耗尽了单次 Token 额度，导致没有正式正文或工具调用的异常状态 */
const hasOnlyReasoning = computed(() => {
  return (
    renderItems.value.some((item) => item.kind === 'reasoning') &&
    !renderItems.value.some((item) => item.kind === 'text') &&
    !renderItems.value.some((item) => item.kind === 'tool')
  )
})

/** 是否由于单次输出 Token 触顶发生截断（包含只有思考无正文，或 finishReason 为 length） */
const isTruncated = computed(() => {
  if (hasOnlyReasoning.value) return true
  const reason = props.message.usage?.finishReason
  return reason === 'length' || reason === 'max_tokens'
})

/** 正在执行或思考中的实时动态图标 */
const liveWorkingIcon = computed(() => {
  const lastItem = renderItems.value[renderItems.value.length - 1]
  if (lastItem && lastItem.kind === 'tool' && !lastItem.result) {
    if (lastItem.name === 'read_file') return '📖'
    if (lastItem.name === 'write_file') return '✏️'
    if (lastItem.name === 'patch_file') return '🩹'
    if (lastItem.name === 'run_command') return '💻'
    if (lastItem.name === 'list_directory') return '📁'
    return '⚡'
  }
  const lastBlock = props.message.blocks[props.message.blocks.length - 1]
  if (lastBlock && lastBlock.type === 'reasoning') {
    return '🧠'
  }
  return '⚡'
})

/** 当前实时工作状态描述 */
const liveWorkingStatus = computed(() => {
  if (!isStreaming.value) return null

  // 1. 如果最后一个元素是工具且尚未返回结果：说明正在执行本机工具
  const lastItem = renderItems.value[renderItems.value.length - 1]
  if (lastItem && lastItem.kind === 'tool' && !lastItem.result) {
    const target = summarizeInput(lastItem.name, lastItem.input)
    if (lastItem.name === 'read_file') return `正在读取文件: ${target || '…'}`
    if (lastItem.name === 'write_file') return `正在写入文件: ${target || '…'}`
    if (lastItem.name === 'patch_file') return `正在精确修改代码: ${target || '…'}`
    if (lastItem.name === 'run_command') return `正在执行终端命令: ${target || '…'}`
    if (lastItem.name === 'list_directory') return `正在检索工程目录: ${target || '…'}`
    return `正在执行工具: ${lastItem.name}…`
  }

  // 2. 如果最新块是思考块，且当前还在流式接收
  const lastBlock = props.message.blocks[props.message.blocks.length - 1]
  if (lastBlock && lastBlock.type === 'reasoning') {
    return '正在深度思考推导与规划中…'
  }

  // 3. 如果上一个工具刚刚执行完毕，正在交接给大模型分析结果并写后续代码
  if (lastItem && lastItem.kind === 'tool' && lastItem.result) {
    const target = summarizeInput(lastItem.name, lastItem.input)
    return `已完成 ${lastItem.name}${target ? ` (${target})` : ''}，正在分析并规划下一步…`
  }

  // 4. 起始状态或两步交接状态
  if (renderItems.value.length === 0) {
    return '正在分析任务并组织执行步骤…'
  }

  return '正在处理中，请稍候…'
})

const usageLabel = computed(() => {
  const usage = props.message.usage
  if (!usage) return ''
  const base = `输入 ${usage.promptTokens} · 输出 ${usage.completionTokens}`
  // 多步工具循环时，末次请求与整轮累计差异可能很大，两个口径都给用户
  if (usage.requests && usage.requests > 1) {
    return `${base} tokens（${usage.requests} 次请求，累计输入 ${usage.totalPromptTokens ?? 0} / 输出 ${
      usage.totalCompletionTokens ?? 0
    }）`
  }
  return `${base} tokens`
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
    <div v-if="isUser" class="bubble-wrap">
      <div class="bubble">
        <p class="user-text">{{ textContent }}</p>
      </div>
      <div class="bubble-actions">
        <button
          class="btn btn-ghost tiny"
          title="编辑这条消息并重新发送（将生成新的回复分支）"
          @click="emit('edit', { content: textContent, parentId: message.parentId })"
        >
          编辑
        </button>
      </div>
    </div>

    <template v-else>
      <div class="assistant-body">
        <template v-for="item in renderItems" :key="item.key">
          <MarkdownBlock v-if="item.kind === 'text'" :source="item.text" :streaming="isStreaming" />

          <details v-else-if="item.kind === 'reasoning'" class="reasoning">
            <summary>
              <svg class="chevron-icon" width="12" height="12" viewBox="0 0 16 16" fill="none">
                <path d="M6 3.5L10.5 8L6 12.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
              <span>思考过程</span>
            </summary>
            <p class="reasoning-text">{{ item.text }}</p>
          </details>

          <details v-else class="tool-card" :class="{ failed: item.result?.isError }">
            <summary>
              <svg class="chevron-icon" width="12" height="12" viewBox="0 0 16 16" fill="none">
                <path d="M6 3.5L10.5 8L6 12.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
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

        <!-- Token 耗尽友好提示与 Qoder / Cline 级智能断点续写卡片 -->
        <div v-if="(hasOnlyReasoning || isTruncated) && !isStreaming" class="token-limit-warning">
          <div class="warning-header">
            <span class="warning-icon">⚠️</span>
            <span class="warning-title">模型的思考推导过程耗尽了单次最大 Token 额度（{{ message.usage?.completionTokens ?? 8192 }} tokens），在输出正式正文前被中断。</span>
          </div>
          <p class="warning-desc">
            由于开启了<strong>「极限」</strong>思考强度，大模型在脑内推演完整代码与复杂算法时占满了全部 Token 容量，导致还没来得及开始输出正式代码。
          </p>
          <div class="warning-tips">
            <span>💡 <strong>建议操作</strong>：</span>
            <span>1. 建议点击下方<strong>「⚡ 智能继续生成」</strong>，系统将自动要求大模型跳过思考、紧接着输出剩余代码；</span>
            <span>2. 或将输入框右下角思考强度调至<strong>「标准」</strong>或<strong>「快速」</strong>，避免超长思维链占用输出配额。</span>
          </div>
          <!-- Qoder / Cline 核心体验：一键智能断点续写 -->
          <div class="continuation-action-row">
            <button class="btn-auto-continue" @click="emit('autoContinue', message.id)">
              <span class="lightning-icon">⚡</span>
              <span>智能继续生成 (Auto-Continue)</span>
            </button>
            <button class="btn-regenerate-subtle" @click="emit('regenerate', message.id)">
              重新生成本回合
            </button>
          </div>
        </div>

        <!-- 实时工作状态与进度卡片 (无论处于思考、执行工具还是分析中，均清晰可见当前在干什么) -->
        <div v-if="isStreaming" class="live-working-banner">
          <span class="live-working-spinner" aria-hidden="true" />
          <span class="live-working-icon">{{ liveWorkingIcon }}</span>
          <span class="live-working-text">{{ liveWorkingStatus }}</span>
          <span class="live-working-dots">
            <span class="dot d1">.</span>
            <span class="dot d2">.</span>
            <span class="dot d3">.</span>
          </span>
        </div>

        <p v-if="message.status === 'error' && message.error" class="error-line">
          {{ message.error }}
        </p>
        <p v-else-if="message.status === 'aborted'" class="aborted subtle">已中断生成</p>

        <footer v-if="!isStreaming" class="message-actions">
          <div v-if="branch && branch.total > 1" class="branch-nav">
            <button
              class="branch-btn"
              :disabled="!branch.prevId"
              title="上一条回复"
              @click="branch.prevId && emit('switchBranch', branch.prevId)"
            >
              ‹
            </button>
            <span class="branch-label">{{ branch.index }}/{{ branch.total }}</span>
            <button
              class="branch-btn"
              :disabled="!branch.nextId"
              title="下一条回复"
              @click="branch.nextId && emit('switchBranch', branch.nextId)"
            >
              ›
            </button>
          </div>
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

.bubble-wrap {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  max-width: 78%;
}

.bubble-actions {
  display: flex;
  gap: 4px;
  margin-top: 4px;
  opacity: 0;
  transition: opacity 0.12s ease;
}

.bubble-wrap:hover .bubble-actions {
  opacity: 1;
}

.branch-nav {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  margin-right: 4px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
}

.branch-btn {
  padding: 1px 8px;
  font-size: var(--text-sm);
  color: var(--text-muted);
  border-radius: var(--radius-sm);
}

.branch-btn:hover:not(:disabled) {
  background: var(--surface-hover);
  color: var(--text);
}

.branch-btn:disabled {
  opacity: 0.35;
  cursor: not-allowed;
}

.branch-label {
  font-size: 11px;
  color: var(--text-subtle);
  min-width: 34px;
  text-align: center;
  user-select: none;
}

.bubble {
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
  display: inline-flex;
  align-items: center;
  gap: 6px;
  cursor: pointer;
  font-size: var(--text-xs);
  color: var(--text-muted);
  list-style: none;
  user-select: none;
}

.reasoning summary::-webkit-details-marker,
.tool-card summary::-webkit-details-marker {
  display: none;
}

.chevron-icon {
  flex-shrink: 0;
  transition: transform 0.18s cubic-bezier(0.16, 1, 0.3, 1);
  color: var(--text-subtle);
}

.reasoning[open] > summary .chevron-icon,
.tool-card[open] > summary .chevron-icon {
  transform: rotate(90deg);
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

/* 实时工作状态与活动指示条（对标 Antigravity / Cursor 全生命周期状态感知） */
.live-working-banner {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  margin: 10px 0 6px;
  padding: 8px 14px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius-full, 9999px);
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.05);
  font-size: 12.5px;
  color: var(--text);
  animation: fadeInBanner 0.25s cubic-bezier(0.16, 1, 0.3, 1);
  user-select: none;
}

@keyframes fadeInBanner {
  from {
    opacity: 0;
    transform: translateY(4px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.live-working-spinner {
  width: 14px;
  height: 14px;
  border: 2px solid rgba(59, 130, 246, 0.2);
  border-top-color: var(--accent, #3b82f6);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
  flex-shrink: 0;
}

@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

.live-working-icon {
  font-size: 14px;
  line-height: 1;
  flex-shrink: 0;
}

.live-working-text {
  color: var(--text);
  font-weight: 500;
  letter-spacing: 0.2px;
}

.live-working-dots {
  display: inline-flex;
  font-weight: bold;
  color: var(--accent, #3b82f6);
  margin-left: -2px;
}

.live-working-dots .dot {
  animation: dotPulse 1.4s infinite;
  opacity: 0.2;
}

.live-working-dots .d1 {
  animation-delay: 0s;
}

.live-working-dots .d2 {
  animation-delay: 0.2s;
}

.live-working-dots .d3 {
  animation-delay: 0.4s;
}

@keyframes dotPulse {
  0%, 100% {
    opacity: 0.2;
  }
  50% {
    opacity: 1;
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

/* 思考超限未吐出正文时的警告条样式 */
.token-limit-warning {
  margin: 10px 0;
  padding: 12px 14px;
  background: var(--surface);
  border: 1px solid #f59e0b;
  border-left: 4px solid #f59e0b;
  border-radius: var(--radius-sm, 6px);
  color: var(--text);
  font-size: 12.5px;
  line-height: 1.5;
}

.warning-header {
  display: flex;
  align-items: center;
  gap: 8px;
  font-weight: 600;
  color: #b45309;
  margin-bottom: 6px;
}

.warning-icon {
  font-size: 15px;
}

.warning-title {
  font-size: 13px;
}

.warning-desc {
  margin: 0 0 8px 0;
  color: var(--text-muted);
}

.warning-tips {
  display: flex;
  flex-direction: column;
  gap: 4px;
  background: rgba(245, 158, 11, 0.08);
  padding: 8px 10px;
  border-radius: 4px;
  font-size: 12px;
  color: var(--text);
}

.continuation-action-row {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 10px;
}

.btn-auto-continue {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 14px;
  background: #f59e0b;
  color: #ffffff;
  border: none;
  border-radius: var(--radius-sm, 6px);
  font-size: 12.5px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.15s ease;
  box-shadow: 0 2px 8px rgba(245, 158, 11, 0.25);
}

.btn-auto-continue:hover {
  background: #d97706;
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(245, 158, 11, 0.35);
}

.lightning-icon {
  font-size: 14px;
}

.btn-regenerate-subtle {
  display: inline-flex;
  align-items: center;
  padding: 5px 10px;
  background: transparent;
  color: var(--text-muted);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm, 6px);
  font-size: 12px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.btn-regenerate-subtle:hover {
  background: var(--surface-hover);
  color: var(--text);
}
</style>