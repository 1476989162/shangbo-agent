<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

const emit = defineEmits<{
  feedback: [value: { ok: boolean; message: string }]
}>()

let unmounted = false

// ========================================================
// 协同 Cowork 模式设置状态
// （自 SettingsDialog.vue 迁出，逻辑与模板逐字搬运）
// ========================================================
const coworkFilesPath = ref('')

const globalInstructions = ref('')
const showGlobalInstructionsModal = ref(false)
const editingGlobalInstructions = ref('')

const useMemory = ref(false)
interface MemoryRecord {
  id: string
  title: string
  desc: string
  date: string
}

const memoryItems = ref<MemoryRecord[]>([])

const showAddMemoryModal = ref(false)
const newMemoryForm = ref({ title: '', desc: '' })

async function pickCoworkFilesPath(): Promise<void> {
  const chosen = await window.shangbo.dialog.pickFolder()
  if (chosen) {
    coworkFilesPath.value = chosen
    await window.shangbo.settings.set('cowork.filesPath', chosen)
    emit('feedback', { ok: true, message: `已将协同生成文件路径更改为：${chosen}` })
  }
}

function openEditGlobalInstructions(): void {
  editingGlobalInstructions.value = globalInstructions.value
  showGlobalInstructionsModal.value = true
}

async function saveGlobalInstructions(): Promise<void> {
  globalInstructions.value = editingGlobalInstructions.value
  showGlobalInstructionsModal.value = false
  await window.shangbo.settings.set('cowork.globalInstructions', globalInstructions.value)
  emit('feedback', { ok: true, message: '全局协同指令已更新保存' })
}

async function toggleUseMemory(): Promise<void> {
  useMemory.value = !useMemory.value
  await window.shangbo.settings.set('cowork.useMemory', useMemory.value)
}

async function removeMemory(id: string): Promise<void> {
  memoryItems.value = memoryItems.value.filter((m) => m.id !== id)
  await window.shangbo.settings.set('cowork.memories', [...memoryItems.value])
  emit('feedback', { ok: true, message: '已移除该条长期记忆' })
}

async function addMemoryItem(): Promise<void> {
  const title = newMemoryForm.value.title.trim()
  const desc = newMemoryForm.value.desc.trim()
  if (!title || !desc) {
    emit('feedback', { ok: false, message: '请填写记忆标题和详情' })
    return
  }
  memoryItems.value.unshift({
    id: `mem-${Date.now()}`,
    title,
    desc,
    date: new Date().toISOString().slice(0, 10)
  })
  newMemoryForm.value = { title: '', desc: '' }
  showAddMemoryModal.value = false
  await window.shangbo.settings.set('cowork.memories', [...memoryItems.value])
  emit('feedback', { ok: true, message: '长期记忆条目已添加' })
}

onMounted(async () => {
  try {
    const settings = await window.shangbo.settings.getAll()
    if (unmounted) return
    if (typeof settings['cowork.filesPath'] === 'string') {
      coworkFilesPath.value = settings['cowork.filesPath'] as string
    }
    if (typeof settings['cowork.globalInstructions'] === 'string') {
      globalInstructions.value = settings['cowork.globalInstructions'] as string
    }
    if (typeof settings['cowork.useMemory'] === 'boolean') {
      useMemory.value = settings['cowork.useMemory'] as boolean
    }
    if (Array.isArray(settings['cowork.memories'])) {
      memoryItems.value = settings['cowork.memories'] as MemoryRecord[]
    }
  } catch {
    // 读不到就用默认值
  }
})

onBeforeUnmount(() => {
  unmounted = true
})
</script>

