<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { AppInfo, UpdateState } from '@shared/types'
import AutonomousSettings from './settings/AutonomousSettings.vue'
import BrowserSettings from './settings/BrowserSettings.vue'
import ComputerUseSettings from './settings/ComputerUseSettings.vue'
import ConnectorsSettings from './settings/ConnectorsSettings.vue'
import CoworkSettings from './settings/CoworkSettings.vue'
import PluginsSettings from './settings/PluginsSettings.vue'
import PreferencesSettings from './settings/PreferencesSettings.vue'
import RemoteSettings from './settings/RemoteSettings.vue'
import ProviderSettings from './ProviderSettings.vue'
import PrivacySettings from './settings/PrivacySettings.vue'
import UsageSettings from './settings/UsageSettings.vue'
import { setLanguage, type SupportedLanguage } from '../i18n'

const props = withDefaults(
  defineProps<{
    open: boolean
    initialTab?: string
    theme: 'light' | 'dark' | 'system'
  }>(),
  {
    initialTab: 'preferences'
  }
)

const emit = defineEmits<{
  'update:open': [value: boolean]
  'update:theme': [value: 'light' | 'dark' | 'system']
}>()

export type SettingsTab =
  | 'preferences'
  | 'privacy'
  | 'usage'
  | 'providers'
  | 'code'
  | 'cowork'
  | 'import_export'
  | 'general'
  | 'remote'
  | 'developer'
  | 'skills'
  | 'connectors'
  | 'plugins'
  | 'computer_use'
  | 'browser'
  | 'autonomous'
  | 'lessons'

const activeTab = ref<SettingsTab>('preferences')
const searchKeyword = ref('')

// 插件/技能徽标：插件总数固定 8（defaultPlugins），技能数为外部技能目录数。
// skillsCount 在 load() 中零额外 IPC 同步，之后由 PluginsSettings 的 counts-change 实时更新。
const pluginsCount = ref(8)
const skillsCount = ref(0)

// （执行与安全策略已迁至 PreferencesSettings.vue）

// （目标驱动与子任务模型已迁至 PreferencesSettings.vue）

// 供应商页已拆至 ProviderSettings.vue（旧逻辑已清理）
const feedback = ref<{ ok: boolean; message: string } | null>(null)
/** 提示条防抖：连续操作先清掉上一条的自动收起计时，避免提示提前消失。 */
let feedbackTimer: ReturnType<typeof setTimeout> | null = null
const lessonsCount = ref(0)
const mcpCount = ref(0)
const appInfo = ref<AppInfo | null>(null)


const updateState = ref<UpdateState | null>(null)
const autoCheck = ref(true)
const autoDownload = ref(true)
/** 本地按钮的忙碌标记：主进程事件到达前后各有一段空窗，不给用户重复点击的机会。 */
const updateBusy = ref(false)

const updateStatusText = computed(() => {
  const s = updateState.value
  if (!s) return '正在读取更新状态…'
  switch (s.status) {
    case 'unsupported':
      return s.reason || '当前环境不支持自动更新'
    case 'idle':
      return '尚未检查更新'
    case 'checking':
      return '正在检查更新…'
    case 'notAvailable':
      return `已是最新版本（${s.currentVersion}）`
    case 'available':
      return `发现新版本 ${s.newVersion}，等待下载`
    case 'downloading':
      return `正在下载 ${s.newVersion}… ${s.percent ?? 0}%`
    case 'ready':
      return `新版本 ${s.newVersion} 已下载完成，重启后生效`
    case 'installing':
      return '正在安装更新，应用即将自动重启…'
    case 'error':
      return `更新失败：${s.error || '未知错误'}`
    default:
      return '未知状态'
  }
})

const updateCheckedAtText = computed(() => {
  const at = updateState.value?.checkedAt
  return at ? `上次检查：${new Date(at).toLocaleString()}` : ''
})

const isUpdating = computed(() => {
  const st = updateState.value?.status
  return updateBusy.value || st === 'checking' || st === 'downloading' || st === 'installing'
})

const canStartDownload = computed(() => {
  const s = updateState.value
  return !!s?.newVersion && (s.status === 'available' || s.status === 'error')
})

const canInstallNow = computed(() => updateState.value?.status === 'ready')

async function manualCheckUpdate(): Promise<void> {
  updateBusy.value = true
  try {
    updateState.value = await window.shangbo.update.check()
  } finally {
    updateBusy.value = false
  }
}

async function manualDownloadUpdate(): Promise<void> {
  updateBusy.value = true
  try {
    updateState.value = await window.shangbo.update.download()
  } finally {
    updateBusy.value = false
  }
}

