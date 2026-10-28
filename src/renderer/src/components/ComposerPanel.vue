<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ContextStatics, ImageAttachment } from '@shared/types'
import { useChatStore } from '../stores/chat'
import logoImg from '../assets/logo.png'
import {
  formatTokensK,
  IMAGE_MIME_RE,
  MAX_IMAGE_BYTES,
  MAX_IMAGE_COUNT,
  resolveModelContextLimit
} from './composerPresentation'

/**
 * 待发送图片在渲染层的形态。
 * 预览用 objectURL，发给主进程用原始字节——两者都不经过 base64 字符串，
 * 避免大图在页面里被复制成 1.33 倍的字符串。
 */
interface PendingImage {
  id: string
  mimeType: string
  data: Uint8Array
  /** 仅用于 <img> 预览的临时 URL，移除时必须 revoke */
  previewUrl: string
}

const emit = defineEmits<{ openSettings: [tab?: string] }>()
const store = useChatStore()

const draft = ref('')
const pendingImages = ref<PendingImage[]>([])
const imageHint = ref<string | null>(null)
const previewImage = ref<string | null>(null)
let imageHintTimer: ReturnType<typeof setTimeout> | null = null
const textareaEl = ref<HTMLTextAreaElement | null>(null)

/** 编辑重发模式：记录被编辑用户消息的父节点，发送时以此为锚点生成新分支。 */
const editing = ref<{ parentId: string | null } | null>(null)
const modelMenuOpen = ref(false)
const effortMenuOpen = ref(false)
const contextWindowOpen = ref(false)
const mcpExpanded = ref(false)
const memoryExpanded = ref(false)
const modelSearchQuery = ref('')
const isManagingModelVisibility = ref(false)

const userContextBudget = ref<number | null>(null)
const contextStatics = ref<ContextStatics>({
  mcp: 0,
  systemTools: 0,
  skills: 0,
  systemPrompt: 0,
  memory: 0
})

function autoGrow(): void {
  const element = textareaEl.value
  if (!element) return
  element.style.height = 'auto'
  element.style.height = `${Math.min(element.scrollHeight, 220)}px`
}

function showImageHint(text: string): void {
  imageHint.value = text
  if (imageHintTimer) clearTimeout(imageHintTimer)
  imageHintTimer = setTimeout(() => (imageHint.value = null), 4000)
}

function readAsBytes(file: File): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      // FileReader 读 Blob 走的是 ArrayBuffer 分支，不会触发字符串的按码点截断
      const result = reader.result
      if (!(result instanceof ArrayBuffer)) {
        reject(new Error('读取图片失败'))
        return
      }
      resolve(new Uint8Array(result))
    }
    reader.onerror = () => reject(reader.error ?? new Error('读取图片失败'))
    reader.readAsArrayBuffer(file)
  })
}

/** 把一张图片文件收进待发列表：字节用于发送，objectURL 仅用于预览。 */
async function collectImage(file: File): Promise<boolean> {
  if (file.size > MAX_IMAGE_BYTES) {
    showImageHint(`「${file.type || '图片'}」超过 ${MAX_IMAGE_BYTES / 1024 / 1024}MB，已跳过`)
    return false
  }
  try {
    const data = await readAsBytes(file)
    // 用 Blob 而不是直接用字节造 URL：浏览器需要正确的 MIME 才会渲染。
    // 显式标注 ArrayBuffer 视图，绕开 Uint8Array<ArrayBufferLike> 与
    // BlobPart 之间的 SharedArrayBuffer 联合类型不兼容。
    const previewUrl = URL.createObjectURL(
      new Blob([new Uint8Array(data)], { type: file.type })
    )
    pendingImages.value.push({
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      mimeType: file.type.toLowerCase(),
      data,
      previewUrl
    })
    return true
  } catch {
    showImageHint('读取图片失败，请重新粘贴')
    return false
  }
}

/**
 * 从剪贴板事件里收集图片（截图、复制的图片文件、网页图片地址）。
 * 纯文本粘贴交还给 textarea 自身处理，此处不拦截。
 */
