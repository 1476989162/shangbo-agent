<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useChatStore } from '../../stores/chat'
import { currentLanguage, t } from '../../i18n'

defineProps<{
  theme: 'light' | 'dark' | 'system'
}>()

const emit = defineEmits<{
  'update:theme': [value: 'light' | 'dark' | 'system']
  feedback: [value: { ok: boolean; message: string }]
}>()

const store = useChatStore()

let unmounted = false

// ========================================================
// 偏好设置表单
// （自 SettingsDialog.vue 迁出，逻辑与模板逐字搬运）
// ========================================================
const customInstructions = ref('')
const notifyOnCompletion = ref(true)
const readOnlyReview = ref(false)
const autonomyLevel = ref<'strict' | 'balanced' | 'trusted'>('balanced')
const autoApproveSoft = ref(false)
const actionClassifierLlm = ref(false)
const injectionLlm = ref(false)

async function toggleActionClassifierLlm(value: boolean): Promise<void> {
  actionClassifierLlm.value = value
  await store.setActionClassifierLlm(value)
  emit('feedback', {
    ok: true,
    message: value ? '已开启后台动作复核；高风险动作会多一次模型复核。' : '已关闭后台动作复核。'
  })
}

async function toggleInjectionLlm(value: boolean): Promise<void> {
  injectionLlm.value = value
  await store.setInjectionLlm(value)
  emit('feedback', {
    ok: true,
    message: value ? '已开启注入二次确认；可疑外部内容会多一次模型确认。' : '已关闭注入二次确认，只走规则扫描。'
  })
}

async function toggleAutoApproveSoft(value: boolean): Promise<void> {
  autoApproveSoft.value = value
  await store.setAutoApproveSoft(value)
  emit('feedback', {
    ok: true,
    message: value
      ? '已开启自动同意常规审批；删 .git、删库、格式化磁盘等硬红线仍会弹窗。'
      : '已关闭自动同意常规审批，所有审批都会先问你。'
  })
}

async function setAutonomyLevel(level: 'strict' | 'balanced' | 'trusted'): Promise<void> {
  autonomyLevel.value = level
  // 走 store 写入：输入区徽标与设置页必须同时变化，避免两处显示不一致。
  await store.setAutonomy(level)
  emit('feedback', {
    ok: true,
    message:
      level === 'strict'
        ? '已切换为严格确认：所有写入与命令都会先问你。'
        : level === 'trusted'
          ? '已切换为完全信任：常规软风险操作自动放行，硬红线仍必须人工确认。'
          : '已切换为智能自治：工作区内安全操作自动放行，硬红线仍必须人工确认。'
  })
}

// 目标驱动与子任务模型
const unlimitedSteps = ref(false)
const subagentTarget = ref('')

/** 子任务模型下拉：跟随主模型 + 已启用供应商的可见模型。 */
const subagentModelOptions = computed(() =>
  store.usableProviders.flatMap((provider) =>
    provider.models
      .filter((model) => !store.isModelHidden(provider.id, model))
      .map((model) => ({
        value: `${provider.id}::${model}`,
        label: `${model}（${provider.name}）`
      }))
  )
)

async function toggleUnlimitedSteps(): Promise<void> {
  await window.shangbo.settings.set('agent.unlimitedSteps', unlimitedSteps.value)
  emit('feedback', {
    ok: true,
    message: unlimitedSteps.value
      ? '已开启目标驱动：不再按步数熔断，兜底只剩打转保险丝与手动停止。'
      : '已关闭目标驱动：恢复按步数熔断。'
  })
}

async function saveSubagentTarget(): Promise<void> {
  await window.shangbo.settings.set('agent.subagent.target', subagentTarget.value)
  emit('feedback', {
    ok: true,
    message: subagentTarget.value ? `子任务模型已设为 ${subagentTarget.value}` : '子任务模型已恢复跟随主模型'
  })
}

async function saveInstructions(): Promise<void> {
  await window.shangbo.settings.set('agent.instructions', customInstructions.value)
  emit('feedback', { ok: true, message: '已保存通用指导规范' })
}

async function onLanguageChange(): Promise<void> {
  await window.shangbo.settings.set('ui.language', currentLanguage.value)
  emit('feedback', { ok: true, message: t('settings.languageDesc') })
}