async function installUpdateNow(): Promise<void> {
  if (!canInstallNow.value) return
  if (!confirm(`将退出并安装 ${updateState.value?.newVersion}，安装完成后自动重启。`)) return
  updateState.value = await window.shangbo.update.install()
}

async function toggleAutoCheck(): Promise<void> {
  await window.shangbo.settings.set('app.update.check', autoCheck.value)
  feedback.value = {
    ok: true,
    message: autoCheck.value ? '已开启每日自动检查更新' : '已关闭自动检查更新'
  }
}

async function toggleAutoDownload(): Promise<void> {
  await window.shangbo.settings.set('app.update.autoDownload', autoDownload.value)
  feedback.value = {
    ok: true,
    message: autoDownload.value ? '发现新版本后将自动下载' : '发现新版本后需要你手动点下载'
  }
}
const autoApprove = ref<string[]>([])



async function load(): Promise<void> {
  const settings = await window.shangbo.settings.getAll()
  // run_command 等价于永久放行任意 shell 命令，不允许出现在 always-allow 列表里
  autoApprove.value = ((settings['tools.autoApprove'] as string[]) ?? []).filter(
    (name) => name !== 'run_command'
  )
  const lang = settings['ui.language'] as SupportedLanguage | undefined
  if (lang) setLanguage(lang)
  // 侧边栏 skills 徽标：复用已拉取的 settings，零额外 IPC。
  skillsCount.value = Array.isArray(settings['agent.skillDirs'])
    ? (settings['agent.skillDirs'] as string[]).length
    : 0
  appInfo.value = await window.shangbo.app.info()
  autoCheck.value = (settings['app.update.check'] as boolean) ?? true
  autoDownload.value = (settings['app.update.autoDownload'] as boolean) ?? true
  updateState.value = await window.shangbo.update.status()
  await loadCodeSettings()
}

// （Cowork 操作函数已迁至 CoworkSettings.vue）

onMounted(() => {
  void load()
  // 下载进度与"已就绪"由主进程推送，避免这里做轮询
  window.shangbo.update.onEvent((state) => {
    updateState.value = state
    updateBusy.value = false
  })
})

onBeforeUnmount(() => {
  window.shangbo.update.offEvent()
  if (feedbackTimer) {
    clearTimeout(feedbackTimer)
    feedbackTimer = null
  }
})

watch(
  () => props.open,
  (open) => {
    if (!open) {
      return
    }
    feedback.value = null
    if (props.initialTab) {
      activeTab.value = props.initialTab as SettingsTab
    }
    void load()
  }
)


watch(
  () => props.initialTab,
  (tab) => {
    if (tab) activeTab.value = tab as SettingsTab
  }
)

// （通用指导规范/语言/通知/只读开关已迁至 PreferencesSettings.vue）


// Code 编辑器设置（仅保留被业务消费的 defaultShell，其余死设置已下线）
const codeDefaultShell = ref('powershell.exe')

async function loadCodeSettings(): Promise<void> {
  const all = await window.shangbo.settings.getAll()
  codeDefaultShell.value = (all['code.defaultShell'] as string) || 'powershell.exe'
}

async function saveCodeSetting(key: string, val: any): Promise<void> {
  await window.shangbo.settings.set(key, val)
  feedback.value = { ok: true, message: '设置已更新' }
  setTimeout(() => (feedback.value = null), 2000)
}

// 数据备份与恢复
const backupExporting = ref(false)
const backupImporting = ref(false)

async function handleExportConfig(): Promise<void> {
  backupExporting.value = true
  try {
    const res = await window.shangbo.backup.exportConfig()
    if (res.ok) {
      feedback.value = { ok: true, message: `配置与经验库已导出至 ${res.path}` }
    } else {
      feedback.value = { ok: false, message: res.message || '导出已取消' }
    }
  } catch (err: any) {
    feedback.value = { ok: false, message: `导出失败：${err.message || String(err)}` }
  } finally {
    backupExporting.value = false
  }
}

async function handleImportConfig(): Promise<void> {
  backupImporting.value = true
  try {
    const res = await window.shangbo.backup.importConfig()
    if (res.ok) {
      feedback.value = { ok: true, message: res.message || '配置与经验库已恢复' }
      void load()
    } else {
      feedback.value = { ok: false, message: res.message || '恢复已取消' }
    }
  } catch (err: any) {
    feedback.value = { ok: false, message: `恢复失败：${err.message || String(err)}` }
  } finally {
    backupImporting.value = false
  }
}

async function handleExportConversations(): Promise<void> {
  backupExporting.value = true
  try {
    const res = await window.shangbo.backup.exportAllConversations()
    if (res.ok) {
      feedback.value = { ok: true, message: `全部会话记录已导出至 ${res.path}` }
    } else {
      feedback.value = { ok: false, message: res.message || '导出已取消' }
    }
  } catch (err: any) {
    feedback.value = { ok: false, message: `导出失败：${err.message || String(err)}` }
  } finally {
    backupExporting.value = false
  }
}


