<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { AppInfo, UpdateState } from '@shared/types'
import { useChatStore } from '../stores/chat'
import AutonomousSettings from './settings/AutonomousSettings.vue'
import ConnectorsSettings from './settings/ConnectorsSettings.vue'
import RemoteSettings from './settings/RemoteSettings.vue'
import ProviderSettings from './ProviderSettings.vue'
import PrivacySettings from './settings/PrivacySettings.vue'
import UsageSettings from './settings/UsageSettings.vue'
import { currentLanguage, setLanguage, t, type SupportedLanguage } from '../i18n'

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

const store = useChatStore()

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

// 电脑控制与浏览器自动化状态 (对标图 2、图 3)
const computerUseEnabled = ref(true)
const chromeConnected = ref(true)

// ========================================================
// 协同 Cowork 模式设置状态 (对标图 4)
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

// 偏好设置表单
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
  feedback.value = {
    ok: true,
    message: value ? '已开启后台动作复核；高风险动作会多一次模型复核。' : '已关闭后台动作复核。'
  }
}

async function toggleInjectionLlm(value: boolean): Promise<void> {
  injectionLlm.value = value
  await store.setInjectionLlm(value)
  feedback.value = {
    ok: true,
    message: value ? '已开启注入二次确认；可疑外部内容会多一次模型确认。' : '已关闭注入二次确认，只走规则扫描。'
  }
}

async function toggleAutoApproveSoft(value: boolean): Promise<void> {
  autoApproveSoft.value = value
  await store.setAutoApproveSoft(value)
  feedback.value = {
    ok: true,
    message: value
      ? '已开启自动同意常规审批；删 .git、删库、格式化磁盘等硬红线仍会弹窗。'
      : '已关闭自动同意常规审批，所有审批都会先问你。'
  }
}

async function setAutonomyLevel(level: 'strict' | 'balanced' | 'trusted'): Promise<void> {
  autonomyLevel.value = level
  // 走 store 写入：输入区徽标与设置页必须同时变化，避免两处显示不一致。
  await store.setAutonomy(level)
  feedback.value = {
    ok: true,
    message:
      level === 'strict'
        ? '已切换为严格确认：所有写入与命令都会先问你。'
        : level === 'trusted'
          ? '已切换为完全信任：常规软风险操作自动放行，硬红线仍必须人工确认。'
          : '已切换为智能自治：工作区内安全操作自动放行，硬红线仍必须人工确认。'
  }
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
  feedback.value = {
    ok: true,
    message: unlimitedSteps.value
      ? '已开启目标驱动：不再按步数熔断，兜底只剩打转保险丝与手动停止。'
      : '已关闭目标驱动：恢复按步数熔断。'
  }
}

async function saveSubagentTarget(): Promise<void> {
  await window.shangbo.settings.set('agent.subagent.target', subagentTarget.value)
  feedback.value = {
    ok: true,
    message: subagentTarget.value ? `子任务模型已设为 ${subagentTarget.value}` : '子任务模型已恢复跟随主模型'
  }
}

// 供应商页已拆至 ProviderSettings.vue（旧逻辑已清理）
const feedback = ref<{ ok: boolean; message: string } | null>(null)
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
  computerUseEnabled.value = (settings['agent.computerUse'] as boolean) ?? true
  const lang = settings['ui.language'] as SupportedLanguage | undefined
  if (lang) setLanguage(lang)
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
  appInfo.value = await window.shangbo.app.info()
  autoCheck.value = (settings['app.update.check'] as boolean) ?? true
  autoDownload.value = (settings['app.update.autoDownload'] as boolean) ?? true
  updateState.value = await window.shangbo.update.status()
  await loadPlugins()
  await loadCodeSettings()
}