async function onPaste(event: ClipboardEvent): Promise<void> {
  const items = event.clipboardData?.items
  if (!items) return

  const files: File[] = []
  for (const item of Array.from(items)) {
    if (item.kind !== 'file') continue
    const file = item.getAsFile()
    if (file && IMAGE_MIME_RE.test(file.type)) files.push(file)
  }

  // 没有图片就不接管这次粘贴，让浏览器照常插入文字
  if (files.length === 0) return
  event.preventDefault()

  const room = MAX_IMAGE_COUNT - pendingImages.value.length
  if (room <= 0) {
    showImageHint(`一次最多发送 ${MAX_IMAGE_COUNT} 张图片`)
    return
  }
  if (files.length > room) {
    showImageHint(`一次最多发送 ${MAX_IMAGE_COUNT} 张图片，多余的已忽略`)
  }

  for (const file of files.slice(0, room)) {
    await collectImage(file)
  }
  await nextTick()
  autoGrow()
}

/** 也支持直接拖拽图片文件到输入框。 */
async function onDrop(event: DragEvent): Promise<void> {
  const files = Array.from(event.dataTransfer?.files ?? [])
  const images = files.filter((file) => IMAGE_MIME_RE.test(file.type))
  if (images.length === 0) return
  event.preventDefault()

  const room = MAX_IMAGE_COUNT - pendingImages.value.length
  if (room <= 0) {
    showImageHint(`一次最多发送 ${MAX_IMAGE_COUNT} 张图片`)
    return
  }
  for (const file of images.slice(0, room)) {
    await collectImage(file)
  }
  await nextTick()
  autoGrow()
}

function removeImage(id: string): void {
  const index = pendingImages.value.findIndex((item) => item.id === id)
  if (index < 0) return
  // 预览用的 objectURL 必须显式回收，否则 blob 会一直占着内存
  URL.revokeObjectURL(pendingImages.value[index].previewUrl)
  pendingImages.value.splice(index, 1)
}

function clearPendingImages(): void {
  for (const item of pendingImages.value) URL.revokeObjectURL(item.previewUrl)
  pendingImages.value = []
}

async function submit(): Promise<void> {
  const text = draft.value.trim()
  const images: ImageAttachment[] = pendingImages.value.map((item) => ({
    mimeType: item.mimeType,
    data: item.data
  }))
  // 不再因为「正在生成」而拒绝提交：主进程会把它排进队列，接在当前回合之后
  if (!text && images.length === 0) return
  const anchor = editing.value?.parentId
  draft.value = ''
  clearPendingImages()
  editing.value = null
  await nextTick()
  autoGrow()
  await store.send(text, anchor, images)
}

/** 父组件编辑历史消息时，把内容放进输入框并进入分支编辑态。 */
function editMessage(payload: { content: string; parentId: string | null }): void {
  draft.value = payload.content
  editing.value = { parentId: payload.parentId }
  void nextTick(() => {
    autoGrow()
    textareaEl.value?.focus()
  })
}