// 浏览器自动化真实检测与清理（已迁至 settings/BrowserSettings.vue）

function toggleDevTools(): void {
  window.shangbo.app.toggleDevTools()
}

function openDbFolder(): void {
  if (appInfo.value?.dbPath) {
    window.shangbo.app.openPath(appInfo.value.dbPath)
  }
}

// 供应商管理逻辑








async function clearAutoApprove(): Promise<void> {
  autoApprove.value = []
  await window.shangbo.settings.set('tools.autoApprove', [])
  feedback.value = { ok: true, message: '已清空自动放行列表' }
}

function close(): void {
  emit('update:open', false)
}

/** 子设置页保存后沿用父级提示条：防抖收起，避免连续操作提示提前消失。 */
function showFeedback(value: { ok: boolean; message: string }): void {
  feedback.value = value
  if (feedbackTimer) clearTimeout(feedbackTimer)
  feedbackTimer = setTimeout(() => {
    feedback.value = null
    feedbackTimer = null
  }, 2000)
}
</script>

<template>
  <div v-if="props.open" class="settings-overlay" @click.self="close" @keydown.esc="close">
    <div class="settings-modal" role="dialog" aria-modal="true">
      <!-- 关闭按钮 -->
      <button class="modal-close-btn" title="关闭设置 (Esc)" @click="close">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
          <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" />
        </svg>
      </button>

      <!-- 左侧边栏导航 (对标图 3、4、5) -->
      <aside class="settings-sidebar">
        <!-- 搜索框 -->
        <div class="sidebar-search">
          <svg class="search-svg" width="13" height="13" viewBox="0 0 16 16" fill="none">
            <circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.2" />
            <path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
          </svg>
          <input
            v-model="searchKeyword"
            type="search"
            class="search-input"
            placeholder="搜索设置…"
            spellcheck="false"
          />
        </div>

        <nav class="nav-groups">
          <!-- 分组 1: 设置 -->
          <div class="nav-group">
            <div class="group-title">通用设置</div>
            <button
              class="nav-tab-btn"
              :class="{ active: activeTab === 'preferences' }"
              @click="activeTab = 'preferences'"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <circle cx="8" cy="8" r="2.2" stroke="currentColor" stroke-width="1.2" />
                <path d="M8 1.8v1.6M8 12.6v1.6M1.8 8h1.6M12.6 8h1.6M3.6 3.6l1.1 1.1M11.3 11.3l1.1 1.1M12.4 3.6l-1.1 1.1M4.7 11.3l-1.1 1.1" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
              </svg>
              <span>偏好设置</span>
            </button>

            <button
              class="nav-tab-btn"
              :class="{ active: activeTab === 'privacy' }"
              @click="activeTab = 'privacy'"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <path d="M8 2l5.5 2.5v4c0 3.5-2.5 6-5.5 7-3-1-5.5-3.5-5.5-7v-4L8 2z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" />
              </svg>
              <span>隐私与安全</span>
            </button>

            <button
              class="nav-tab-btn"
              :class="{ active: activeTab === 'usage' }"
              @click="activeTab = 'usage'"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <path d="M3 13V9M7 13V6M11 13V3M15 13H1" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
              </svg>
              <span>Token 用量统计</span>
            </button>

            <button
              class="nav-tab-btn"
              :class="{ active: activeTab === 'providers' }"
              @click="activeTab = 'providers'"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <path d="M8.5 2L3 9h5l-1 5 6.5-7H8.5l1-5z" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
              <span>模型与推理网关</span>
            </button>

            <button
              class="nav-tab-btn"
              :class="{ active: activeTab === 'code' }"
              @click="activeTab = 'code'"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <path d="M5.5 5L2.5 8L5.5 11M10.5 5L13.5 8L10.5 11" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
              <span>尚搏 Code</span>
            </button>

            <button
              class="nav-tab-btn"
              :class="{ active: activeTab === 'cowork' }"
              @click="activeTab = 'cowork'"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.2" />
                <path d="M8 5v3l2 2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
              </svg>
              <span>协同工作模式</span>
            </button>

            <button
              class="nav-tab-btn"
              :class="{ active: activeTab === 'autonomous' }"
              @click="activeTab = 'autonomous'"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <path d="M8 1.5l1.4 4.1L13.5 7l-4.1 1.4L8 12.5 6.6 8.4 2.5 7l4.1-1.4L8 1.5z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" />
                <path d="M12.5 11.5l.5 1.5 1.5.5-1.5.5-.5 1.5-.5-1.5-1.5-.5 1.5-.5.5-1.5z" fill="currentColor" />
              </svg>
              <span>许愿与自主运行</span>
            </button>

            <button
              class="nav-tab-btn"
              :class="{ active: activeTab === 'lessons' }"
              @click="activeTab = 'lessons'"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <path d="M2.5 3.5A1.5 1.5 0 014 2h8v12H4a1.5 1.5 0 01-1.5-1.5v-9z" stroke="currentColor" stroke-width="1.2" />
                <path d="M5 5h4M5 8h4M5 11h2.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
              </svg>
              <span>经验进化</span>
              <span v-if="lessonsCount > 0" class="nav-tab-count">{{ lessonsCount }}</span>
            </button>

            <button
              class="nav-tab-btn"
              :class="{ active: activeTab === 'import_export' }"
              @click="activeTab = 'import_export'"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <path d="M4 12h8M8 3v6M5.5 6.5L8 9l2.5-2.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
              <span>导入与导出</span>
            </button>
          </div>

          <!-- 分组 2: 客户端选项 -->
          <div class="nav-group">
            <div class="group-title">桌面客户端</div>
            <button
              class="nav-tab-btn"
              :class="{ active: activeTab === 'general' }"
              @click="activeTab = 'general'"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <rect x="2" y="3" width="12" height="8" rx="1.5" stroke="currentColor" stroke-width="1.2" />
                <path d="M5 14h6M8 11v3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
              </svg>
              <span>常规设置</span>
            </button>

            <button
              class="nav-tab-btn"
              :class="{ active: activeTab === 'remote' }"
              @click="activeTab = 'remote'"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <rect x="4.5" y="2" width="7" height="12" rx="1.5" stroke="currentColor" stroke-width="1.2" />
                <path d="M7 12.5h2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
              </svg>
              <span>手机远程</span>
            </button>

            <button
              class="nav-tab-btn"
              :class="{ active: activeTab === 'developer' }"
              @click="activeTab = 'developer'"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <path d="M12.5 10.5l-2-2a3 3 0 00-3.5-.5L4.5 5.5a1.5 1.5 0 00-2 2l2.5 2.5a3 3 0 00.5 3.5l2 2a1.5 1.5 0 002.1 0l2.9-2.9a1.5 1.5 0 000-2.1z" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" />
              </svg>
              <span>开发者选项</span>
            </button>
          </div>

          <!-- 分组 3: 扩展定制 -->
          <div class="nav-group">
            <div class="group-title">定制扩展</div>
            <button
              class="nav-tab-btn"
              :class="{ active: activeTab === 'skills' }"
              @click="activeTab = 'skills'"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <path d="M3 4h10M3 8h10M3 12h6" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
              </svg>
              <span>技能中心 (Skills)</span>
              <span v-if="skillsCount > 0" class="nav-tab-count">{{ skillsCount }}</span>
            </button>

            <button
              class="nav-tab-btn"
              :class="{ active: activeTab === 'connectors' }"
              @click="activeTab = 'connectors'"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <circle cx="8" cy="8" r="4.5" stroke="currentColor" stroke-width="1.2" />
                <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
              </svg>
              <span>连接器 / MCP</span>
              <span v-if="mcpCount > 0" class="nav-tab-count">{{ mcpCount }}</span>
            </button>

            <button
              class="nav-tab-btn"
              :class="{ active: activeTab === 'plugins' }"
              @click="activeTab = 'plugins'"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <path d="M7 3h2v3h3v2H9v5H7V8H4V6h3V3z" stroke="currentColor" stroke-width="1.2" />
              </svg>
              <span>插件中心</span>
              <span v-if="pluginsCount > 0" class="nav-tab-count">{{ pluginsCount }}</span>
            </button>
          </div>

          <!-- 分组 4: 自动化与控制 (对标图片 2、图片 3) -->
          <div class="nav-group">
            <div class="group-title">自动化与控制</div>
            <button
              class="nav-tab-btn"
              :class="{ active: activeTab === 'computer_use' }"
              @click="activeTab = 'computer_use'"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <rect x="2" y="3" width="12" height="8" rx="1.5" stroke="currentColor" stroke-width="1.2" />
                <path d="M5 14h6M8 11v3" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" />
              </svg>
              <span>电脑控制</span>
            </button>

            <button
              class="nav-tab-btn"
              :class="{ active: activeTab === 'browser' }"
              @click="activeTab = 'browser'"
            >
              <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                <circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="1.2" />
                <path d="M2.5 8h11M8 2.5a10 10 0 010 11M8 2.5a10 10 0 000 11" stroke="currentColor" stroke-width="1.2" />
              </svg>
              <span>浏览器控制</span>
            </button>
          </div>
        </nav>
      </aside>

      <!-- 右侧主体内容 -->
      <main class="settings-content">
        <!-- 操作反馈条 -->
        <div v-if="feedback" class="feedback-toast" :class="{ error: !feedback.ok }">
          <span>{{ feedback.message }}</span>
        </div>

        <!-- ========================================================
             1. 偏好设置 (图片 3 对标实现)
             ======================================================== -->
        <PreferencesSettings
          v-if="activeTab === 'preferences'"
          :theme="props.theme"
          @update:theme="emit('update:theme', $event)"
          @feedback="showFeedback"
        />

        <!-- ========================================================
             2. 隐私与安全 (图片 4 对标实现)
             ======================================================== -->
        <PrivacySettings v-if="activeTab === 'privacy'" />

        <!-- ========================================================
             3. Token 用量统计 (图片 5 对标实现)
             ======================================================== -->
        <UsageSettings
          v-show="activeTab === 'usage'"
          @feedback="showFeedback"
        />

        <!-- ========================================================
             4. 模型与推理网关 (Providers)
             ======================================================== -->
        <section v-if="activeTab === 'providers'" class="content-pane provider-redesign">
          <ProviderSettings />
        </section>

        <!-- ========================================================
             4b. 许愿与自主运行
             ======================================================== -->
        <AutonomousSettings
          v-if="activeTab === 'autonomous' || activeTab === 'lessons'"
          :tab="activeTab === 'lessons' ? 'lessons' : 'autonomous'"
          @feedback="showFeedback"
          @close="close"
          @lessons-change="lessonsCount = $event"
        />


        <!-- 5. 常规选项 (General) -->
        <section v-if="activeTab === 'general'" class="content-pane">
          <div class="section-block">
            <h3 class="pane-title">客户端与系统信息</h3>
            <div v-if="appInfo" class="info-grid">
              <div class="info-item"><span class="info-k">应用名称:</span> <span class="info-v">{{ appInfo.name }}</span></div>
              <div class="info-item"><span class="info-k">客户端版本:</span> <span class="info-v">{{ appInfo.version }}</span></div>
              <div class="info-item"><span class="info-k">Electron 版本:</span> <span class="info-v mono">{{ appInfo.electron }}</span></div>
              <div class="info-item"><span class="info-k">Node 运行时:</span> <span class="info-v mono">{{ appInfo.node }}</span></div>
              <div class="info-item"><span class="info-k">本地数据库:</span> <span class="info-v mono text-truncate" :title="appInfo.dbPath">{{ appInfo.dbPath }}</span></div>
              <div class="info-item"><span class="info-k">C 内核引擎:</span> <span class="info-v mono" :class="appInfo.cCoreEngine?.available ? 'text-success' : 'text-subtle'">{{ appInfo.cCoreEngine?.available ? (appInfo.cCoreEngine?.daemonRunning ? '原生运行中 (RPC 守护进程)' : '就绪 (CLI 双通道模式)') : '平滑降级 (纯 TypeScript 兜底)' }}</span></div>
              <div v-if="appInfo.cCoreEngine?.available" class="info-item"><span class="info-k">C 内核版本:</span> <span class="info-v mono">{{ appInfo.cCoreEngine.version }} ({{ appInfo.cCoreEngine.engine }})</span></div>
              <div v-if="appInfo.cCoreEngine?.executablePath" class="info-item"><span class="info-k">内核路径:</span> <span class="info-v mono text-truncate" :title="appInfo.cCoreEngine.executablePath">{{ appInfo.cCoreEngine.executablePath }}</span></div>
            </div>
          </div>

          <div class="divider" />

          <div class="section-block">
            <h3 class="pane-title">应用更新</h3>

            <div v-if="appInfo && appInfo.installWritable === false" class="update-warn">
              当前装在 <span class="mono">{{ appInfo.installPath || '系统目录' }}</span>，该目录不可写，自动更新下载后会安装失败。建议用默认目录重装一次，之后即可自动更新；或关掉自动检查改手动安装。
            </div>
            <div v-if="appInfo?.installPath" class="update-path subtle">安装目录：<span class="mono">{{ appInfo.installPath }}</span> · 更新通道：<span class="mono">{{ appInfo.updateChannel || 'github' }}</span></div>

            <div class="update-head">
              <div class="row-text">
                <span class="setting-label">当前版本 {{ appInfo?.version || '—' }}</span>
                <span class="row-sub">{{ updateStatusText }}</span>
                <span v-if="updateCheckedAtText" class="row-sub update-time">{{ updateCheckedAtText }}</span>
              </div>
              <div class="update-actions">
                <button
                  class="btn btn-ghost tiny"
                  :disabled="isUpdating"
                  @click="manualCheckUpdate"
                >
                  {{ updateState?.status === 'checking' ? '检查中…' : '检查更新' }}
                </button>
                <button
                  v-if="canStartDownload"
                  class="btn btn-ghost tiny"
                  @click="manualDownloadUpdate"
                >
                  下载更新
                </button>
                <button v-if="canInstallNow" class="btn btn-primary tiny" @click="installUpdateNow">
                  重启安装
                </button>
              </div>
            </div>

            <div v-if="updateState?.status === 'downloading'" class="update-progress">
              <div class="update-progress-fill" :style="{ width: `${updateState.percent ?? 0}%` }" />
            </div>

            <p v-if="updateState?.releaseNotes" class="update-notes">
              {{ updateState.releaseNotes }}
            </p>

            <div class="setting-row">
              <div class="row-text">
                <span class="setting-label">自动检查更新</span>
                <span class="row-sub">
                  启动 20 秒后检查一次，之后每 24 小时一次。关掉后仍可随时手动检查。
                </span>
              </div>
              <label class="switch-control">
                <input v-model="autoCheck" type="checkbox" @change="toggleAutoCheck" />
                <span class="switch-slider" />
              </label>
            </div>

            <div class="setting-row">
              <div class="row-text">
                <span class="setting-label">自动下载更新</span>
                <span class="row-sub">
                  发现新版本时在后台下载安装包。安装动作仍需确认，应用不会自己重启或打断你。
                </span>
              </div>
              <label class="switch-control">
                <input v-model="autoDownload" type="checkbox" @change="toggleAutoDownload" />
                <span class="switch-slider" />
              </label>
            </div>
          </div>
        </section>

        <!-- 6. 开发者选项 (Developer) -->
        <section v-if="activeTab === 'developer'" class="content-pane developer-pane">
          <div class="section-block">
            <h3 class="pane-title">开发者调试工具</h3>
            <p class="row-sub">用于调试界面渲染、主进程与渲染进程 IPC 通信以及查看控制台日志。</p>

            <div class="setting-row">
              <div class="row-text">
                <span class="setting-label">Chromium 开发者工具 (DevTools)</span>
                <span class="row-sub">打开或关闭内置网页检查器与控制台 (F12)</span>
              </div>
              <button class="btn btn-ghost tiny" @click="toggleDevTools">
                切换 DevTools
              </button>
            </div>

            <div class="setting-row">
              <div class="row-text">
                <span class="setting-label">本地数据与缓存目录</span>
                <span class="row-sub mono text-truncate" :title="appInfo?.dbPath">{{ appInfo?.dbPath }}</span>
              </div>
              <button class="btn btn-ghost tiny" :disabled="!appInfo?.dbPath" @click="openDbFolder">
                打开存储目录
              </button>
            </div>
          </div>

          <div class="divider" />

          <div class="section-block">
            <h3 class="pane-title">安全授权与放行</h3>
            <div class="setting-row">
              <div class="row-text">
                <span class="setting-label">永久放行的工具数量</span>
                <span class="row-sub">当前已放行 {{ autoApprove.length }} 个工具</span>
              </div>
              <button class="btn btn-ghost tiny btn-danger" :disabled="autoApprove.length === 0" @click="clearAutoApprove">
                清空全部放行授权
              </button>
            </div>
          </div>
        </section>

        <!-- ========================================================
             手机远程（外网 PWA + 端到端加密）
             ======================================================== -->
        <RemoteSettings
          v-if="activeTab === 'remote'"
          @feedback="showFeedback"
        />

        <!-- ========================================================
             6. 插件中心 (Plugins) 与技能中心 (Skills) - 高仿真对标图片 2
             ======================================================== -->
        <PluginsSettings
          v-if="activeTab === 'plugins' || activeTab === 'skills'"
          :tab="activeTab === 'skills' ? 'skills' : 'plugins'"
          :app-name="appInfo?.name"
          @feedback="showFeedback"
          @navigate="activeTab = $event as SettingsTab"
          @counts-change="pluginsCount = $event.plugins; skillsCount = $event.skills"
        />

        <!-- ========================================================
             7. MCP Servers 管理中心 (图片 1 对标实现)
             ======================================================== -->
        <ConnectorsSettings
          v-if="activeTab === 'connectors'"
          :plugins-count="pluginsCount"
          :skills-count="skillsCount"
          :approved-count="autoApprove.length"
          @feedback="showFeedback"
          @navigate="activeTab = $event as SettingsTab"
          @mcp-change="mcpCount = $event"
        />

        <!-- 8. 电脑控制：已拆至 settings/ComputerUseSettings.vue -->
        <ComputerUseSettings v-if="activeTab === 'computer_use'" @feedback="showFeedback" />

        <!-- 9. 浏览器控制：已拆至 settings/BrowserSettings.vue -->
        <BrowserSettings
          v-if="activeTab === 'browser'"
          @feedback="showFeedback"
          @navigate="activeTab = $event as SettingsTab"
        />

        <!-- ========================================================
             协同工作模式 (Cowork) 设置面板 (对标图 4 精准实现)
             ======================================================== -->
        <CoworkSettings
          v-if="activeTab === 'cowork'"
          @feedback="showFeedback"
        />

        <!-- 自主任务编辑弹窗 -->

        <!-- ========================================================
             尚搏 Code 设置 (activeTab === 'code')
             ======================================================== -->
        <section v-if="activeTab === 'code'" class="content-pane code-pane">
          <div class="section-block">
            <h3 class="pane-title">尚搏 Code 编辑器与环境</h3>
            <p class="row-sub">配置内置终端环境。编辑器展示类设置已下线（未被业务消费）。</p>

            <div class="setting-row">
              <div class="row-text">
                <span class="setting-label">默认终端 Shell</span>
                <span class="row-sub">工作台运行命令时启动的 Shell 程序（如 powershell.exe, cmd.exe, bash）</span>
              </div>
              <input
                v-model="codeDefaultShell"
                class="select-control mono"
                style="flex: 1; max-width: 260px;"
                placeholder="powershell.exe"
                @change="saveCodeSetting('code.defaultShell', codeDefaultShell)"
              />
            </div>
          </div>
        </section>

        <!-- ========================================================
             导入与导出 (activeTab === 'import_export')
             ======================================================== -->
        <section v-if="activeTab === 'import_export'" class="content-pane import-export-pane">
          <div class="section-block">
            <h3 class="pane-title">配置与经验备份</h3>
            <p class="row-sub">一键导出当前应用的所有模型密钥、插件配置、偏好设置与已验证经验进化库。</p>

            <div class="setting-row">
              <div class="row-text">
                <span class="setting-label">导出配置文件</span>
                <span class="row-sub">将设置项与已沉淀的项目经验导出为独立 JSON 备份文件</span>
              </div>
              <button class="btn btn-primary tiny" :disabled="backupExporting" @click="handleExportConfig">
                {{ backupExporting ? '导出中…' : '导出配置 (.json)' }}
              </button>
            </div>

            <div class="setting-row">
              <div class="row-text">
                <span class="setting-label">导入配置文件</span>
                <span class="row-sub">从之前导出的 JSON 备份中恢复配置与经验库</span>
              </div>
              <button class="btn btn-ghost tiny" :disabled="backupImporting" @click="handleImportConfig">
                {{ backupImporting ? '恢复中…' : '导入恢复…' }}
              </button>
            </div>
          </div>

          <div class="divider" />

          <div class="section-block">
            <h3 class="pane-title">会话数据归档</h3>
            <p class="row-sub">导出所有历史会话消息记录与产物记录，用于本地备份或迁移。</p>

            <div class="setting-row">
              <div class="row-text">
                <span class="setting-label">导出全部历史对话</span>
                <span class="row-sub">将当前 SQLite 数据库中全部对话与消息导出为 JSON 压缩包</span>
              </div>
              <button class="btn btn-ghost tiny" :disabled="backupExporting" @click="handleExportConversations">
                导出全部对话
              </button>
            </div>
          </div>
        </section>

        <!-- （全局协同指令 / 添加记忆弹窗已随 CoworkSettings 迁出） -->
      </main>
    </div>
  </div>