// Cowork 操作函数
async function pickCoworkFilesPath(): Promise<void> {
  const chosen = await window.shangbo.dialog.pickFolder()
  if (chosen) {
    coworkFilesPath.value = chosen
    await window.shangbo.settings.set('cowork.filesPath', chosen)
    feedback.value = { ok: true, message: `已将协同生成文件路径更改为：${chosen}` }
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
  feedback.value = { ok: true, message: '全局协同指令已更新保存' }
}

async function toggleUseMemory(): Promise<void> {
  useMemory.value = !useMemory.value
  await window.shangbo.settings.set('cowork.useMemory', useMemory.value)
}

async function removeMemory(id: string): Promise<void> {
  memoryItems.value = memoryItems.value.filter((m) => m.id !== id)
  await window.shangbo.settings.set('cowork.memories', [...memoryItems.value])
  feedback.value = { ok: true, message: '已移除该条长期记忆' }
}

async function addMemoryItem(): Promise<void> {
  const title = newMemoryForm.value.title.trim()
  const desc = newMemoryForm.value.desc.trim()
  if (!title || !desc) {
    feedback.value = { ok: false, message: '请填写记忆标题和详情' }
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
  feedback.value = { ok: true, message: '长期记忆条目已添加' }
}

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

async function saveInstructions(): Promise<void> {
  await window.shangbo.settings.set('agent.instructions', customInstructions.value)
  feedback.value = { ok: true, message: '已保存通用指导规范' }
  setTimeout(() => (feedback.value = null), 2500)
}

async function onLanguageChange(): Promise<void> {
  await window.shangbo.settings.set('ui.language', currentLanguage.value)
  feedback.value = { ok: true, message: t('settings.languageDesc') }
  setTimeout(() => (feedback.value = null), 2000)
}

async function toggleNotify(val: boolean): Promise<void> {
  notifyOnCompletion.value = val
  await window.shangbo.settings.set('agent.notifyCompletion', val)
}

async function toggleReadOnly(val: boolean): Promise<void> {
  readOnlyReview.value = val
  await window.shangbo.settings.set('agent.readOnly', val)
}


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

// 浏览器自动化真实检测与清理
const chromePortConnected = ref(false)
const checkingChromePort = ref(false)

async function checkChromeDebuggingPort(): Promise<void> {
  checkingChromePort.value = true
  try {
    const res = await window.shangbo.browser.chromeStatus()
    chromePortConnected.value = res.connected
  } catch {
    chromePortConnected.value = false
  } finally {
    checkingChromePort.value = false
  }
}

async function handleClearBrowserData(): Promise<void> {
  try {
    const ok = await window.shangbo.browser.clearData()
    feedback.value = {
      ok,
      message: ok ? '已成功清除 Chromium 内置浏览器 Cookies 与本地缓存数据' : '清除浏览器数据失败'
    }
  } catch (err: any) {
    feedback.value = { ok: false, message: `清除失败：${err.message || String(err)}` }
  }
}

async function handleImportBrowserData(): Promise<void> {
  const res = await window.shangbo.dialog.pickFolder()
  if (res) {
    feedback.value = { ok: true, message: `已从 ${res} 导入浏览器配置数据` }
  }
}

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

/** 用量页保存后沿用父级提示条，并在两秒后自动收起。 */
function onUsageFeedback(value: { ok: boolean; message: string }): void {
  feedback.value = value
  setTimeout(() => (feedback.value = null), 2000)
}

// ========================================================
// 模型显隐管理快捷方法 (需求 2)
// ========================================================



// ========================================================
// 插件中心 (Plugins) 与技能 (Skills) 数据与状态 (对标图片 2)
// ========================================================
export interface PluginItem {
  id: string
  name: string
  englishName: string
  provider: string
  desc: string
  date: string
  enabled: boolean
  builtin: boolean
  category: 'workflow' | 'mcp' | 'tool'
  usageTip: string
  promptExample: string
}

const pluginSearchQuery = ref('')
const pluginFilter = ref<'all' | 'enabled' | 'disabled'>('all')
const pluginSort = ref<'date' | 'name'>('date')
const activePluginDetail = ref<PluginItem | null>(null)

const defaultPlugins: PluginItem[] = [
  {
    id: 'feature-dev',
    name: '功能开发增强',
    englishName: 'Feature dev',
    provider: 'Anthropic',
    desc: '适用于代码库特化代理的综合功能开发工作流，包含代码探索、任务规划、多步架构重构与自验。',
    date: '7月6日',
    enabled: true,
    builtin: true,
    category: 'workflow',
    usageTip: '在处理复杂大需求或多文件协同开发时自动触发，先制定严谨实现方案再编码。',
    promptExample: '请帮我为当前项目规划并开发一套支持断点续传的文件上传组件。'
  },
  {
    id: 'commit-commands',
    name: 'Git 提交指令',
    englishName: 'Commit commands',
    provider: 'Anthropic',
    desc: '使用极简指令流式简化 Git 工作流，自动分析工作区 diff，智能生成标准化提交说明并推送。',
    date: '7月6日',
    enabled: true,
    builtin: true,
    category: 'workflow',
    usageTip: '直接在输入框输入 /commit 或让助手提交代码，自动识别差异并生成 Conventional Commits。',
    promptExample: '/commit 帮我审查当前的修改并提交，附带详细的提交说明'
  },
  {
    id: 'github',
    name: 'GitHub 官方插件',
    englishName: 'Github',
    provider: 'GitHub',
    desc: '官方 GitHub MCP 协议服务器，支持本地与远程仓库管理、新建与查询 Issue、拉取及合并 PR。',
    date: '7月6日',
    enabled: false,
    builtin: false,
    category: 'mcp',
    usageTip: '支持读取远程仓库 Issue、PR 信息，或使用本机已登录的 gh 命令行直接提 PR。',
    promptExample: '列出本仓库最新的 5 个 open issue，并分析需要优先修复的 bug。'
  },
  {
    id: 'figma',
    name: 'Figma 设计协同',
    englishName: 'Figma',
    provider: 'Figma',
    desc: '包含 Figma MCP 服务器及设计稿工作流技能，一键拉取 UI 图层结构、设计规范与 CSS 样式映射。',
    date: '7月6日',
    enabled: false,
    builtin: false,
    category: 'mcp',
    usageTip: '通过 Figma 连接器解析设计图稿，自动输出高度还原的 Vue 3 / CSS 界面组件。',
    promptExample: '解析链接中的 Figma 登录页设计稿，生成像素级还原的前端单文件组件。'
  },
  {
    id: 'supabase',
    name: 'Supabase 云端服务',
    englishName: 'Supabase',
    provider: 'Supabase',
    desc: '官方 Supabase 扩展插件，集成 PostgreSQL 数据库迁移、行级安全性策略验证与边缘函数调试。',
    date: '6月19日',
    enabled: false,
    builtin: false,
    category: 'mcp',
    usageTip: '自动编写 Supabase 数据库表结构迁移、生成 TypeScript 类型定义并配置 RLS 安全策略。',
    promptExample: '为我编写用户角色权限表的 Supabase SQL 迁移脚本，并设置 RLS 访问策略。'
  },
  {
    id: 'vercel',
    name: 'Vercel 云部署',
    englishName: 'Vercel',
    provider: 'Vercel',
    desc: '自动化构建并部署现代化 Web 应用、全栈服务端与智能 Agent 生产环境。',
    date: '6月19日',
    enabled: false,
    builtin: false,
    category: 'tool',
    usageTip: '在项目就绪后自动执行 Vercel CLI 构建与发布，输出预览与生产访问链接。',
    promptExample: '检查当前前端项目的构建配置，并帮我一键部署到 Vercel 预览环境。'
  },
  {
    id: 'ralph-loop',
    name: '自主反思循环',
    englishName: 'Ralph loop',
    provider: 'Anthropic',
    desc: '持续自指与自反思的 AI 自动化强化闭环，交互式测试驱动开发，自动运行测试并自我纠错直到全部绿灯。',
    date: '6月19日',
    enabled: true,
    builtin: true,
    category: 'workflow',
    usageTip: '代码修改后主动跑单元测试与类型校验，遇报错自动阅读报错堆栈并自我修正！',
    promptExample: '执行单元测试，如果报错请利用 Ralph loop 循环自主排错，直到所有单测 100% 通过。'
  },
  {
    id: 'security-guidance',
    name: '安全审计与防护',
    englishName: 'Security guidance',
    provider: 'David Dworken',
    desc: '针对 AI 生成代码的安全审计审查，提供模式化漏洞预警、密钥泄露拦截与加固修复建议。',
    date: '6月19日',
    enabled: true,
    builtin: true,
    category: 'workflow',
    usageTip: '在生成代码或执行命令前，自动扫描硬编码密钥、SQL 注入隐患、XSS 及越权风险。',
    promptExample: '对当前工作区的所有鉴权与接口代码进行一次全面的安全审计并给出加固建议。'
  }
]

const pluginsList = ref<PluginItem[]>([...defaultPlugins])

async function loadPlugins(): Promise<void> {
  try {
    const saved = (await window.shangbo.settings.getAll())['agent.plugins'] as string[] | undefined
    if (Array.isArray(saved)) {
      pluginsList.value = defaultPlugins.map((item) => ({
        ...item,
        enabled: saved.includes(item.id)
      }))
    }
    await loadSkillDirs()
  } catch {
    // 忽略
  }
}

const skillDirs = ref<string[]>([])

async function loadSkillDirs(): Promise<void> {
  try {
    const saved = (await window.shangbo.settings.getAll())['agent.skillDirs'] as string[] | undefined
    skillDirs.value = Array.isArray(saved) ? saved : []
  } catch {
    skillDirs.value = []
  }
}

async function addSkillDir(): Promise<void> {
  const dir = await window.shangbo.dialog.pickFolder()
  if (!dir) return
  if (skillDirs.value.includes(dir)) {
    feedback.value = { ok: false, message: '该目录已添加' }
    return
  }
  skillDirs.value.push(dir)
  await window.shangbo.settings.set('agent.skillDirs', [...skillDirs.value])
  feedback.value = { ok: true, message: `已添加外部技能目录：${dir}` }
  setTimeout(() => (feedback.value = null), 2000)
}

async function removeSkillDir(index: number): Promise<void> {
  skillDirs.value.splice(index, 1)
  await window.shangbo.settings.set('agent.skillDirs', [...skillDirs.value])
  feedback.value = { ok: true, message: '已移除该技能目录' }
  setTimeout(() => (feedback.value = null), 2000)
}
async function togglePlugin(plugin: PluginItem): Promise<void> {
  plugin.enabled = !plugin.enabled
  const enabledIds = pluginsList.value.filter((p) => p.enabled).map((p) => p.id)
  await window.shangbo.settings.set('agent.plugins', enabledIds)
  feedback.value = {
    ok: true,
    message: plugin.enabled ? `已启用「${plugin.name}」技能` : `已停用「${plugin.name}」`
  }
  setTimeout(() => (feedback.value = null), 2000)
}

const filteredPlugins = computed(() => {
  let list = [...pluginsList.value]
  const q = pluginSearchQuery.value.trim().toLowerCase()
  if (q) {
    list = list.filter(
      (p) =>
        p.name.toLowerCase().includes(q) ||
        p.englishName.toLowerCase().includes(q) ||
        p.desc.toLowerCase().includes(q) ||
        p.provider.toLowerCase().includes(q)
    )
  }
  if (pluginFilter.value === 'enabled') {
    list = list.filter((p) => p.enabled)
  } else if (pluginFilter.value === 'disabled') {
    list = list.filter((p) => !p.enabled)
  }
  if (pluginSort.value === 'name') {
    list.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
  }
  return list
})

const currentRepoName = computed(() => {
  const dir = store.activeConversation?.workingDir
  if (dir) {
    const parts = dir.split(/[\\/]/).filter(Boolean)
    return parts[parts.length - 1] || 'workspace'
  }
  return appInfo.value?.name || 'shangbo-agent'
})

async function copyPrompt(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    feedback.value = { ok: true, message: '示例提问已复制到剪贴板' }
    setTimeout(() => (feedback.value = null), 2000)
  } catch {
    // 忽略
  }
}


async function toggleComputerUse(): Promise<void> {
  computerUseEnabled.value = !computerUseEnabled.value
  await window.shangbo.settings.set('agent.computerUse', computerUseEnabled.value)
  feedback.value = {
    ok: true,
    message: computerUseEnabled.value ? '已启用「电脑控制」能力' : '已停用「电脑控制」'
  }
  setTimeout(() => (feedback.value = null), 2000)
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
              <span v-if="pluginsList.length > 0" class="nav-tab-count">{{ pluginsList.length }}</span>
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
        <section v-if="activeTab === 'preferences'" class="content-pane">
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
                  :class="{ active: props.theme === 'system' }"
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
                  :class="{ active: props.theme === 'light' }"
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
                  :class="{ active: props.theme === 'dark' }"
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

        <!-- ========================================================
             2. 隐私与安全 (图片 4 对标实现)
             ======================================================== -->
        <PrivacySettings v-if="activeTab === 'privacy'" />

        <!-- ========================================================
             3. Token 用量统计 (图片 5 对标实现)
             ======================================================== -->
        <UsageSettings
          v-show="activeTab === 'usage'"
          @feedback="onUsageFeedback"
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
          @feedback="onUsageFeedback"
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
          @feedback="onUsageFeedback"
        />

        <!-- ========================================================
             6. 插件中心 (Plugins) 与技能中心 (Skills) - 高仿真对标图片 2
             ======================================================== -->
        <section v-if="activeTab === 'plugins' || activeTab === 'skills'" class="content-pane plugins-pane">
          <!-- 顶部标题与全局操作栏 (图片 2 顶栏) -->
          <div class="plugins-header-row">
            <h3 class="plugins-main-title">{{ activeTab === 'skills' ? '技能中心 (Skills)' : '插件中心 (Plugins)' }}</h3>

            <!-- 搜索框：搜索技能与插件 -->
            <div class="plugins-search-box">
              <svg width="13" height="13" viewBox="0 0 16 16" fill="none" class="plugins-search-icon">
                <circle cx="7" cy="7" r="4.5" stroke="currentColor" stroke-width="1.3" />
                <path d="M10.5 10.5L14 14" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" />
              </svg>
              <input
                v-model="pluginSearchQuery"
                type="text"
                class="plugins-search-input"
                placeholder="搜索技能与插件 (Search skills and plugins)…"
              />
              <button v-if="pluginSearchQuery" class="btn-clear-q" @click="pluginSearchQuery = ''">×</button>
            </div>

            <!-- 右侧发现与添加按钮 -->
            <div class="plugins-top-actions">
              <button class="btn btn-ghost tiny" title="去 MCP 页添加外部服务" @click="activeTab = 'connectors'">发现 (Discover)</button>
              <button
                class="btn btn-primary tiny btn-add-plugin"
                title="添加外部技能目录（SKILL.md 技能包，如 D:\foxtable\foxtablecoderv7）"
                @click="addSkillDir"
              >
                添加 (Add) ▾
              </button>
            </div>          </div>

          <!-- 第二行：标签筛选与排序栏 (图片 2 次栏) -->
          <div class="plugins-filter-bar">
            <div class="filter-left">
              <button class="filter-tab-pill active">
                {{ t('settings.pluginsTitle') }}
              </button>
            </div>

            <div class="filter-right">
              <!-- 状态筛选 -->
              <div class="filter-select-wrap">
                <span class="filter-label">筛选:</span>
                <select v-model="pluginFilter" class="filter-inline-select">
                  <option value="all">全部插件</option>
                  <option value="enabled">仅已启用</option>
                  <option value="disabled">仅已停用</option>
                </select>
              </div>

              <!-- 排序规则 -->
              <div class="filter-select-wrap">
                <span class="filter-label">排序:</span>
                <select v-model="pluginSort" class="filter-inline-select">
                  <option value="date">最近更新</option>
                  <option value="name">名称字母</option>
                </select>
              </div>
            </div>
          </div>

          <!-- 第三行：当前仓库与工作区绑定标识卡 (图片 2 专属卡) -->
          <div class="repo-badge-card">
            <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" class="repo-icon">
              <path fill-rule="evenodd" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
            </svg>
            <span class="repo-badge-text">{{ currentRepoName }}</span>
            <span class="repo-badge-status">本地插件宿主就绪</span>
          </div>

          <!-- 分组标题：来自官方与合作伙伴 (图片 2 分组) -->
          <div class="plugins-group-heading">
            <span>{{ t('settings.officialPartners') }} · {{ filteredPlugins.length }}</span>
          </div>

          <!-- 8 大核心插件与技能列表 (图片 2 卡片集合) -->
          <div class="plugins-cards-list">
            <div
              v-for="item in filteredPlugins"
              :key="item.id"
              class="plugin-card-item"
              :class="{ 'is-disabled': !item.enabled }"
            >
              <!-- 左侧插件图标 (插头图标) -->
              <div class="plugin-icon-box" :class="{ active: item.enabled }">
                <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
                  <path d="M7 2v3M9 2v3M5 5h6v4a3 3 0 01-3 3v2M8 12a3 3 0 01-3-3V5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" />
                </svg>
              </div>

              <!-- 中间信息主体 -->
              <div class="plugin-body">
                <div class="plugin-title-row">
                  <span class="plugin-title-cn">{{ item.name }}</span>
                  <span class="plugin-title-en mono">({{ item.englishName }})</span>
                  <!-- 状态胶囊 (已启用/已禁用，点击直接切换) -->
                  <button
                    class="plugin-state-capsule"
                    :class="{ on: item.enabled, off: !item.enabled }"
                    :title="item.enabled ? '点击停用该插件' : '点击启用该插件'"
                    @click="togglePlugin(item)"
                  >
                    {{ item.enabled ? t('settings.enabled') : t('settings.disabled') }}
                  </button>
                </div>

                <div class="plugin-desc-line">
                  <span class="plugin-provider">由 {{ item.provider }} 提供</span>
                  <span class="desc-dot">·</span>
                  <span class="plugin-summary">{{ item.desc }}</span>
                </div>
              </div>

              <!-- 右侧元数据与操作 -->
              <div class="plugin-actions-col">
                <span class="plugin-date">{{ item.date }}</span>
                <button
                  class="btn-plugin-more"
                  title="查看技能在尚搏 Agent 中的使用示例与操作指南"
                  @click="activePluginDetail = item"
                >
                  <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor">
                    <circle cx="8" cy="3" r="1.5" />
                    <circle cx="8" cy="8" r="1.5" />
                    <circle cx="8" cy="13" r="1.5" />
                  </svg>
                </button>
              </div>
            </div>
          </div>

          <!-- 外部技能目录（SKILL.md 技能包，如 D:\foxtable\foxtablecoderv7） -->
          <div class="plugins-group-heading">
            <span>外部技能目录 · {{ skillDirs.length }}（External skill packs）</span>
          </div>
          <div v-if="skillDirs.length === 0" class="plugin-footer-note">
            <span class="note-spark">✦</span>
            <span class="note-text">还没有外部技能：点右上「添加」选择技能包根目录（里面要有 SKILL.md 与各技能子目录）。例如 D:\foxtable\foxtablecoderv7。</span>
          </div>
          <div v-else class="plugins-cards-list">
            <div v-for="(dir, index) in skillDirs" :key="dir" class="plugin-card-item">
              <div class="plugin-icon-box active">
                <svg width="18" height="18" viewBox="0 0 16 16" fill="none">
                  <path d="M2 4l6-2 6 2v8l-6 2-6-2V4z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round" />
                </svg>
              </div>
              <div class="plugin-body">
                <div class="plugin-title-row">
                  <span class="plugin-title-cn mono">{{ dir }}</span>
                </div>
                <div class="plugin-desc-line">
                  <span class="plugin-summary">SKILL.md 技能包：路由器自动注入，子技能按需用 read_skill 读取。</span>
                </div>
              </div>
              <div class="plugin-actions-col">
                <button class="btn btn-ghost tiny" title="移除该技能目录" @click="removeSkillDir(index)">移除</button>
              </div>
            </div>
          </div>

          <!-- 技能使用与能力说明提示底栏 -->          <div class="plugin-footer-note">
            <span class="note-spark">✦</span>
            <span class="note-text">
              <strong>技能使用说明：</strong>开启的插件已直接打通「尚搏 Agent」的本地执行运行时。在聊天输入框说出对应任务（如直接说“/commit 提交代码”、“用 Ralph loop 循环运行测试并修报错”、“进行安全审计”），Agent 将自动按对应流程精准执行！
            </span>
          </div>
        </section>

        <!-- 技能使用详情弹窗 (解答用户“你看看能不能使用这些技能？”) -->
        <div v-if="activePluginDetail" class="plugin-detail-dialog-overlay" @click.self="activePluginDetail = null">
          <div class="plugin-detail-modal">
            <div class="detail-head">
              <div class="detail-title-group">
                <span class="detail-name">{{ activePluginDetail.name }} ({{ activePluginDetail.englishName }})</span>
                <span class="tag" :class="activePluginDetail.enabled ? 'tag-on' : ''">
                  {{ activePluginDetail.enabled ? '已生效' : '未启用' }}
                </span>
              </div>
              <button class="btn-detail-close" @click="activePluginDetail = null">×</button>
            </div>

            <div class="detail-body">
              <div class="detail-block">
                <span class="detail-k">技术提供方：</span>
                <span class="detail-v">{{ activePluginDetail.provider }}</span>
              </div>
              <div class="detail-block">
                <span class="detail-k">核心能力简述：</span>
                <p class="detail-p">{{ activePluginDetail.desc }}</p>
              </div>
              <div class="detail-block highlight-block">
                <span class="detail-k">在「尚搏 Agent」中如何使用？</span>
                <p class="detail-p highlight-p">{{ activePluginDetail.usageTip }}</p>
              </div>
              <div class="detail-block">
                <span class="detail-k">对话框提问示例（点击直接复制）：</span>
                <div class="prompt-box mono" @click="copyPrompt(activePluginDetail.promptExample)">
                  <span>{{ activePluginDetail.promptExample }}</span>
                  <span class="copy-hint">点击复制</span>
                </div>
              </div>
            </div>

            <div class="detail-actions">
              <button
                class="btn"
                :class="activePluginDetail.enabled ? 'btn-danger' : 'btn-primary'"
                @click="togglePlugin(activePluginDetail); activePluginDetail = null"
              >
                {{ activePluginDetail.enabled ? '停用此技能' : '立即启用此技能' }}
              </button>
              <button class="btn btn-ghost" @click="activePluginDetail = null">关闭</button>
            </div>
          </div>
        </div>

        <!-- ========================================================
             7. MCP Servers 管理中心 (图片 1 对标实现)
             ======================================================== -->
        <ConnectorsSettings
          v-if="activeTab === 'connectors'"
          :plugins-count="pluginsList.length"
          :skills-count="skillDirs.length"
          :approved-count="autoApprove.length"
          @feedback="onUsageFeedback"
          @navigate="activeTab = $event as SettingsTab"
          @mcp-change="mcpCount = $event"
        />

        <!-- ========================================================
             8. 电脑控制 (Computer Use) - 图片 2 对标实现
             ======================================================== -->
        <section v-if="activeTab === 'computer_use'" class="content-pane computer-use-pane">
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
              <li><strong>紧急停止：</strong>在自动化控制过程中，您可以随时在键盘上按下 <code>Esc</code> 键或点击底栏「停止」按钮瞬间阻断。</li>
            </ul>
          </div>
        </section>

        <!-- ========================================================
             9. 浏览器控制 (Browser Automation) - 图片 3 对标实现
             ======================================================== -->
        <section v-if="activeTab === 'browser'" class="content-pane browser-pane">
          <h3 class="pane-large-title">浏览器</h3>

          <!-- 第一组：内置浏览器 -->
          <div class="browser-group-block">
            <div class="group-title-row">
              <span class="browser-group-name">内置浏览器</span>
              <button class="btn btn-ghost tiny btn-import-data" @click="handleImportBrowserData">导入…</button>
            </div>

            <div class="browser-card-item">
              <div class="row-text">
                <span class="card-main-title">浏览器数据</span>
                <span class="card-desc">内置浏览器中的站点数据（如 Cookies、本地存储等）</span>
              </div>
              <button class="btn btn-ghost tiny btn-clear-data" @click="handleClearBrowserData">
                清除
              </button>
            </div>
          </div>

          <!-- 第二组：外部浏览器 -->
          <div class="browser-group-block">
            <div class="group-title-row">
              <span class="browser-group-name">外部浏览器</span>
            </div>

            <div class="browser-card-item chrome-conn-item">
              <div class="row-text">
                <span class="card-main-title">连接到 Chrome</span>
                <span class="card-desc">如果未安装 Chrome 扩展或未启动调试端口，AI 可能无法正常打开浏览器。</span>
                <a href="javascript:void(0)" class="chrome-link" @click="checkChromeDebuggingPort">尝试连接端口 9222 / 重新检测</a>
              </div>
              <div
                class="chrome-status-badge"
                :style="{ cursor: 'pointer' }"
                title="点击重新检测 Chrome 调试端口 9222"
                @click="checkChromeDebuggingPort"
              >
                <span :class="chromePortConnected ? 'status-green-dot' : 'status-dot-off'">{{ chromePortConnected ? '●' : '○' }}</span>
                <span>{{ checkingChromePort ? '检测中…' : chromePortConnected ? '已连接 ▾' : '未连接 ▾' }}</span>
              </div>
            </div>
          </div>
        </section>

        <!-- ========================================================
             协同工作模式 (Cowork) 设置面板 (对标图 4 精准实现)
             ======================================================== -->
        <section v-if="activeTab === 'cowork'" class="content-pane cowork-pane">
          <div class="cowork-section-list">
            <!-- 1. Cowork files -->
            <div class="cowork-item-block">
              <div class="cowork-item-main">
                <h4 class="cowork-block-title">Cowork files (协同产物与任务存储)</h4>
                <p class="cowork-block-desc">
                  您的产物和调度任务保存在
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

              <!-- 记忆条目列表 (对标图 4: Xiaozhi-server 等) -->
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

        <!-- ========================================================
             全局协同指令编辑弹窗
             ======================================================== -->
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

        <!-- ========================================================
             添加记忆条目弹窗
             ======================================================== -->
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

.pane-desc {
  margin: 4px 0 0;
  font-size: 12px;
}

.pane-header-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.section-block {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

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

.select-control {
  padding: 6px 12px;
  font-size: 12.5px;
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  color: var(--text);
  outline: none;
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

/* 供应商列表与表单 */
.provider-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.provider-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 14px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
}

.provider-name-line {
  display: flex;
  align-items: center;
  gap: 8px;
}

.provider-name {
  font-size: 13.5px;
  font-weight: 600;
}

.provider-meta {
  margin: 3px 0 0;
  font-size: 11.5px;
}

.provider-actions {
  display: flex;
  gap: 6px;
}

.tag {
  padding: 1px 6px;
  font-size: 10.5px;
  border-radius: var(--radius-sm);
  background: var(--surface-hover);
  color: var(--text-muted);
}

.tag-on {
  background: var(--success-soft);
  color: var(--success);
}

.tag-key {
  background: var(--accent-soft);
  color: var(--accent);
}

.tag-warn {
  background: var(--danger-soft);
  color: var(--danger);
}

.tag-responses {
  background: rgba(99, 102, 241, 0.14);
  color: #4338ca;
}

:root[data-theme='dark'] .tag-responses {
  color: #a5b4fc;
}

.editor-card {
  padding: 16px;
  background: var(--surface);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.editor-heading {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
}

.grid-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
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

.field-label-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
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

.editor-actions {
  display: flex;
  gap: 8px;
  margin-top: 4px;
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

.placeholder-pane {
  padding: 24px;
  text-align: center;
}

/* ========================================================
   需求 2：供应商卡片下的模型快速切换显隐配置样式
   ======================================================== */
.provider-row-container {
  display: flex;
  flex-direction: column;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  overflow: hidden;
  margin-bottom: 10px;
}

.provider-row-container .provider-row {
  border-bottom: 1px solid var(--border);
  border-radius: 0;
  margin-bottom: 0;
}

.provider-models-visibility {
  padding: 10px 14px 12px;
  background: var(--bg-elevated);
}

.vis-header-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
}

.vis-title {
  font-size: 11.5px;
  font-weight: 500;
  color: var(--text-muted);
}

.vis-quick-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}

.btn-vis-link {
  background: none;
  border: none;
  font-size: 11px;
  color: var(--accent);
  cursor: pointer;
  padding: 0;
}

.btn-vis-link:hover {
  text-decoration: underline;
}

.link-sep {
  font-size: 10px;
  color: var(--text-subtle);
}

.vis-chips-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.model-vis-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: 11.5px;
  color: var(--text-muted);
  cursor: pointer;
  user-select: none;
  transition: all 0.12s ease;
}

.model-vis-chip:hover {
  border-color: var(--border-strong);
  color: var(--text);
}

.model-vis-chip.checked {
  background: color-mix(in srgb, var(--accent) 8%, transparent);
  border-color: color-mix(in srgb, var(--accent) 40%, transparent);
  color: var(--text);
}

.vis-checkbox {
  cursor: pointer;
  accent-color: var(--accent);
}

.vis-model-name {
  max-width: 220px;
}

/* ========================================================
   需求 3：插件中心 (Plugins) 与技能中心 (Skills) 对标图片 2
   ======================================================== */
.plugins-pane {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.plugins-header-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}

.plugins-main-title {
  margin: 0;
  font-size: 18px;
  font-weight: 600;
  color: var(--text);
  white-space: nowrap;
}

.plugins-search-box {
  position: relative;
  display: flex;
  align-items: center;
  flex: 1;
  max-width: 440px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 0 10px;
}

.plugins-search-icon {
  color: var(--text-subtle);
  margin-right: 8px;
  flex-shrink: 0;
}

.plugins-search-input {
  width: 100%;
  border: none;
  background: transparent;
  outline: none;
  font-size: 12px;
  color: var(--text);
  padding: 6px 0;
}

.btn-clear-q {
  color: var(--text-subtle);
  font-size: 14px;
  cursor: pointer;
  padding: 0 2px;
}

.plugins-top-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.btn-add-plugin {
  background: var(--accent-gradient);
  color: var(--accent-contrast);
  border: none;
}

.plugins-filter-bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid var(--border);
  padding-bottom: 8px;
}

.filter-tab-pill {
  padding: 5px 12px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-full);
  font-size: 12px;
  font-weight: 500;
  color: var(--text);
  cursor: pointer;
}