/** 快捷建议只负责填充草稿，不直接发送。 */
function setDraft(text: string): void {
  draft.value = text
}

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') {
    if (editing.value) {
      event.preventDefault()
      editing.value = null
      return
    }
    // 没有草稿可撤时，Esc 用来清空待发图片
    if (!draft.value && pendingImages.value.length > 0) {
      event.preventDefault()
      clearPendingImages()
      showImageHint('已清空待发图片')
      return
    }
    if (previewImage.value) {
      event.preventDefault()
      previewImage.value = null
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

watch(
  () => store.activeConversationId,
  async () => {
    // 换会话就清掉待发图片，否则上一条会话的截图会被误发到新会话
    clearPendingImages()
    await nextTick()
    textareaEl.value?.focus()
  }
)

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

async function setContextBudget(tokens: number | null): Promise<void> {
  userContextBudget.value = tokens
  const target = tokens ?? 32_000
  await window.shangbo.settings.set('agent.contextBudgetTokens', target)
}

const autoModelContextLimit = computed(() => resolveModelContextLimit(store.selectedModel))

const maxContextLimit = computed(() => {
  if (userContextBudget.value && userContextBudget.value >= 64_000) {
    return userContextBudget.value
  }
  return autoModelContextLimit.value
})

const contextWindowBadge = computed(() => {
  const limit = maxContextLimit.value
  if (limit >= 1_000_000) return '1M'
  if (limit >= 200_000) return '200K'
  if (limit >= 128_000) return '128K'
  return `${Math.round(limit / 1000)}K`
})

const sessionMessagesTokens = computed(() => {
  let count = 0
  for (const msg of store.activePath) {
    if (msg.usage) {
      count += (msg.usage.promptTokens || 0) + (msg.usage.completionTokens || 0)
    } else {
      const len = msg.blocks.reduce((acc, b) => acc + (b.type === 'text' ? b.text.length : 0), 0)
      count += Math.ceil(len / 2)
    }
  }
  return count
})

async function loadContextStatics(): Promise<void> {
  try {
    contextStatics.value = await window.shangbo.app.contextStatics()
  } catch {
    // 取不到就保持 0：宁可少算，也不要显示一个编造的数字
  }
}

const contextBreakdown = computed(() => {
  const max = maxContextLimit.value
  const mcp = contextStatics.value.mcp
  const systemTools = contextStatics.value.systemTools
  const skills = contextStatics.value.skills
  const systemPrompt = contextStatics.value.systemPrompt
  const memory = contextStatics.value.memory
  const messages = sessionMessagesTokens.value

  const used = mcp + systemTools + skills + systemPrompt + memory + messages
  const free = Math.max(0, max - used)
  const overBy = Math.max(0, used - max)
  const isOver = used > max

  // 超出时按比例缩放，让各分项加起来仍然是 100%，视觉上自洽
  const scale = isOver ? max / used : 1
  const pctOf = (value: number): string => (((value * scale) / max) * 100).toFixed(1)

  return {
    max,
    used,
    free,
    overBy,
    isOver,
    pct: Math.min(100, Number(((used / max) * 100).toFixed(1))),
    mcp,
    systemTools,
    skills,
    systemPrompt,
    memory,
    messages,
    mcpPct: pctOf(mcp),
    systemToolsPct: pctOf(systemTools),
    skillsPct: pctOf(skills),
    systemPromptPct: pctOf(systemPrompt),
    memoryPct: pctOf(memory),
    messagesPct: pctOf(messages),
    freePct: '0.0'
  }
})

function openUsageSettings(): void {
  contextWindowOpen.value = false
  emit('openSettings', 'preferences')
}

function selectProviderAndModel(providerId: string, model: string): void {
  void store.setTarget(providerId, model)
  modelMenuOpen.value = false
}

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

const modeTitle = computed(() => {
  if (store.agentMode === 'auto') {
    return '【智能模式】按你的自然语言自动判断该问答、动手还是自动交付；不确定处按默认值继续。点击切换模式'
  }
  if (store.agentMode === 'wish') {
    return '【许愿模式】只描述目标与验收，Agent 在工作区内自动改、跑、修、验。点击切换到问答模式'
  }
  if (store.agentMode === 'builder') {
    return '【建造者模式】常规工程构建，工作区内按自治等级放行。点击切换到许愿模式'
  }
  return '【问答模式】只讨论方案，不主动落盘。点击切换到智能模式'
})

const autonomyLabel = computed(() => {
  if (store.autonomy === 'strict') return '严格确认'
  if (store.autonomy === 'trusted') return '完全信任'
  return '智能自治'
})

const autonomyTitle = computed(() => {
  if (store.autonomy === 'strict') {
    return '严格确认：所有写入与命令都弹窗。硬红线（删 .git / 删库 / 格式化磁盘）始终人工确认。点击切换'
  }
  if (store.autonomy === 'trusted') {
    return '完全信任：常规软风险操作自动放行；硬红线仍然必须人工确认。点击切换'
  }
  return '智能自治：工作区内读写与安全命令自动放行，工作区外与外部进程仍需确认；硬红线始终人工确认。点击切换'
})

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

onMounted(() => {
  void loadContextBudgetSetting()
  void loadContextStatics()
})

onBeforeUnmount(() => {
  if (imageHintTimer) clearTimeout(imageHintTimer)
  clearPendingImages()
})

defineExpose({ editMessage, setDraft })
</script>

<template>
  <!-- 编辑提示 -->
  <div v-if="editing" class="editing-hint">
    <span>正在编辑消息：发送后将衍生新的回复分支</span>
    <button class="btn btn-ghost tiny" @click="editing = null">取消（Esc）</button>
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

              <!-- 工作模式：智能 / 建造者 / 许愿 / 问答 -->
              <button
                class="context-tag mode-tag"
                :class="`mode-${store.agentMode}`"
                :title="modeTitle"
                @click="store.cycleAgentMode()"
              >
                <span class="mode-icon">{{
                  store.agentMode === 'auto'
                    ? '◉'
                    : store.agentMode === 'builder'
                      ? '◆'
                      : store.agentMode === 'wish'
                        ? '✦'
                        : '○'
                }}</span>
                <span class="mode-name">{{
                  store.agentMode === 'auto'
                    ? '智能模式'
                    : store.agentMode === 'builder'
                      ? '建造者'
                      : store.agentMode === 'wish'
                        ? '许愿模式'
                        : '问答模式'
                }}</span>
              </button>
            </div>

            <!-- 尚搏企业官方 Logo 徽标 -->
            <div class="mascot-wrapper" title="尚搏智能助手就绪">
              <img :src="logoImg" class="mascot-brand-img" alt="尚搏 Logo" />
            </div>
          </div>

          <!-- 输入卡片主体 -->
          <div class="composer-card">
            <!-- 生成中的排队提示：告诉用户可以继续录入，提交后会排在当前回合之后 -->
            <p v-if="store.isStreaming" class="queue-hint">
              <span class="queue-dot" aria-hidden="true" />
              <span v-if="store.queuedCountOf(store.activeConversationId ?? '') > 0">
                还有 {{ store.queuedCountOf(store.activeConversationId ?? '') }} 条排队中，将依次自动发送
              </span>
              <span v-else>正在生成中，可继续录入下一条，发送后将自动排队</span>
            </p>

            <!-- 图片粘贴失败的临时提示（超大图 / 超出张数上限等） -->
            <p v-if="imageHint" class="image-hint">{{ imageHint }}</p>

            <!-- 待发图片缩略图条：粘贴/拖入的截图先落在这里，可逐张删除 -->
            <div v-if="pendingImages.length > 0" class="pending-images">
              <div v-for="image in pendingImages" :key="image.id" class="pending-image">
                <button
                  class="pending-image-open"
                  title="点击查看大图"
                  @click="previewImage = image.previewUrl"
                >
                  <img :src="image.previewUrl" alt="待发送图片" />
                </button>
                <button
                  class="pending-image-remove"
                  title="移除这张图片"
                  @click="removeImage(image.id)"
                >
                  ×
                </button>
              </div>
            </div>

            <textarea
              ref="textareaEl"
              v-model="draft"
              class="composer-textarea"
              rows="1"
              :placeholder="
                store.agentMode === 'wish'
                  ? '许下愿望：说清目标与验收标准，Agent 会自己改、跑、修、验…'
                  : store.agentMode === 'auto'
                    ? '直接说你要什么，我会自己判断该聊、该查还是该动手…（Ctrl+V 可粘贴截图）'
                    : '输入任务或提出问题，按 / 可使用常用命令… 也可直接 Ctrl+V 粘贴截图'
              "
              @input="autoGrow"
              @keydown="onKeydown"
              @paste="onPaste"
              @drop="onDrop"
              @dragover.prevent
            />

            <!-- 输入卡片底栏：左侧权限模式 + 右侧模型药丸、思考强度与发送 -->
            <div class="composer-toolbar">
              <!-- 左侧：安全自治等级 -->
              <div class="perm-control">
                <button
                  class="perm-btn"
                  :class="`autonomy-${store.autonomy}`"
                  :title="autonomyTitle"
                  @click="store.cycleAutonomy()"
                >
                  <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                    <path
                      d="M8 1.8l5 2v4.1c0 3-2 5.3-5 6.3-3-1-5-3.3-5-6.3V3.8l5-2z"
                      stroke="currentColor"
                      stroke-width="1.2"
                      stroke-linejoin="round"
                    />
                    <path d="M5.8 8l1.5 1.5L10.4 6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" />
                  </svg>
                  <span class="perm-label">{{ autonomyLabel }}</span>
                </button>

                <!-- 自动同意常规审批：硬红线不受影响 -->
                <button
                  class="perm-btn auto-approve-btn"
                  :class="{ active: store.autoApproveSoft }"
                  :title="
                    store.autoApproveSoft
                      ? '已开启自动同意常规审批（删 .git、删库、格式化磁盘等硬红线仍会弹窗）。点击关闭'
                      : '自动同意常规审批：普通审批不再打断你；硬红线仍必须你本人确认。点击开启'
                  "
                  @click="store.toggleAutoApproveSoft()"
                >
                  <span class="auto-approve-dot" />
                  <span class="perm-label">自动同意</span>
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
        <span v-if="contextBreakdown.isOver" class="cw-over">超出 {{ formatTokensK(contextBreakdown.overBy) }}</span>
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

                <!-- 生成中：保留停止按钮，同时给出「排队发送」，让用户能继续录入 -->
                <div v-if="store.isStreaming" class="dual-actions">
                  <button
                    class="submit-action stop-btn"
                    title="停止生成"
                    @click="store.stop()"
                  >
                    <span class="stop-icon" />
                  </button>
                  <button
                    class="submit-action enqueue-btn"
                    :disabled="!draft.trim() && pendingImages.length === 0"
                    title="加入队列，当前回复完成后自动发送 (Enter)"
                    @click="submit"
                  >
                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                      <path d="M8 2.5v8M5.2 7.6L8 10.4l2.8-2.8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" />
                      <path d="M3 12.8h10" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
                    </svg>
                  </button>
                </div>
                <button
                  v-else
                  class="submit-action send-btn"
                  :disabled="!draft.trim() && pendingImages.length === 0"
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
  <!-- 图片放大遮罩：Esc 或点击空白关闭 -->
  <div
    v-if="previewImage"
    class="preview-mask"
    tabindex="0"
    @click="previewImage = null"
  >
    <img :src="previewImage" class="preview-img" alt="图片预览" />
  </div>
</template>
<style scoped>
.editing-hint {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 8px;
  padding: 6px 12px;
  border-radius: var(--radius);
  font-size: 12px;
  background: var(--surface);
  border: 1px dashed var(--border-strong);
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
  border-radius: var(--radius-lg);
  box-shadow: 0 6px 22px rgba(45, 36, 22, 0.07);
  padding: 13px 15px 11px;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}

.composer-card:focus-within {
  border-color: color-mix(in srgb, var(--gold-2) 68%, var(--border));
  box-shadow: var(--gold-glow), 0 8px 26px rgba(45, 36, 22, 0.08);
}

/* 生成中的排队提示 */
.queue-hint {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 6px;
  font-size: var(--text-xs);
  color: var(--text-muted);
}

.queue-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent);
  animation: queue-pulse 1.2s ease-in-out infinite;
  flex: none;
}