<template>
  <section class="content-pane cowork-pane">
    <div class="cowork-section-list">
      <!-- 1. Cowork files -->
      <div class="cowork-item-block">
        <div class="cowork-item-main">
          <h4 class="cowork-block-title">Cowork files (协同产物与任务存储)</h4>
          <p class="cowork-block-desc">
            您的产物和调度任务存储在
            <span class="cowork-path-badge" :title="coworkFilesPath">{{ coworkFilesPath }}</span>
          </p>
        </div>
        <div class="cowork-item-action">
          <button class="btn btn-outline tiny" @click="pickCoworkFilesPath">
            <svg width="13" height="13" viewBox="0 0 16 16" fill="none">
              <path d="M2 4.5A1.5 1.5 0 013.5 3h2.8a1.5 1.5 0 011.06.44l1.2 1.2h3.94A1.5 1.5 0 0114 6.14V12.5a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 12.5v-8z" stroke="currentColor" stroke-width="1.3" />
            </svg>
            <span>更改 (Change)</span>
          </button>
        </div>
      </div>

      <!-- 3. Global instructions -->
      <div class="cowork-item-block">
        <div class="cowork-item-main">
          <h4 class="cowork-block-title">Global instructions (全局协同指令)</h4>
          <p class="cowork-block-desc">
            此处的指令适用于所有协同会话。用于定义尚搏 Agent 始终需要了解的偏好、规范或上下文信息。
          </p>
          <div class="instructions-preview-box">
            <span class="preview-text text-truncate">{{ globalInstructions }}</span>
          </div>
        </div>
        <div class="cowork-item-action">
          <button class="btn btn-outline tiny" @click="openEditGlobalInstructions">
            <span>编辑 (Edit)</span>
          </button>
        </div>
      </div>

      <!-- 4. Memory 跨会话长期记忆 -->
      <div class="cowork-memory-block">
        <h3 class="memory-section-title">Memory (长期记忆库)</h3>

        <!-- 开关行 -->
        <div class="memory-toggle-row">
          <div class="toggle-text-col">
            <span class="memory-toggle-label">在会话中启用记忆 (Use memory in sessions)</span>
            <span class="memory-toggle-sub">尚搏 Agent 将在协同会话期间自动读取并更新这些跨会话记忆。</span>
          </div>
          <label class="switch-control">
            <input
              type="checkbox"
              :checked="useMemory"
              @change="toggleUseMemory"
            />
            <span class="switch-slider" />
          </label>
        </div>

        <p class="memory-device-note">
          尚搏 Agent 会自动保存它在协同会话中了解到的有关您和您工作的信息。这些记忆文件仅加密保存在本机设备上。
        </p>

        <!-- 记忆条目列表 -->
        <div class="memory-cards-container">
          <div
            v-for="item in memoryItems"
            :key="item.id"
            class="memory-card-row"
          >
            <div class="memory-card-left">
              <h5 class="mem-title">{{ item.title }}</h5>
              <p class="mem-desc">{{ item.desc }}</p>
              <span class="mem-date subtle">记录时间：{{ item.date }}</span>
            </div>
            <div class="memory-card-right">
              <button
                class="btn-delete-mem"
                title="删除此条记忆"
                @click="removeMemory(item.id)"
              >
                <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                  <path d="M3 4.5h10M6 4.5V3a1 1 0 011-1h2a1 1 0 011 1v1.5M12.5 4.5l-.8 9a1 1 0 01-1 .9H5.3a1 1 0 01-1-.9l-.8-9" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </button>
            </div>
          </div>

          <!-- 手动添加记忆按钮 -->
          <div class="memory-add-bar">
            <button class="btn-add-memory" @click="showAddMemoryModal = true">
              <span>+ 手动添加长期记忆条目</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  </section>

  <!-- 全局协同指令编辑弹窗 -->
  <div v-if="showGlobalInstructionsModal" class="submodal-overlay" @click.self="showGlobalInstructionsModal = false">
    <div class="submodal-card submodal-wide">
      <div class="submodal-head">
        <h4 class="submodal-title">编辑全局协同指令 (Global Instructions)</h4>
        <button class="btn-submodal-close" @click="showGlobalInstructionsModal = false">×</button>
      </div>
      <p class="submodal-tip">这些偏好和上下文将在所有协同会话中注入给 Agent，让其严格遵从。</p>
      <textarea
        v-model="editingGlobalInstructions"
        rows="6"
        class="submodal-textarea"
        placeholder="请输入您的全局协作要求（如：所有代码必须包含完整类型声明，优先使用中文应答等）..."
      />
      <div class="submodal-actions">
        <button class="btn btn-primary tiny" @click="saveGlobalInstructions">保存生效</button>
        <button class="btn btn-ghost tiny" @click="showGlobalInstructionsModal = false">取消</button>
      </div>
    </div>
  </div>

  <!-- 添加记忆条目弹窗 -->
  <div v-if="showAddMemoryModal" class="submodal-overlay" @click.self="showAddMemoryModal = false">
    <div class="submodal-card">
      <div class="submodal-head">
        <h4 class="submodal-title">添加跨会话长期记忆</h4>
        <button class="btn-submodal-close" @click="showAddMemoryModal = false">×</button>
      </div>
      <div class="submodal-form">
        <label class="submodal-field">
          <span class="field-label">记忆标题</span>
          <input v-model="newMemoryForm.title" class="submodal-input" placeholder="例如：数据库连接配置、前端框架规范等" />
        </label>
        <label class="submodal-field">
          <span class="field-label">记忆详细内容</span>
          <textarea v-model="newMemoryForm.desc" rows="4" class="submodal-textarea" placeholder="详细描述 Agent 需要长期记住的事实、配置路径或开发规则..." />
        </label>
      </div>
      <div class="submodal-actions">
        <button class="btn btn-primary tiny" @click="addMemoryItem">确认添加</button>
        <button class="btn btn-ghost tiny" @click="showAddMemoryModal = false">取消</button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.cowork-pane {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.cowork-section-list {
  display: flex;
  flex-direction: column;
  gap: 22px;
}

.cowork-item-block {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding-bottom: 20px;
  border-bottom: 1px solid var(--border);
}

.cowork-item-main {
  flex: 1;
  min-width: 0;
}

.cowork-block-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
  margin: 0 0 6px 0;
}