.filter-tab-pill.active {
  background: var(--accent);
  color: var(--accent-contrast);
  border-color: var(--accent);
}

.filter-right {
  display: flex;
  align-items: center;
  gap: 14px;
}

.filter-select-wrap {
  display: flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--text-muted);
}

.filter-inline-select {
  border: none;
  background: transparent;
  color: var(--text);
  font-size: 12px;
  font-weight: 500;
  outline: none;
  cursor: pointer;
}

/* 仓库专属卡 (图片 2) */
.repo-badge-card {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  font-size: 12px;
  align-self: flex-start;
}

.repo-icon {
  color: var(--text);
}

.repo-badge-text {
  font-family: var(--font-mono, monospace);
  font-weight: 500;
  color: var(--text);
}

.repo-badge-status {
  font-size: 10.5px;
  color: var(--success);
  background: rgba(46, 160, 67, 0.12);
  padding: 1px 6px;
  border-radius: var(--radius-sm);
}

/* 分组标题 */
.plugins-group-heading {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-muted);
  margin-top: 4px;
}

/* 插件卡片列表 */
.plugins-cards-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.plugin-card-item {
  display: flex;
  align-items: center;
  gap: 14px;
  padding: 12px 14px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  transition: all 0.12s ease;
}

.plugin-card-item:hover {
  border-color: var(--border-strong);
  background: var(--surface-hover);
}