@keyframes queue-pulse {
  0%, 100% { opacity: 0.3; transform: scale(0.8); }
  50% { opacity: 1; transform: scale(1.1); }
}

/* 生成中：停止 + 排队发送 并排 */
.dual-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.enqueue-btn {
  background: var(--accent);
  color: #fff;
}

.enqueue-btn:hover:not(:disabled) {
  filter: brightness(1.08);
}

.enqueue-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}

/* 图片粘贴提示 */
.image-hint {
  margin: 0 0 6px;
  font-size: var(--text-xs);
  color: var(--danger);
}

/* 待发图片缩略图条 */
.pending-images {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 10px 0 2px;
}

.pending-image {
  position: relative;
  width: 76px;
  height: 76px;
  border-radius: var(--radius-sm);
  overflow: hidden;
  border: 1px solid var(--border);
  background: var(--bg-elevated);
}

/* 缩略图本体：整块可点开大图 */
.pending-image-open {
  display: block;
  width: 100%;
  height: 100%;
  padding: 0;
  border: none;
  background: transparent;
  cursor: zoom-in;
}

.pending-image-open img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

/* 图片放大遮罩 */
.preview-mask {
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

.preview-img {
  max-width: 100%;
  max-height: 100%;
  object-fit: contain;
  border-radius: var(--radius);
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.5);
}