.cowork-block-desc {
  font-size: 12.5px;
  color: var(--text-muted);
  line-height: 1.5;
  margin: 0;
}

.cowork-path-badge {
  color: var(--primary);
  background: var(--surface);
  border: 1px solid var(--border);
  padding: 2px 6px;
  border-radius: 4px;
  font-family: monospace;
  font-size: 11.5px;
  margin-left: 4px;
  word-break: break-all;
}

.instructions-preview-box {
  margin-top: 8px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px 12px;
  font-size: 12px;
  color: var(--text-subtle);
  max-width: 580px;
}

.cowork-memory-block {
  padding-top: 4px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.memory-section-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
  margin: 0;
}

.memory-toggle-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.memory-toggle-label {
  font-size: 13.5px;
  font-weight: 500;
  color: var(--text);
}

.memory-toggle-sub {
  font-size: 12px;
  color: var(--text-muted);
  display: block;
  margin-top: 3px;
}

.memory-device-note {
  font-size: 12px;
  color: var(--text-subtle);
  margin: 0;
  line-height: 1.5;
}

.memory-cards-container {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-top: 4px;
}

.memory-card-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 14px;
  padding: 12px 14px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 8px;
  transition: border-color 0.15s ease;
}

.memory-card-row:hover {
  border-color: var(--border-strong);
}

.memory-card-left {
  flex: 1;
  min-width: 0;
}

.mem-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--text);
  margin: 0 0 4px 0;
}

.mem-desc {
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.45;
  margin: 0 0 6px 0;
}

.mem-date {
  font-size: 11px;
}

.btn-delete-mem {
  width: 26px;
  height: 26px;
  border-radius: 4px;
  background: none;
  border: none;
  color: var(--text-subtle);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.12s ease;
}