</template>

<style scoped>

.settings-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(4px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.settings-modal {
  position: relative;
  width: 1040px;
  max-width: 96vw;
  height: 720px;
  max-height: 92vh;
  background: var(--bg-elevated);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-lg);
  box-shadow: 0 24px 70px rgba(0, 0, 0, 0.25);
  display: grid;
  grid-template-columns: 240px 1fr;
  overflow: hidden;
}

.modal-close-btn {
  position: absolute;
  top: 16px;
  right: 18px;
  width: 28px;
  height: 28px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  z-index: 10;
  transition: all 0.12s ease;
}

.modal-close-btn:hover {
  background: var(--surface-hover);
  color: var(--text);
}

/* 左侧边栏 */
.settings-sidebar {
  background: var(--sidebar-bg);
  border-right: 1px solid var(--border);
  display: flex;
  flex-direction: column;
  padding: 16px 12px;
  gap: 12px;
  overflow-y: auto;
}

.sidebar-search {
  position: relative;
  display: flex;
  align-items: center;
}

.search-svg {
  position: absolute;
  left: 10px;
  color: var(--text-subtle);
  pointer-events: none;
}

.search-input {
  width: 100%;
  padding: 6px 10px 6px 30px;
  font-size: 12.5px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  outline: none;
  color: var(--text);
}