async function toggleNotify(val: boolean): Promise<void> {
  notifyOnCompletion.value = val
  await window.shangbo.settings.set('agent.notifyCompletion', val)
}

async function toggleReadOnly(val: boolean): Promise<void> {
  readOnlyReview.value = val
  await window.shangbo.settings.set('agent.readOnly', val)
}

onMounted(async () => {
  try {
    const settings = await window.shangbo.settings.getAll()
    if (unmounted) return
    customInstructions.value = (settings['agent.instructions'] as string) ?? ''
    notifyOnCompletion.value = (settings['agent.notifyCompletion'] as boolean) ?? true
    readOnlyReview.value = (settings['agent.readOnly'] as boolean) ?? false
    autonomyLevel.value =
      (settings['agent.autonomy'] as 'strict' | 'balanced' | 'trusted') ?? 'balanced'
    autoApproveSoft.value = (settings['agent.autoApproveSoft'] as boolean) ?? false
    actionClassifierLlm.value = (settings['agent.safety.actionClassifierLlm'] as boolean) ?? false
    injectionLlm.value = (settings['agent.safety.injectionLlm'] as boolean) ?? false
    unlimitedSteps.value = (settings['agent.unlimitedSteps'] as boolean) ?? false
    subagentTarget.value = (settings['agent.subagent.target'] as string) ?? ''
  } catch {
    // 读不到就用默认值
  }
})

onBeforeUnmount(() => {
  unmounted = true
})
</script>