.pending-image-remove {
  position: absolute;
  top: 2px;
  right: 2px;
  width: 18px;
  height: 18px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.62);
  color: #fff;
  font-size: 13px;
  line-height: 1;
}

.pending-image-remove:hover {
  background: var(--danger);
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
  gap: 5px;
  font-size: 12px;
  color: var(--text-muted);
  padding: 3px 8px;
  border: 1px solid transparent;
  border-radius: var(--radius-full);
  transition: all 0.12s ease;
}

.perm-btn:hover {
  background: var(--surface-hover);
  color: var(--text);
}

.perm-btn.autonomy-balanced {
  color: var(--accent);
  background: var(--accent-soft);
  border-color: color-mix(in srgb, var(--accent) 28%, transparent);
  font-weight: 500;
}

.perm-btn.autonomy-trusted {
  color: var(--text);
  background: var(--surface-hover);
  border-color: var(--border-strong);
  font-weight: 500;
}

.auto-approve-btn.active {
  color: var(--accent-strong);
  background: var(--accent-soft);
  border-color: color-mix(in srgb, var(--accent) 32%, transparent);
  font-weight: 500;
}

.auto-approve-dot {
  width: 5px;
  height: 5px;
  border-radius: 50%;
  background: var(--text-subtle);
  transition: background 0.15s ease, box-shadow 0.15s ease;
}