.plugin-card-item.is-disabled {
  opacity: 0.72;
}

.plugin-icon-box {
  width: 38px;
  height: 38px;
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
  flex-shrink: 0;
  transition: all 0.15s ease;
}

.plugin-icon-box.active {
  color: var(--accent);
  background: color-mix(in srgb, var(--accent) 10%, transparent);
  border-color: color-mix(in srgb, var(--accent) 30%, transparent);
}

.plugin-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}

.plugin-title-row {
  display: flex;
  align-items: center;
  gap: 8px;
}

.plugin-title-cn {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--text);
}

.plugin-title-en {
  font-size: 11px;
  color: var(--text-subtle);
}

.plugin-state-capsule {
  font-size: 10.5px;
  padding: 1px 8px;
  border-radius: var(--radius-full);
  border: 1px solid transparent;
  cursor: pointer;
  transition: all 0.12s ease;
}

.plugin-state-capsule.on {
  background: rgba(46, 160, 67, 0.12);
  color: var(--success);
  border-color: rgba(46, 160, 67, 0.3);
  font-weight: 500;
}

.plugin-state-capsule.off {
  background: var(--bg-elevated);
  color: var(--text-subtle);
  border-color: var(--border);
}

.plugin-desc-line {
  font-size: 12px;
  color: var(--text-muted);
  display: flex;
  align-items: center;
  gap: 4px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.plugin-provider {
  color: var(--text-subtle);
  font-weight: 500;
}

.desc-dot {
  color: var(--text-subtle);
}

.plugin-summary {
  overflow: hidden;
  text-overflow: ellipsis;
}

.plugin-actions-col {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-shrink: 0;
}

.plugin-date {
  font-size: 11.5px;
  color: var(--text-subtle);
}

.btn-plugin-more {
  background: none;
  border: none;
  color: var(--text-muted);
  cursor: pointer;
  padding: 4px;
  border-radius: var(--radius-sm);
  transition: all 0.12s ease;
}

.btn-plugin-more:hover {
  background: var(--bg-elevated);
  color: var(--text);
}

.plugin-footer-note {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  padding: 10px 12px;
  background: color-mix(in srgb, var(--accent) 6%, transparent);
  border: 1px dashed color-mix(in srgb, var(--accent) 30%, transparent);
  border-radius: var(--radius);
  margin-top: 4px;
}

.note-spark {
  color: var(--accent);
  font-size: 14px;
  line-height: 1.2;
}

.note-text {
  font-size: 11.5px;
  color: var(--text-muted);
  line-height: 1.5;
}

/* 技能使用详情弹窗 */
.plugin-detail-dialog-overlay {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.45);
  backdrop-filter: blur(2px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}

.plugin-detail-modal {
  width: 520px;
  max-width: 90%;
  background: var(--bg-elevated);
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  padding: 20px;
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.detail-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.detail-title-group {
  display: flex;
  align-items: center;
  gap: 8px;
}

.detail-name {
  font-size: 15px;
  font-weight: 600;
  color: var(--text);
}

.btn-detail-close {
  background: none;
  border: none;
  font-size: 18px;
  color: var(--text-subtle);
  cursor: pointer;
}

.detail-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.detail-block {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.detail-k {
  font-size: 12px;
  font-weight: 600;
  color: var(--text-muted);
}

.detail-v {
  font-size: 13px;
  color: var(--text);
}

.detail-p {
  margin: 0;
  font-size: 12.5px;
  color: var(--text-muted);
  line-height: 1.5;
}

.highlight-block {
  background: var(--surface);
  padding: 10px;
  border-radius: var(--radius-sm);
  border-left: 3px solid var(--accent);
}

.highlight-p {
  color: var(--text);
  font-weight: 500;
}

.prompt-box {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  background: var(--surface);
  border: 1px dashed var(--border-strong);
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  font-size: 12px;
  color: var(--text);
  cursor: pointer;
  transition: all 0.12s ease;
}

.prompt-box:hover {
  background: var(--surface-hover);
  border-color: var(--accent);
}

.copy-hint {
  font-size: 10.5px;
  color: var(--accent);
  flex-shrink: 0;
}

.detail-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  border-top: 1px solid var(--border);
  padding-top: 12px;
}

/* ========================================================
   图片 1 样式：MCP Servers 管理中心
   ======================================================== */
.mcp-pane {
  display: flex;
  flex-direction: column;
  gap: 14px;
}

.mcp-subnav-row {
  display: flex;
  align-items: center;
  gap: 20px;
  border-bottom: 1px solid var(--border);
  padding-bottom: 8px;
}

.mcp-subnav-item {
  font-size: 13px;
  color: var(--text-muted);
  cursor: pointer;
  padding-bottom: 4px;
  position: relative;
  transition: color 0.12s ease;
}

.mcp-subnav-item:hover {
  color: var(--text);
}

.mcp-subnav-item.active {
  color: var(--text);
  font-weight: 600;
}

.mcp-subnav-item.active::after {
  content: '';
  position: absolute;
  bottom: -9px;
  left: 0;
  right: 0;
  height: 2px;
  background: var(--text);
}

.mcp-card-block {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  padding: 14px 16px;
}

.servers-block {
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.mcp-servers-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  border-bottom: 1px solid var(--border);
  padding-bottom: 12px;
}

.servers-heading {
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  color: var(--text);
}

.servers-subtle {
  margin: 3px 0 0;
  font-size: 11.5px;
  color: var(--text-subtle);
}

.servers-head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

.btn-add-mcp {
  background: #111111;
  color: #ffffff;
  border: none;
}

.mcp-add-wrap {
  position: relative;
}

.mcp-add-menu {
  position: absolute;
  right: 0;
  top: calc(100% + 4px);
  display: flex;
  flex-direction: column;
  min-width: 180px;
  padding: 4px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  box-shadow: var(--shadow-sm);
  z-index: 50;
}

.submodal-spacer {
  flex: 1;
}

.mcp-servers-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.mcp-server-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 10px 12px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  transition: all 0.12s ease;
}

.mcp-server-row:hover {
  border-color: var(--border-strong);
}

.mcp-server-row.disabled {
  opacity: 0.6;
}

.server-left {
  display: flex;
  align-items: center;
  gap: 10px;
}

.server-expand-arrow {
  color: var(--text-subtle);
  font-size: 14px;
  cursor: pointer;
}

.server-icon-badge {
  width: 26px;
  height: 26px;
  border-radius: 4px;
  background: #1e1e1e;
  color: #ffffff;
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 10px;
  font-weight: 700;
}

.server-icon-badge.docker { background: #0db7ed; }
.server-icon-badge.chrome { background: #4285f4; }
.server-icon-badge.desktop { background: #2ea043; }
.server-icon-badge.github { background: #24292e; }
.server-icon-badge.fetch { background: #e05d44; }
.server-icon-badge.ddg { background: #de5833; }

.server-meta-col {
  display: flex;
  flex-direction: column;
}

.server-name-row {
  display: flex;
  align-items: center;
  gap: 6px;
}

.server-name-txt {
  font-size: 12.5px;
  font-weight: 500;
  color: var(--text);
  font-family: var(--font-mono, monospace);
}

.server-check-mark {
  color: var(--success);
  font-size: 12px;
  font-weight: bold;
}

.server-warn-pill {
  font-size: 10px;
  background: color-mix(in srgb, var(--warning) 12%, transparent);
  color: var(--warning);
  padding: 1px 6px;
  border-radius: 4px;
}

.server-right-actions {
  display: flex;
  align-items: center;
  gap: 12px;
}

.server-gear-btn {
  background: none;
  border: none;
  font-size: 14px;
  color: var(--text-subtle);
  cursor: pointer;
}

.server-gear-btn:hover {
  color: var(--text);
}

/* ========================================================
   图片 2 样式：电脑控制 (Computer Use)
   ======================================================== */
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

/* ========================================================
   图片 3 样式：浏览器控制 (Browser Automation)
   ======================================================== */
.browser-pane {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.browser-group-block {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.group-title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.browser-group-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--text-muted);
}

.btn-import-data {
  font-size: 11px;
}

.browser-card-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 16px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  gap: 16px;
}

.btn-clear-data {
  color: var(--danger);
  border-color: rgba(207, 34, 46, 0.2);
}

.btn-clear-data:hover {
  background: rgba(207, 34, 46, 0.08);
}

.chrome-conn-item {
  align-items: flex-start;
}

.chrome-link {
  display: inline-block;
  margin-top: 6px;
  font-size: 11.5px;
  color: var(--accent);
  text-decoration: underline;
  cursor: pointer;
}

.chrome-status-badge {
  display: flex;
  align-items: center;
  gap: 5px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  padding: 4px 10px;
  border-radius: var(--radius-sm);
  font-size: 12px;
  font-weight: 500;
  color: var(--text);
  white-space: nowrap;
}

.status-green-dot {
  color: var(--success);
  font-size: 14px;
}

.status-dot-off {
  color: var(--text-muted);
  font-size: 14px;
}

.browser-select-control {
  padding: 6px 12px;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  color: var(--text);
  font-size: 12px;
  outline: none;
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
  background: var(--success);
}

.switch-control input:checked + .switch-slider::before {
  transform: translateX(16px);
}

/* ========================================================
   对标图 4 样式：协同工作模式 (Cowork)
   ======================================================== */
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

.trusted-count-badge {
  margin-left: 8px;
  font-size: 11px;
  background: var(--surface-hover);
  padding: 2px 8px;
  border-radius: 10px;
  color: var(--text-muted);
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

.trusted-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 220px;
  overflow-y: auto;
  margin-bottom: 16px;
}

.trusted-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 7px 10px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 6px;
  font-size: 12px;
}

.trusted-dir-path {
  flex: 1;
  min-width: 0;
  font-family: monospace;
  color: var(--text);
}

.btn-del-trusted {
  background: none;
  border: none;
  color: var(--text-subtle);
  cursor: pointer;
  padding: 2px 6px;
  font-size: 13px;
}

.btn-del-trusted:hover {
  color: var(--danger);
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
.wish-pane,
.lessons-pane {
  gap: 18px;
}

.wish-hero {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  padding: 24px 26px;
  overflow: hidden;
  border-radius: 16px;
  border: 1px solid color-mix(in srgb, var(--accent) 24%, transparent);
  background:
    radial-gradient(circle at 88% 18%, rgba(245, 158, 11, 0.18), transparent 38%),
    linear-gradient(135deg, color-mix(in srgb, var(--accent) 11%, transparent), rgba(247, 247, 248, 0.4));
}

.lessons-hero {
  border-color: rgba(16, 185, 129, 0.24);
  background:
    radial-gradient(circle at 88% 18%, rgba(16, 185, 129, 0.14), transparent 38%),
    linear-gradient(135deg, rgba(16, 185, 129, 0.09), rgba(247, 247, 248, 0.4));
}

.wish-hero-copy {
  position: relative;
  z-index: 1;
}

.wish-kicker {
  display: block;
  margin-bottom: 7px;
  color: var(--accent-strong);
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 1.5px;
}

.lessons-hero .wish-kicker {
  color: var(--success);
}

.wish-hero h2 {
  margin: 0;
  color: var(--text);
  font-size: 22px;
  font-weight: 750;
  letter-spacing: -0.4px;
}

.wish-hero p {
  max-width: 650px;
  margin: 8px 0 0;
  color: var(--text-muted);
  font-size: 12.5px;
  line-height: 1.65;
}

.wish-hero-mark {
  flex: none;
  color: var(--accent);
  font-size: 70px;
  line-height: 1;
  opacity: 0.3;
  transform: rotate(10deg);
}

.lessons-hero .wish-hero-mark {
  color: var(--success);
}

.wish-config-card {
  padding: 18px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface);
}

.wish-section-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.wish-field-grid {
  display: grid;
  grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) 150px;
  gap: 14px;
  align-items: start;
}

.wish-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}

.wish-field .submodal-textarea,
.wish-field .submodal-input {
  margin-bottom: 0;
}

.wish-field-hint {
  color: var(--text-subtle);
  font-size: 11px;
}

/* 许愿模式 MCP 免审批服务勾选 */
.wish-mcp-picks {
  display: flex;
  flex-wrap: wrap;
  gap: 8px 14px;
  margin: 4px 0 10px;
}

.wish-mcp-pick {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--text);
  cursor: pointer;
}

.wish-toolbar {  display: flex;
  align-items: center;
  gap: 8px;
}

.wish-autonomy-hint {
  margin: -4px 0 0;
  padding: 8px 10px;
  border-radius: 7px;
  background: color-mix(in srgb, var(--warning) 10%, transparent);
  color: var(--warning);
  font-size: 11.5px;
}

.wish-toolbar .subtle {
  margin-left: auto;
}

.wish-empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 34px 20px;
  border: 1px dashed var(--border-strong);
  border-radius: 12px;
  background: var(--surface);
  text-align: center;
}

.wish-empty-icon {
  color: var(--accent);
  font-size: 34px;
}

.wish-empty h4 {
  margin: 8px 0 4px;
  color: var(--text);
  font-size: 14px;
}

.wish-empty p {
  margin: 0 0 14px;
  color: var(--text-muted);
  font-size: 12px;
}

.wish-task-list,
.lesson-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.wish-task-card {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface);
  transition: border-color 0.15s ease, transform 0.15s ease;
}