.nav-groups {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.nav-group {
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.group-title {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-subtle);
  padding: 4px 8px;
  letter-spacing: 0.2px;
}

.nav-tab-btn {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 10px;
  border-radius: var(--radius-sm);
  font-size: 12.5px;
  color: var(--text);
  transition: all 0.12s ease;
  text-align: left;
}

.nav-tab-btn:hover {
  background: var(--surface-hover);
}

.nav-tab-btn.active {
  background: var(--surface);
  box-shadow: inset 0 0 0 1px var(--border);
  font-weight: 600;
}

.nav-tab-count {
  margin-left: auto;
  font-size: 11px;
  font-weight: 600;
  padding: 1px 6px;
  border-radius: 10px;
  background: var(--surface);
  color: var(--text-muted);
}

.nav-tab-btn.active .nav-tab-count {
  background: var(--accent-soft);
  color: var(--accent);
}

/* 右侧主体 */
.settings-content {
  display: flex;
  flex-direction: column;
  height: 100%;
  overflow-y: auto;
  padding: 28px 36px;
  position: relative;
}

.feedback-toast {
  position: absolute;
  top: 14px;
  left: 36px;
  right: 60px;
  padding: 8px 14px;
  border-radius: var(--radius-sm);
  background: var(--success-soft);
  color: var(--success);
  border: 1px solid var(--success);
  font-size: 12px;
  z-index: 5;
}

.feedback-toast.error {
  background: var(--danger-soft);
  color: var(--danger);
  border-color: var(--danger);
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

.select-control {
  padding: 6px 12px;
  font-size: 12.5px;
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  color: var(--text);
  outline: none;
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

.switch-control input:checked + .switch-slider {
  background: var(--accent);
}

.switch-control input:checked + .switch-slider:before {
  transform: translateX(16px);
}

.field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.field-label {
  font-size: 12px;
  font-weight: 500;
}

.input {
  padding: 7px 10px;
  font-size: 12.5px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  color: var(--text);
  outline: none;
}

.input:focus {
  border-color: var(--accent);
}

/* 常规与信息展示 */
.info-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
  padding: 12px;
  background: var(--surface);
  border-radius: var(--radius);
  font-size: 12.5px;
}

.info-item {
  display: flex;
  gap: 6px;
}

.info-k {
  color: var(--text-muted);
}

/* ========================================================
   需求 2：供应商卡片下的模型快速切换显隐配置样式
   ======================================================== */

/* ========================================================
   需求 3：插件中心 (Plugins) 与技能中心 (Skills) 对标图片 2
   ======================================================== */

/* ========================================================
   图片 1 样式：MCP Servers 管理中心
   ======================================================== */

/* 电脑控制 / 浏览器控制样式已随 Tab 拆分迁至
   settings/ComputerUseSettings.vue 与 settings/BrowserSettings.vue。 */

/* ========================================================
   对标图 4 样式：协同工作模式 (Cowork)
   ======================================================== */

/* ========================================================
   子弹窗样式 (受信任文件夹 / 全局指令 / 记忆添加)
   ======================================================== */
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

.field-label {
  font-size: 12px;
  font-weight: 500;
  color: var(--text);
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

/* ---------------- 应用更新 ---------------- */
.update-warn { padding: 10px 12px; border: 1px solid var(--warning); background: color-mix(in srgb, var(--warning) 10%, transparent); border-radius: 8px; font-size: 12px; line-height: 1.6; }
.update-path { font-size: 11.5px; margin-top: 8px; }
.update-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 10px;
}

.update-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.update-time {
  color: var(--text-subtle);
  font-variant-numeric: tabular-nums;
}

.update-progress {
  height: 4px;
  border-radius: var(--radius-full);
  background: var(--border);
  overflow: hidden;
  margin: 4px 0 10px;
}

.update-progress-fill {
  height: 100%;
  background: var(--accent);
  border-radius: var(--radius-full);
  transition: width 0.25s ease;
}

.update-notes {
  margin: 0 0 12px;
  padding: 10px 12px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
  max-height: 160px;
  overflow-y: auto;
}

/* ========================================================
   许愿模式 / 自主运行 / 经验进化
   ======================================================== */

.wish-toolbar .subtle {
  margin-left: auto;
}

.lesson-foot .text-truncate {
  flex: 1;
  min-width: 0;
}

@media (max-width: 900px) {
  .wish-field-grid,
  .wish-form-grid {
    grid-template-columns: 1fr;
  }

  .wish-task-card {
    flex-direction: column;
  }

  .wish-task-actions {
    justify-content: flex-start;
    max-width: none;
  }
}

</style>
