<script setup lang="ts">
import { computed, nextTick, ref } from 'vue'
import type { ContentBlock, Message } from '@shared/types'
import { imageFileUrl } from '@shared/imageUrl'
import type { BranchInfo } from '../stores/chat'
import MarkdownBlock from './MarkdownBlock.vue'

const props = defineProps<{
  message: Message
  isLast: boolean
  branch?: BranchInfo | null
  /** 该消息还在队列里没轮到生成回复 */
  queued?: boolean
}>()
const emit = defineEmits<{
  regenerate: [messageId: string]
  switchBranch: [messageId: string]
  edit: [payload: { content: string; parentId: string | null }]
  autoContinue: [messageId: string]
  editQueued: [messageId: string, content: string]
  cancelQueued: [messageId: string]
  steerQueued: [messageId: string]
}>()
const copied = ref(false)

/** 排队消息的行内编辑态。 */
const editingQueued = ref(false)
const editText = ref('')
const editArea = ref<HTMLTextAreaElement | null>(null)

function startEdit(): void {
  editText.value = textContent.value
  editingQueued.value = true
  void nextTick(() => {
    const area = editArea.value
    if (!area) return
    area.focus()
    area.setSelectionRange(area.value.length, area.value.length)
  })
}

async function submitEdit(): Promise<void> {
  const text = editText.value.trim()
  if (!text || text === textContent.value) {
    editingQueued.value = false
    return
  }
  editingQueued.value = false
  await emit('editQueued', props.message.id, text)
}

type RenderItem =
  | { kind: 'text'; key: string; text: string }
  | { kind: 'reasoning'; key: string; text: string }
  | {
      kind: 'tool'
      key: string
      name: string
      input: unknown
      result?: { content: string; isError: boolean; image?: { mimeType: string; dataUrl: string } }
    }

const isUser = computed(() => props.message.role === 'user')
const isStreaming = computed(() => props.message.status === 'streaming')
const modelLabel = computed(() => {
  const model = props.message.model?.trim()
  if (!model) return ''
  return model.split('/').pop() || model
})

const assistantState = computed(() => {
  if (props.message.status === 'streaming') return { label: '运行中', className: 'running' }
  if (props.message.status === 'error') return { label: '失败', className: 'failed' }
  if (props.message.status === 'aborted') return { label: '已中断', className: 'aborted' }
  return { label: '完成', className: 'done' }
})

/** 文本块用于复制与判断"是否只有思考没有正文"。 */
const textContent = computed(() =>
  props.message.blocks
    .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
    .map((block) => block.text)
    .join('')
)

/**
 * 用户消息里粘贴进来的图片，按原顺序展示在气泡顶部。
 * 图片以 file 路径持久化，这里转成 shangbo-image:// URL 交给 <img>，
 * 页面不接触真实文件系统路径。
 *
 * 单条脏数据（路径非法、被手工改过）只让这一张图不显示，
 * 不能让整条消息因渲染期抛错而整块崩掉——因此逐张 try/catch。
 */
const userImages = computed(() => {
  const urls: string[] = []
  for (const block of props.message.blocks) {
    if (block.type !== 'image') continue
    try {
      if (block.file) {
        urls.push(imageFileUrl(block.file))
      } else if (block.dataUrl) {
        // 旧数据兜底：可能是上一版直接存 base64 的会话
        urls.push(block.dataUrl)
      }
    } catch {
      // 路径非法：跳过这一张
    }
  }
  return urls
})

/** 点击放大：同一张图换成 img 标签直接铺满，Esc 或点击空白关闭。 */
const previewImage = ref<string | null>(null)

function onPreviewKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') previewImage.value = null
}