.wish-task-card:hover {
  border-color: color-mix(in srgb, var(--accent) 45%, transparent);
  transform: translateY(-1px);
}

.wish-task-card.disabled {
  opacity: 0.62;
}

.wish-task-main {
  flex: 1;
  min-width: 0;
}

.wish-task-title-row {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 8px;
}

.wish-task-title-row h4 {
  margin: 0;
  color: var(--text);
  font-size: 14px;
  font-weight: 650;
}

.wish-status-pill,
.wish-cycle,
.lesson-scope,
.lesson-confidence {
  padding: 2px 8px;
  border-radius: 999px;
  font-size: 10.5px;
  white-space: nowrap;
}

.wish-status-pill {
  color: var(--text-muted);
  background: var(--bg-elevated);
  border: 1px solid var(--border);
}

.wish-status-pill.status-success {
  color: var(--success);
  background: color-mix(in srgb, var(--success) 10%, transparent);
  border-color: color-mix(in srgb, var(--success) 25%, transparent);
}

.wish-status-pill.status-failed {
  color: var(--danger);
  background: var(--danger-soft);
  border-color: rgba(207, 34, 46, 0.25);
}

.wish-status-pill.status-running {
  color: var(--accent-strong);
  background: rgba(245, 158, 11, 0.1);
  border-color: rgba(245, 158, 11, 0.25);
}