.auto-approve-btn.active .auto-approve-dot {
  background: var(--accent);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--accent) 16%, transparent);
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
  background: var(--primary);
  color: #ffffff;
  border-color: var(--primary);
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
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 15%, transparent);
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
  background: color-mix(in srgb, var(--accent) 8%, transparent);
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
  background: color-mix(in srgb, var(--accent) 6%, transparent);
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
  background: var(--gold-gradient);
  color: var(--accent-contrast);
  box-shadow: 0 1px 2px rgba(90, 64, 16, 0.2), inset 0 1px 0 rgba(255, 255, 255, 0.3);
}

.send-btn:hover:not(:disabled) {
  filter: brightness(1.05);
  box-shadow: 0 4px 14px rgba(138, 101, 32, 0.28);
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
/* TRAE 工作流模式切换按钮 */
.mode-tag {
  user-select: none;
  cursor: pointer;
  transition: all 0.15s ease;
}

.mode-tag.mode-auto {
  background: var(--accent-soft);
  border-color: color-mix(in srgb, var(--accent) 34%, transparent);
  color: var(--accent-strong, var(--accent));
  font-weight: 600;
}

.mode-tag.mode-builder {
  background: var(--surface-hover);
  border-color: var(--border-strong);
  color: var(--text);
  font-weight: 600;
}

.mode-tag.mode-chat {
  background: transparent;
  border-color: var(--border);
  color: var(--text-muted);
  font-weight: 500;
}

.mode-tag.mode-wish {
  background: linear-gradient(135deg, var(--accent-soft), color-mix(in srgb, var(--accent) 18%, transparent));
  border-color: var(--accent);
  color: var(--accent-strong, var(--accent));
  font-weight: 700;
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 12%, transparent);
}
.mascot-brand-img {
  width: 22px;
  height: 22px;
  object-fit: contain;
  border-radius: var(--radius-full);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--gold-2) 30%, transparent);
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
  background: var(--accent);
  color: var(--accent-contrast);
  border-color: var(--accent);
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

.cw-over {
  margin-left: 8px;
  font-size: var(--text-xs);
  color: var(--danger);
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
  background-color: #8a6520;
}
.seg-system-tools {
  background-color: #b58133;
}
.seg-skills {
  background-color: #2e7a5c;
}
.seg-prompt {
  background-color: #c9a227;
}
.seg-memory {
  background-color: #7a5c3e;
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
  color: var(--primary);
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