const renderItems = computed<RenderItem[]>(() => {
  const results = new Map<
    string,
    { content: string; isError: boolean; image?: { mimeType: string; dataUrl: string } }
  >()
  for (const block of props.message.blocks) {
    if (block.type === 'tool_result') {
      results.set(block.toolUseId, {
        content: block.content,
        isError: block.isError,
        image: block.image
      })
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

const activityCount = computed(
  () => renderItems.value.filter((item) => item.kind === 'reasoning' || item.kind === 'tool').length
)

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
  const total = usage.totalTokens ?? usage.promptTokens + usage.completionTokens
  const requestSuffix = usage.requests && usage.requests > 1 ? ` · ${usage.requests} 步` : ''
  return `${formatCount(total)} tokens${requestSuffix}`
})

const usageTitle = computed(() => {
  const usage = props.message.usage
  if (!usage) return ''
  const parts = [`输入 ${usage.promptTokens}`, `输出 ${usage.completionTokens}`]
  if (usage.requests) parts.push(`${usage.requests} 次请求`)
  if (usage.cacheReadTokens) parts.push(`缓存读取 ${usage.cacheReadTokens}`)
  return parts.join(' · ')
})

const toolCountLabel = computed(() => {
  const tools = renderItems.value.filter((item) => item.kind === 'tool').length
  return tools > 0 ? `${tools} 个操作` : ''
})

const reasoningLabel = computed(() => {
  const count = renderItems.value.filter((item) => item.kind === 'reasoning').length
  return count > 0 ? `${count} 段思考` : ''
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

function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`
  return String(value)
}

function toolIcon(name: string): string {
  if (name === 'read_file') return '↳'
  if (name === 'search_files') return '⌕'
  if (name === 'list_directory') return '≡'
  if (name === 'write_file' || name === 'patch_file') return '±'
  if (name === 'run_command') return '›_'
  if (name === 'spawn_subagent') return '⑂'
  if (name.startsWith('computer_')) return '▣'
  if (name.startsWith('mcp__')) return '◇'
  if (name.endsWith('_ask')) return '⌘'
  return '•'
}

function toolAction(name: string): string {
  if (name === 'read_file') return '读取文件'
  if (name === 'search_files') return '搜索文件'
  if (name === 'list_directory') return '查看目录'
  if (name === 'write_file') return '写入文件'
  if (name === 'patch_file') return '修改文件'
  if (name === 'run_command') return '运行命令'
  if (name === 'spawn_subagent') return '派生子任务'
  if (name === 'computer_screenshot') return '截取屏幕'
  if (name.startsWith('computer_')) return '操作桌面'
  if (name.startsWith('mcp__')) return '调用 MCP'
  if (name === 'qoder_ask') return '调用 Qoder'
  if (name === 'codex_ask') return '调用 Codex'
  if (name === 'claude_ask') return '调用 Claude'
  return name
}

function toolTarget(name: string, input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const record = input as Record<string, unknown>
  if (name === 'run_command' && typeof record.command === 'string') return record.command
  if (name === 'spawn_subagent' && typeof record.task === 'string') return record.task
  if (typeof record.path === 'string') return record.path
  if (typeof record.query === 'string') return record.query
  if (typeof record.text === 'string') return record.text
  if (typeof record.prompt === 'string') return record.prompt
  return summarizeInput(name, input)
}

function toolStatus(item: Extract<RenderItem, { kind: 'tool' }>): string {
  if (!item.result) return '执行中'
  if (item.result.isError) return '失败'
  return '完成'
}

function toolStatusClass(item: Extract<RenderItem, { kind: 'tool' }>): string {
  if (!item.result) return 'running'
  if (item.result.isError) return 'failed'
  return 'done'
}

function toolKindClass(name: string): string {
  if (name === 'write_file' || name === 'patch_file') return 'write'
  if (name === 'run_command') return 'command'
  if (name === 'spawn_subagent') return 'agent'
  if (name.startsWith('computer_')) return 'computer'
  return 'read'
}

function reasoningPreview(text: string): string {
  return text.replace(/\s+/g, ' ').trim().slice(0, 120)
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
        <div v-if="userImages.length > 0" class="user-images">
          <img
            v-for="(src, index) in userImages"
            :key="index"
            :src="src"
            class="user-image"
            :alt="`图片 ${index + 1}`"
            title="点击查看大图"
            @click="previewImage = src"
          />
        </div>
        <p v-if="textContent" class="user-text">{{ textContent }}</p>
      </div>
      <!-- 排队中：明确告诉用户这条已接收、会自动接力，而不是"发出去没反应" -->
      <div v-if="queued" class="queued-row">
        <p class="queued-badge">
          <span class="queued-dot" aria-hidden="true" />
          排队中，将在当前回复完成后自动处理
        </p>
        <div class="queued-actions">
          <button class="btn btn-ghost tiny" title="编辑这条排队消息的内容" @click="startEdit">
            编辑
          </button>
          <button
            class="btn btn-ghost tiny"
            title="不等排队，直接把这条内容作为指导送给正在执行的任务"
            @click="emit('steerQueued', message.id)"
          >
            指导当前任务
          </button>
          <button
            class="btn btn-ghost tiny btn-danger"
            title="撤回这条排队消息"
            @click="emit('cancelQueued', message.id)"
          >
            撤回
          </button>
        </div>
      </div>

      <!-- 排队消息的行内编辑：与「编辑已发送消息」区分，这里不产生新分支 -->
      <div v-if="editingQueued" class="queued-editor">
        <textarea
          ref="editArea"
          v-model="editText"
          class="queued-editor-textarea"
          rows="2"
          @keydown.enter.exact.prevent="submitEdit"
          @keydown.esc.prevent="editingQueued = false"
        />
        <div class="queued-editor-actions">
          <button class="btn btn-ghost tiny" @click="editingQueued = false">取消</button>
          <button class="btn btn-primary tiny" :disabled="!editText.trim()" @click="submitEdit">
            保存
          </button>
        </div>
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
      <div class="assistant-body codex-message">
        <header class="assistant-head">
          <span class="assistant-mark" aria-hidden="true">✦</span>
          <span class="assistant-name">尚搏 Agent</span>
          <span v-if="modelLabel" class="assistant-model">{{ modelLabel }}</span>
          <span class="assistant-state" :class="assistantState.className">
            <span class="assistant-state-dot" />
            {{ assistantState.label }}
          </span>
          <span v-if="activityCount > 0" class="assistant-activity-count">
            {{ toolCountLabel }}<template v-if="toolCountLabel && reasoningLabel"> · </template>{{ reasoningLabel }}
          </span>
        </header>

        <div class="codex-flow">
        <template v-for="item in renderItems" :key="item.key">
          <MarkdownBlock v-if="item.kind === 'text'" :source="item.text" :streaming="isStreaming" />

          <details v-else-if="item.kind === 'reasoning'" class="codex-activity reasoning-activity">
            <summary>
              <span class="activity-glyph">◌</span>
              <span class="activity-title">思考</span>
              <span class="activity-preview">{{ reasoningPreview(item.text) }}</span>
              <span class="activity-status" :class="isStreaming ? 'running' : 'done'">
                {{ isStreaming ? '思考中' : '已折叠' }}
              </span>
              <svg class="chevron-icon" width="12" height="12" viewBox="0 0 16 16" fill="none">
                <path d="M6 3.5L10.5 8L6 12.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </summary>
            <div class="activity-detail">
              <pre class="activity-pre reasoning-text mono">{{ item.text }}</pre>
            </div>
          </details>

          <details
            v-else
            class="codex-activity tool-activity"
            :class="[toolKindClass(item.name), { failed: item.result?.isError }]"
            :open="!item.result"
          >
            <summary>
              <span class="activity-glyph">{{ toolIcon(item.name) }}</span>
              <span class="activity-title">{{ toolAction(item.name) }}</span>
              <span v-if="toolTarget(item.name, item.input)" class="activity-preview mono">
                {{ toolTarget(item.name, item.input) }}
              </span>
              <span class="activity-status" :class="toolStatusClass(item)">
                <span v-if="!item.result" class="activity-spinner" />
                {{ toolStatus(item) }}
              </span>
              <svg class="chevron-icon" width="12" height="12" viewBox="0 0 16 16" fill="none">
                <path d="M6 3.5L10.5 8L6 12.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
            </summary>

            <div class="activity-detail">
              <div class="activity-detail-label">调用参数</div>
              <pre class="activity-pre mono">{{ prettyJson(item.input) }}</pre>

              <template v-if="item.result">
                <div class="activity-detail-label">
                  执行结果
                  <span v-if="item.result.isError" class="tool-error-tag">失败</span>
                </div>
                <img
                  v-if="item.result.image?.dataUrl"
                  :src="item.result.image.dataUrl"
                  class="activity-image"
                  alt="工具结果图片"
                />
                <pre class="activity-pre mono">{{ item.result.content }}</pre>
              </template>
            </div>
          </details>
        </template>
        </div>

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

        <footer v-if="!isStreaming" class="message-actions assistant-actions">
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
          <span v-if="usageLabel" class="usage subtle" :title="usageTitle">{{ usageLabel }}</span>
        </footer>
      </div>
    </template>
  </article>

  <!-- 图片放大遮罩：Esc 或点击空白关闭 -->
  <div
    v-if="previewImage"
    class="image-preview-mask"
    tabindex="0"
    @click="previewImage = null"
    @keydown="onPreviewKeydown"
  >
    <img :src="previewImage" class="image-preview-img" alt="图片预览" />
  </div>
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

.message-user .bubble {
  background: var(--accent-soft);
  border-color: color-mix(in srgb, var(--gold-2) 30%, var(--border));
  box-shadow: 0 1px 2px rgba(90, 64, 16, 0.05);
}

.user-text {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
}

/* 用户粘贴的图片 */
.user-images {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 6px;
}

.user-images:has(+ .user-text) {
  margin-bottom: 8px;
}

.user-image {
  width: 132px;
  max-width: 100%;
  height: 132px;
  object-fit: cover;
  border-radius: var(--radius-sm);
  border: 1px solid var(--border);
  cursor: zoom-in;
  display: block;
}

/* 图片放大遮罩 */
.image-preview-mask {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 32px;
  background: rgba(0, 0, 0, 0.78);
  cursor: zoom-out;
  outline: none;
}

.image-preview-img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  border-radius: var(--radius);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
}

/* 排队中的标记 */
/* 排队中的消息：状态 + 操作一行排布 */
.queued-row {
  display: flex;
  align-items: center;
  gap: 8px;
  align-self: flex-end;
  margin-top: 6px;
}

.queued-actions {
  display: flex;
  gap: 4px;
  opacity: 0;
  transition: opacity 0.12s ease;
}

/* 悬停时才显示操作按钮，避免静止时过于拥挤 */
.queued-row:hover .queued-actions,
.queued-row:focus-within .queued-actions {
  opacity: 1;
}

/* 排队消息的行内编辑框 */
.queued-editor {
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-self: flex-end;
  width: 100%;
  margin-top: 6px;
}

.queued-editor-textarea {
  width: 100%;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--accent);
  background: var(--bg-elevated);
  color: var(--text);
  font-size: var(--text-sm);
  font-family: inherit;
  line-height: 1.5;
  resize: vertical;
  outline: none;
}

.queued-editor-actions {
  display: flex;
  gap: 6px;
  justify-content: flex-end;
}

.queued-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  margin: 6px 0 0;
  padding: 3px 10px;
  border-radius: var(--radius-full);
  border: 1px solid var(--border);
  background: var(--bg-elevated);
  font-size: var(--text-xs);
  color: var(--text-muted);
  align-self: flex-end;
}

.queued-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  animation: queued-pulse 1.2s ease-in-out infinite;
  flex: none;
}

@keyframes queued-pulse {
  0%, 100% { opacity: 0.3; transform: scale(0.8); }
  50% { opacity: 1; transform: scale(1.1); }
}

.assistant-body {
  max-width: 100%;
}

/* Codex 式信息流：正文 + 可折叠活动行 */
.codex-message {
  width: 100%;
  padding: 1px 0 0;
}

.assistant-head {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 7px;
  margin: 0 0 10px;
  color: var(--text-muted);
  font-size: 11.5px;
  user-select: none;
}

.assistant-mark {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 23px;
  height: 23px;
  border-radius: 7px;
  color: var(--accent-strong);
  background: linear-gradient(135deg, color-mix(in srgb, var(--accent) 16%, transparent), rgba(245, 158, 11, 0.1));
  border: 1px solid color-mix(in srgb, var(--accent) 24%, transparent);
  font-size: 13px;
}

.assistant-name {
  color: var(--text);
  font-weight: 650;
  letter-spacing: 0.1px;
}

.assistant-model {
  max-width: 230px;
  overflow: hidden;
  padding: 1px 7px;
  border-radius: 999px;
  border: 1px solid var(--border);
  background: var(--surface);
  color: var(--text-subtle);
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 10.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.assistant-state {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  margin-left: 2px;
  font-size: 10.5px;
  color: var(--text-subtle);
}

.assistant-state-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: currentColor;
}

.assistant-state.running {
  color: var(--accent-strong);
}

.assistant-state.failed {
  color: var(--danger);
}

.assistant-state.aborted {
  color: var(--text-subtle);
}

.assistant-state.done {
  color: var(--success);
}

.assistant-activity-count {
  margin-left: auto;
  color: var(--text-subtle);
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
}

.codex-flow {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.codex-activity {
  margin: 1px 0;
  border: 1px solid transparent;
  border-radius: 8px;
  color: var(--text-muted);
  transition: background 0.12s ease, border-color 0.12s ease;
}

.codex-activity:hover {
  background: var(--surface);
  border-color: var(--border);
}

.codex-activity[open] {
  background: var(--surface);
  border-color: var(--border);
}

.codex-activity.failed {
  border-color: color-mix(in srgb, var(--danger) 30%, var(--border));
}

.codex-activity summary {
  display: flex;
  align-items: center;
  gap: 7px;
  min-height: 28px;
  padding: 4px 8px;
  border-radius: 7px;
  cursor: pointer;
  list-style: none;
}

.codex-activity summary::-webkit-details-marker {
  display: none;
}

.activity-glyph {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 18px;
  height: 18px;
  border-radius: 5px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  color: var(--text-muted);
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 10px;
  font-weight: 700;
}

.tool-activity.write .activity-glyph {
  color: var(--accent-strong);
  border-color: color-mix(in srgb, var(--accent) 30%, transparent);
  background: color-mix(in srgb, var(--accent) 8%, transparent);
}

.tool-activity.command .activity-glyph {
  color: #047857;
  border-color: rgba(16, 185, 129, 0.25);
  background: rgba(16, 185, 129, 0.07);
}

.tool-activity.agent .activity-glyph,
.tool-activity.computer .activity-glyph {
  color: var(--accent-strong);
  border-color: color-mix(in srgb, var(--accent) 25%, transparent);
  background: color-mix(in srgb, var(--accent) 7%, transparent);
}

.activity-title {
  flex: none;
  color: var(--text);
  font-size: 11.5px;
  font-weight: 550;
}

.activity-preview {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: var(--text-subtle);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.activity-status {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: none;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--bg-elevated);
  color: var(--text-subtle);
  font-size: 9.5px;
}

.activity-status.running {
  color: var(--accent-strong);
  background: rgba(245, 158, 11, 0.1);
}

.activity-status.failed {
  color: var(--danger);
  background: var(--danger-soft);
}

.activity-status.done {
  color: var(--text-subtle);
}

.activity-spinner {
  width: 7px;
  height: 7px;
  border: 1px solid currentColor;
  border-top-color: transparent;
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

.codex-activity .chevron-icon {
  flex: none;
  color: var(--text-subtle);
}

.activity-detail {
  padding: 2px 10px 10px 33px;
  border-top: 1px solid var(--border);
}

.activity-detail-label {
  margin: 9px 0 4px;
  color: var(--text-subtle);
  font-size: 10.5px;
  font-weight: 550;
}

.activity-pre {
  margin: 0;
  padding: 8px 10px;
  max-height: 260px;
  overflow: auto;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: var(--bg-elevated);
  color: var(--text-muted);
  font-size: 11px;
  line-height: 1.55;
  white-space: pre-wrap;
  word-break: break-word;
}

.activity-image {
  display: block;
  max-width: 100%;
  max-height: 360px;
  margin: 8px 0;
  border: 1px solid var(--border);
  border-radius: 7px;
  object-fit: contain;
}

.assistant-actions {
  padding-top: 4px;
  border-top: 1px solid var(--border);
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
  color: var(--accent-strong);
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