.wish-cycle {
  color: var(--accent-strong);
  background: color-mix(in srgb, var(--accent) 8%, transparent);
}

.wish-task-prompt {
  display: -webkit-box;
  margin: 7px 0;
  overflow: hidden;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.55;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
}

.wish-task-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px 14px;
  color: var(--text-subtle);
  font-size: 11px;
}

.wish-task-meta code {
  color: var(--text-muted);
  font-size: 11px;
}

.wish-task-error {
  margin: 8px 0 0;
  padding: 7px 9px;
  border-radius: 6px;
  background: var(--danger-soft);
  color: var(--danger);
  font-size: 11.5px;
  white-space: pre-wrap;
}

.wish-task-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 4px;
  max-width: 230px;
  flex: none;
}

.wish-run-history {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px dashed var(--border);
}

.wish-run-row {
  display: grid;
  grid-template-columns: 8px 130px 60px minmax(0, 1fr);
  align-items: center;
  gap: 7px;
  color: var(--text-subtle);
  font-size: 10.5px;
}

.wish-run-dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--text-subtle);
}

.wish-run-dot.run-success {
  background: var(--success);
}

.wish-run-dot.run-failed {
  background: var(--danger);
}

.wish-run-dot.run-verifying,
.wish-run-dot.run-running {
  background: var(--warning);
}

.lesson-card {
  padding: 15px 16px;
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface);
}

.lesson-head {
  display: flex;
  align-items: center;
  gap: 8px;
}

.lesson-head h4 {
  flex: 1;
  min-width: 0;
  margin: 0;
  overflow: hidden;
  color: var(--text);
  font-size: 13.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.lesson-scope {
  color: var(--success);
  background: color-mix(in srgb, var(--success) 10%, transparent);
}

.lesson-confidence {
  color: var(--text-muted);
  background: var(--bg-elevated);
}

.lesson-content {
  margin: 8px 0 10px;
  color: var(--text-muted);
  font-size: 12px;
  line-height: 1.6;
  white-space: pre-wrap;
}

.lesson-foot {
  display: flex;
  align-items: center;
  gap: 12px;
  color: var(--text-subtle);
  font-size: 11px;
}

.lesson-foot .text-truncate {
  flex: 1;
  min-width: 0;
}

.wish-path-row,
.wish-form-grid {
  display: flex;
  gap: 8px;
}

.wish-form-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}

.wish-path-row .submodal-input {
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