.btn-delete-mem:hover {
  color: var(--danger);
  background: var(--danger-soft, rgba(239, 68, 68, 0.1));
}

.memory-add-bar {
  display: flex;
  justify-content: flex-start;
  margin-top: 4px;
}

.btn-add-memory {
  background: none;
  border: 1px dashed var(--border-strong);
  border-radius: 6px;
  padding: 7px 14px;
  font-size: 12px;
  color: var(--primary);
  cursor: pointer;
  transition: all 0.12s ease;
}

.btn-add-memory:hover {
  background: var(--surface-hover);
  border-color: var(--primary);
}
.submodal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.5);
  backdrop-filter: blur(2px);
  z-index: 1100;
  display: flex;
  align-items: center;
  justify-content: center;
}

.submodal-card {
  width: 480px;
  max-width: 90vw;
  background: var(--bg-elevated, #ffffff);
  border: 1px solid var(--border-strong);
  border-radius: 10px;
  padding: 20px 22px;
  box-shadow: 0 16px 40px rgba(0, 0, 0, 0.25);
  animation: popupSlideUp 0.15s ease-out;
}

.submodal-wide {
  width: 580px;
}

.submodal-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.submodal-title {
  font-size: 14.5px;
  font-weight: 600;
  color: var(--text);
  margin: 0;
}

.btn-submodal-close {
  background: none;
  border: none;
  font-size: 20px;
  cursor: pointer;
  color: var(--text-muted);
  line-height: 1;
}

.btn-submodal-close:hover {
  color: var(--text);
}

.submodal-tip {
  font-size: 12px;
  color: var(--text-muted);
  margin: 0 0 14px 0;
  line-height: 1.45;
}

.submodal-textarea {
  width: 100%;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 8px 10px;
  font-size: 12.5px;
  color: var(--text);
  resize: vertical;
  font-family: inherit;
  margin-bottom: 16px;
  box-sizing: border-box;
}

.submodal-textarea:focus,
.submodal-input:focus {
  border-color: var(--primary);
  outline: none;
}

.submodal-form {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-bottom: 16px;
}

.submodal-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.submodal-input {
  width: 100%;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 7px 10px;
  font-size: 12.5px;
  color: var(--text);
  box-sizing: border-box;
}

.submodal-actions {
  display: flex;
  align-items: center;
  justify-content: flex-end;
  gap: 8px;
}

.content-pane {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

/* Switch 开关 */
.switch-control {
  position: relative;
  display: inline-block;
  width: 36px;
  height: 20px;
  cursor: pointer;
}

.switch-control input {
  opacity: 0;
  width: 0;
  height: 0;
}

.switch-control input:checked + .switch-slider {
  background: var(--accent);
}

.switch-control input:checked + .switch-slider:before {
  transform: translateX(16px);
}

/* 通用开关 Switch 样式 */
.switch-control {
  position: relative;
  display: inline-block;
  width: 36px;
  height: 20px;
  flex-shrink: 0;
  cursor: pointer;
}

.switch-control input:checked + .switch-slider {
  background: var(--success);
}

.switch-control input:checked + .switch-slider::before {
  transform: translateX(16px);
}

.switch-slider {
  position: absolute;
  inset: 0;
  background: var(--border-strong);
  border-radius: 20px;
  transition: 0.2s;
}

.switch-slider:before {
  position: absolute;
  content: '';
  height: 14px;
  width: 14px;
  left: 3px;
  bottom: 3px;
  background: white;
  border-radius: 50%;
  transition: 0.2s;
}

.switch-slider {
  position: absolute;
  inset: 0;
  background: var(--border-strong);
  border-radius: 20px;
  transition: all 0.2s ease;
}

.switch-slider::before {
  position: absolute;
  content: '';
  height: 14px;
  width: 14px;
  left: 3px;
  bottom: 3px;
  background: #ffffff;
  border-radius: 50%;
  transition: all 0.2s ease;
}
</style>