<template>
  <section class="content-pane">
    <!-- 个人资料 Profile -->
    <div class="section-block">
      <h3 class="pane-title">个人资料 (Profile)</h3>

      <div class="setting-row profile-row">
        <span class="setting-label">头像</span>
        <div class="avatar-badge" title="系统当前用户头像">
          <span class="avatar-text">{{ store.userName.slice(0, 1).toUpperCase() }}</span>
          <span class="avatar-help">?</span>
        </div>
      </div>

      <div class="setting-field">
        <div class="field-head">
          <span class="setting-label">给助手的通用系统指令 (Instructions for Agent)</span>
          <span class="field-subtle">尚搏 Agent 会在所有会话与协同工作中遵循这些背景信息与指导规范。</span>
        </div>
        <textarea
          v-model="customInstructions"
          class="textarea-control"
          rows="4"
          placeholder="例如：回答尽量简明扼要，先给结论；编写代码时附带测试用例；默认采用当前项目绑定的技术栈规范…"
          @blur="saveInstructions"
        />
      </div>
    </div>

    <div class="divider" />

    <!-- 外观显示 Appearance -->
    <div class="section-block">
      <h3 class="pane-title">外观显示 (Appearance)</h3>

      <div class="setting-row">
        <span class="setting-label">主题配色</span>
        <div class="segmented-control">
          <button
            class="seg-btn"
            :class="{ active: theme === 'system' }"
            title="跟随系统"
            @click="emit('update:theme', 'system')"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <rect x="2" y="3" width="12" height="8" rx="1.5" stroke="currentColor" stroke-width="1.2" />
              <path d="M5 14h6M8 11v3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
            </svg>
          </button>
          <button
            class="seg-btn"
            :class="{ active: theme === 'light' }"
            title="浅色模式"
            @click="emit('update:theme', 'light')"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <circle cx="8" cy="8" r="3.2" stroke="currentColor" stroke-width="1.2" />
              <path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M12.6 3.4l-1.1 1.1M4.5 11.5l-1.1 1.1" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
            </svg>
          </button>
          <button
            class="seg-btn"
            :class="{ active: theme === 'dark' }"
            title="深色模式"
            @click="emit('update:theme', 'dark')"
          >
            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
              <path d="M13.5 9.5a6 6 0 11-7-7 5 5 0 007 7z" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" />
            </svg>
          </button>
        </div>
      </div>

      <div class="setting-row">
        <div class="row-text">
          <span class="setting-label">{{ t('settings.language') }}</span>
          <span class="row-sub">{{ t('settings.languageDesc') }}</span>
        </div>
        <select v-model="currentLanguage" class="select-control" @change="onLanguageChange">
          <option value="zh-CN">简体中文 (Simplified Chinese)</option>
          <option value="zh-TW">繁體中文 (Traditional Chinese)</option>
          <option value="en-US">English (US)</option>
          <option value="ja-JP">日本語 (Japanese)</option>
        </select>
      </div>
    </div>

    <div class="divider" />

    <!-- 通知提醒 Notifications -->
    <div class="section-block">
      <h3 class="pane-title">通知提醒 (Notifications)</h3>

      <div class="setting-row">
        <div class="row-text">
          <span class="setting-label">回复完成通知 (Response completions)</span>
          <span class="row-sub">当助手完成长任务的生成后发送系统桌面通知，适合耗时较长的推理任务。</span>
        </div>
        <label class="switch-control">
          <input
            v-model="notifyOnCompletion"
            type="checkbox"
            @change="toggleNotify(notifyOnCompletion)"
          />
          <span class="switch-slider" />
        </label>
      </div>
    </div>

    <div class="divider" />

    <!-- Agent 执行与安全策略 -->
    <div class="section-block">
      <h3 class="pane-title">执行与安全策略 (Execution & Safety)</h3>

      <div class="setting-row">
        <div class="row-text">
          <span class="setting-label">目标驱动（不限步数）</span>
          <span class="row-sub">
            打开后不再按步数熔断，跑到模型自己收手为止。兜底只剩打转保险丝与手动停止，长任务烧 Token 会更多。
          </span>
        </div>
        <label class="switch-control">
          <input v-model="unlimitedSteps" type="checkbox" @change="toggleUnlimitedSteps" />
          <span class="switch-slider" />
        </label>
      </div>

      <div class="setting-row">
        <div class="row-text">
          <span class="setting-label">子任务模型</span>
          <span class="row-sub">
            派生子任务用的模型，默认跟随主模型。选项来自已启用的供应商。
          </span>
        </div>
        <select v-model="subagentTarget" class="submodal-input" @change="saveSubagentTarget">
          <option value="">跟随主模型</option>
          <option
            v-for="option in subagentModelOptions"
            :key="option.value"
            :value="option.value"
          >
            {{ option.label }}
          </option>
        </select>
      </div>

      <div class="setting-row">
        <div class="row-text">
          <span class="setting-label">执行自治等级 (Autonomy)</span>
          <span class="row-sub">
            决定 Agent 执行时还要不要反复问你。智能自治只放行工作区内的读写与安全命令；硬红线永远不受影响。
          </span>
        </div>
        <div class="segmented-control">
          <button
            class="seg-btn text-seg"
            :class="{ active: autonomyLevel === 'strict' }"
            @click="setAutonomyLevel('strict')"
          >
            严格确认
          </button>
          <button
            class="seg-btn text-seg"
            :class="{ active: autonomyLevel === 'balanced' }"
            @click="setAutonomyLevel('balanced')"
          >
            智能自治
          </button>
          <button
            class="seg-btn text-seg"
            :class="{ active: autonomyLevel === 'trusted' }"
            @click="setAutonomyLevel('trusted')"
          >
            完全信任
          </button>
        </div>
      </div>

      <div class="setting-row">
        <div class="row-text">
          <span class="setting-label">自动同意常规审批 (Auto-approve routine approvals)</span>
          <span class="row-sub">
            开启后，工作区外写入、外部 MCP / CLI、键鼠操作等普通审批会自动同意；删 .git、删库、格式化磁盘等硬红线仍然必须你本人逐次确认。
          </span>
        </div>
        <label class="switch-control">
          <input
            v-model="autoApproveSoft"
            type="checkbox"
            @change="toggleAutoApproveSoft(autoApproveSoft)"
          />
          <span class="switch-slider" />
        </label>
      </div>

      <div class="setting-row">
        <div class="row-text">
          <span class="setting-label">后台动作复核 (LLM Action Review)</span>
          <span class="row-sub">
            开启后高风险动作会多一次模型复核，只收紧不放宽；失败默认要问，会产生额外请求。
          </span>
        </div>
        <label class="switch-control">
          <input
            v-model="actionClassifierLlm"
            type="checkbox"
            @change="toggleActionClassifierLlm(actionClassifierLlm)"
          />
          <span class="switch-slider" />
        </label>
      </div>

      <div class="setting-row">
        <div class="row-text">
          <span class="setting-label">注入二次确认 (Injection LLM Check)</span>
          <span class="row-sub">
            开启后可疑外部回包会多一次模型确认；高危规则命中直接告警，不花钱。
          </span>
        </div>
        <label class="switch-control">
          <input
            v-model="injectionLlm"
            type="checkbox"
            @change="toggleInjectionLlm(injectionLlm)"
          />
          <span class="switch-slider" />
        </label>
      </div>

      <div class="safety-redline">
        <strong>安全红线（任何等级都不能自动放行）</strong>
        <span>
          磁盘格式化 / 分区 / 擦盘：永久拒绝执行；删除 .git 仓库、删库 / 清表 / 无 WHERE 的
          DELETE、删除数据库文件、强制推送 / 硬重置：必须你本人逐次确认。许愿模式与「始终允许」都不能绕过。
        </span>
      </div>

      <div class="setting-row">
        <div class="row-text">
          <span class="setting-label">只读复查模式 (Read-Only Review)</span>
          <span class="row-sub">
            打开后模型只能读取与搜索文件，看不到写入与执行命令的工具，适合代码 review、全仓巡检。修代码前记得关掉。
          </span>
        </div>
        <label class="switch-control">
          <input
            v-model="readOnlyReview"
            type="checkbox"
            @change="toggleReadOnly(readOnlyReview)"
          />
          <span class="switch-slider" />
        </label>
      </div>
    </div>
  </section>
