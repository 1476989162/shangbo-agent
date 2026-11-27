<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

const emit = defineEmits<{
  feedback: [value: { ok: boolean; message: string }]
}>()

/* ------------------------------------------------------------------ */
/* 电脑控制：总开关 + 安全说明 + 双通道真实自检                         */
/* （自 SettingsDialog.vue 迁出；急停文案按注册态诚实展示，无 Esc 误导） */
/* ------------------------------------------------------------------ */

interface ComputerProbeResult {
  agentDesktop: { available: boolean; binary: string | null; reason?: string }
  nutJs: { available: boolean; error?: string }
  emergencyStop: { accelerator: string; displayLabel: string; registered: boolean }
}

let unmounted = false

const computerUseEnabled = ref(true)
const computerProbing = ref(false)
const computerProbeResult = ref<ComputerProbeResult | null>(null)
const computerProbeError = ref('')

/** 急停说明：已注册显示热键；未注册诚实提示用底栏停止按钮。 */
const emergencyStopTip = computed(() => {
  const state = computerProbeResult.value?.emergencyStop
  if (!state) return '自检后显示全局急停热键的真实注册状态。'
  if (state.registered) return `全局急停快捷键 ${state.displayLabel} 已注册（切到其他窗口同样生效）`
  return '全局快捷键未注册，请切回窗口点击底栏「停止」按钮'
})

async function loadComputerUse(): Promise<void> {
  try {
    const settings = await window.shangbo.settings.getAll()
    if (unmounted) return
    computerUseEnabled.value = (settings['agent.computerUse'] as boolean) ?? true
  } catch {
    /* 读不到就用默认值 */
  }
}

async function toggleComputerUse(): Promise<void> {
  const next = !computerUseEnabled.value
  try {
    await window.shangbo.settings.set('agent.computerUse', next)
    if (unmounted) return
    computerUseEnabled.value = next
    emit('feedback', {
      ok: true,
      message: next ? '已启用「电脑控制」能力' : '已停用「电脑控制」'
    })
  } catch (err: unknown) {
    if (unmounted) return
    emit('feedback', {
      ok: false,
      message: `切换失败：${err instanceof Error ? err.message : String(err)}`
    })
  }
}

async function probeComputer(): Promise<void> {
  computerProbing.value = true
  computerProbeError.value = ''
  try {
    const result = await window.shangbo.computer.probe()
    if (unmounted) return
    computerProbeResult.value = result
  } catch (err: unknown) {
    if (unmounted) return
    computerProbeResult.value = null
    computerProbeError.value = err instanceof Error ? err.message : String(err)
  } finally {
    if (!unmounted) computerProbing.value = false
  }
}

onMounted(async () => {
  await loadComputerUse()
  await probeComputer()
})

onBeforeUnmount(() => {
  unmounted = true
})
</script>

<template>
  <section class="content-pane computer-use-pane">
    <h3 class="pane-large-title">电脑控制</h3>

    <div class="section-block">
      <span class="section-sub-title">启用</span>

      <div class="setting-card-box">
        <div class="row-text">
          <span class="card-main-title">启用电脑控制</span>
          <span class="card-desc">允许 AI 助手控制您的鼠标和键盘，与桌面应用程序进行交互</span>
        </div>
        <label class="switch-control">
          <input
            type="checkbox"
            :checked="computerUseEnabled"
            @change="toggleComputerUse"
          />
          <span class="switch-slider" />
        </label>
      </div>
    </div>

    <div class="guidance-box">
      <h5 class="guide-h5">💡 电脑控制使用说明与安全保障</h5>
      <ul class="guide-list">
        <li><strong>操作范围：</strong>开启后，模型可以通过捕获屏幕画面识别按钮与输入框，自动移动鼠标、点击或输入文本。</li>
        <li><strong>安全确认：</strong>默认开启手动审批模式，所有鼠标点击与按键操作前均会弹出参数确认卡片，经您同意后才执行。</li>
        <li><strong>紧急停止：</strong>自动化过程中可{{ emergencyStopTip }}，或点击底栏「停止」按钮瞬间阻断。</li>
      </ul>
    </div>

    <div class="section-block">
      <span class="section-sub-title">双通道自检</span>
      <div class="setting-card-box">
        <div class="row-text">
          <span class="card-main-title">桌面控制通道状态</span>
          <span class="card-desc">无障碍树（agent-desktop）负责精准点控件；键鼠（nut-js）负责截图后的点击输入。均为真实探测，不伪装可用。</span>
        </div>
        <button class="btn btn-ghost tiny" :disabled="computerProbing" @click="probeComputer">
          {{ computerProbing ? '自检中…' : computerProbeResult ? '重新自检' : '立即自检' }}
        </button>
      </div>
      <div v-if="computerProbeError" class="row-sub" style="color: var(--danger, #c0392b); margin-top: 8px;">
        自检失败：{{ computerProbeError }}
      </div>
      <div v-if="computerProbeResult" class="guide-list" style="margin-top: 8px;">
        <div class="row-sub">
          agent-desktop：{{ computerProbeResult.agentDesktop.available ? `可用（${computerProbeResult.agentDesktop.binary}）` : `不可用（${computerProbeResult.agentDesktop.reason ?? '未找到可用二进制'}）` }}
        </div>
        <div class="row-sub">
          nut-js 键鼠：{{ computerProbeResult.nutJs.available ? '可用' : `不可用（${computerProbeResult.nutJs.error ?? '未知错误'}）` }}
        </div>
        <div class="row-sub">
          全局急停 {{ computerProbeResult.emergencyStop.displayLabel }}：{{ computerProbeResult.emergencyStop.registered ? '已注册' : '未注册' }}
        </div>
      </div>
      <div v-else-if="!computerProbing" class="row-sub" style="margin-top: 8px;">
        尚未自检：点「立即自检」查看两条通道与急停热键的真实状态。
      </div>
    </div>
  </section>
</template>

<style scoped>
.content-pane {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.computer-use-pane {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.pane-large-title {
  margin: 0;
  font-size: 20px;
  font-weight: 700;
  color: var(--text);
}

.section-block {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.section-sub-title {
  display: block;
  font-size: 13px;
  font-weight: 600;
  color: var(--text-muted);
  margin-bottom: 8px;
}

.setting-card-box {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

.row-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  flex: 1;
}

.card-main-title {
  display: block;
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text);
}

.card-desc {
  display: block;
  font-size: 12px;
  color: var(--text-subtle);
  margin-top: 4px;
}

.row-sub {
  font-size: 12px;
  color: var(--text-muted);
}

.guidance-box {
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 14px 16px;
}

.guide-h5 {
  margin: 0 0 8px;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--accent);
}

.guide-list {
  margin: 0;
  padding-left: 18px;
  font-size: 12px;
  color: var(--text-muted);
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.switch-control {
  position: relative;
  display: inline-block;
  width: 36px;
  height: 20px;
  flex-shrink: 0;
  cursor: pointer;
}

.switch-control input {
  opacity: 0;
  width: 0;
  height: 0;
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

.switch-control input:checked + .switch-slider {
  background: var(--accent);
}

.switch-control input:checked + .switch-slider::before {
  transform: translateX(16px);
}
</style>