</template>

<style scoped>

.safety-redline {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  border-radius: var(--radius);
  border: 1px solid color-mix(in srgb, var(--danger) 32%, var(--border));
  background: var(--danger-soft);
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.6;
}

.safety-redline strong {
  color: var(--danger);
  font-size: 12px;
  font-weight: 600;
}

.profile-row {
  align-items: center;
}

.avatar-badge {
  position: relative;
  width: 44px;
  height: 44px;
  border-radius: var(--radius-full);
  background: var(--surface-hover);
  border: 1px solid var(--border-strong);
  display: flex;
  align-items: center;
  justify-content: center;
}

.avatar-text {
  font-size: 18px;
  font-weight: 600;
  color: var(--accent);
}

.avatar-help {
  position: absolute;
  bottom: -2px;
  right: -2px;
  width: 14px;
  height: 14px;
  border-radius: var(--radius-full);
  background: var(--border-strong);
  color: var(--text);
  font-size: 9px;
  display: flex;
  align-items: center;
  justify-content: center;
}

.setting-field {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.field-head {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.field-subtle {
  font-size: 12px;
  color: var(--text-muted);
}

.textarea-control {
  width: 100%;
  padding: 10px 12px;
  font-size: 13px;
  line-height: 1.5;
  border-radius: var(--radius-sm);
  background: var(--surface);
  border: 1px solid var(--border);
  outline: none;
  resize: vertical;
  color: var(--text);
}

.textarea-control:focus {
  border-color: var(--accent);
}

/* 分段选择器 */
.segmented-control {
  display: inline-flex;
  align-items: center;
  flex: none;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 2px;
  gap: 2px;
  white-space: nowrap;
}

.seg-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  flex: none;
  padding: 5px 8px;
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  white-space: nowrap;
  transition: all 0.12s ease;
}

.seg-btn:hover {
  color: var(--text);
}

.seg-btn.active {
  background: var(--bg-elevated);
  color: var(--accent-strong);
  box-shadow: var(--shadow-sm), inset 0 0 0 1px color-mix(in srgb, var(--accent-2) 24%, transparent);
}

.text-seg {
  font-size: 12px;
  padding: 4px 10px;
}
.submodal-input:focus {
  border-color: var(--primary);
  outline: none;
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

.content-pane {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.pane-title {
  margin: 0;
  font-size: 16px;
  font-weight: 600;
  color: var(--text);
}

.section-block {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.divider {
  height: 1px;
  background: var(--border);
  margin: 6px 0;
}

.setting-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.setting-label {
  font-size: 13px;
  font-weight: 500;
  color: var(--text);
}

.row-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.row-sub {
  font-size: 12px;
  color: var(--text-subtle);
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

.select-control {
  padding: 6px 12px;
  font-size: 12.5px;
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  color: var(--text);
  outline: none;
}
</style>
