<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { AppInfo, UpdateState } from '@shared/types'
import { useChatStore } from '../stores/chat'
import { drawQr } from '../lib/qrcode'
import ProviderSettings from './ProviderSettings.vue'

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
const builtinBrowserEnabled = ref(true)
const externalBrowserEnabled = ref(true)
const chromeConnected = ref(true)
const defaultBrowser = ref<'external' | 'builtin'>('external')
const autoScreenshot = ref(true)

// ========================================================
// 协同 Cowork 模式设置状态 (对标图 4)
// ========================================================
const coworkFilesPath = ref('G:\\尚搏Agent\\workspace')
const trustedFolders = ref<string[]>([
  'G:\\尚搏Agent',
  'C:\\Users\\Administrator\\.gemini\\antigravity\\brain'
])
const showTrustedFoldersModal = ref(false)

const globalInstructions = ref(
  '所有代码一律采用生产级 TypeScript 严格类型与规范；中文为主交互；关键系统改动需提供清晰对比与回溯说明。'
)
const showGlobalInstructionsModal = ref(false)
const editingGlobalInstructions = ref('')

const useMemory = ref(true)
interface MemoryRecord {
  id: string
  title: string
  desc: string
  date: string
}

const memoryItems = ref<MemoryRecord[]>([
  {
    id: 'mem-1',
    title: 'Xiaozhi-server',
    desc: "The user's xiaozhi (小智) AI voice-assistant server deployment — SSH access, service layout, config paths, and the config-web admin tool",
    date: '2026-09-24'
  },
  {
    id: 'mem-2',
    title: '尚搏企业研发工作区架构',
    desc: '本项目为生产级 TypeScript 5.7 + Electron + Vue 3 桌面 Agent 平台，main/providers/localGateway 统管全部模型网关与工具调用。',
    date: '2026-09-25'
  },
  {
    id: 'mem-3',
    title: '对话与代码生成偏好',
    desc: '系统交互全面中文化，保持单测 100% 绿色通过，保证本地 SQLite Token 统计真实性。',
    date: '2026-09-25'
  }
])

const showAddMemoryModal = ref(false)
const newMemoryForm = ref({ title: '', desc: '' })

// 偏好设置表单
const userRole = ref('software')
const customInstructions = ref('')
const chatFont = ref('default')
const reduceMotion = ref(false)
const notifyOnCompletion = ref(true)
const readOnlyReview = ref(false)

// 许愿模式
const wishEnabled = ref(true)
const wishAutoApproveWorkspace = ref(true)
const wishAutoVerify = ref(true)
const wishEvolve = ref(true)
const wishAcceptance = ref('')
const wishVerifyCommand = ref('')
const wishMaxSteps = ref(120)
const wishVerifyRetries = ref(2)
const wishDailyRunLimit = ref(12)

// 自主任务
const autonomousEnabled = ref(false)
const autonomousPaused = ref(false)
const autonomousTasks = ref<import('@shared/types').AutonomousTask[]>([])
const autonomousRuns = ref<Record<string, import('@shared/types').AutonomousRun[]>>({})
const autonomousBusy = ref(false)
const taskEditorOpen = ref(false)
const editingTaskId = ref<string | null>(null)
const taskForm = ref({
  name: '',
  prompt: '',
  acceptance: '',
  workingDir: '',
  schedule: 'interval' as 'manual' | 'interval',
  intervalMinutes: 1440,
  verifyCommand: '',
  maxVerifyAttempts: 2,
  enabled: true,
  maxSteps: 120,
  maxRunsPerDay: 12
})

// 经验库
const lessons = ref<import('@shared/types').Lesson[]>([])
const lessonEditorOpen = ref(false)
const lessonForm = ref({
  title: '',
  content: '',
  scope: 'project' as 'global' | 'project',
  projectPath: '',
  confidence: 0.75
})

// Token 用量统计周期
const usageDays = ref<7 | 30 | 90>(30)

// 供应商页已拆至 ProviderSettings.vue（旧逻辑已清理）
const feedback = ref<{ ok: boolean; message: string } | null>(null)
const appInfo = ref<AppInfo | null>(null)


/* ------------------------------------------------------------------ */
/* 手机远程：开关 / 中转地址 / 审批策略 / 配对 / 设备管理               */
/* ------------------------------------------------------------------ */
interface RemoteDevice {
  id: string
  name: string
  createdAt: number
  lastSeenAt: number | null
}
const remoteEnabled = ref(false)
const remoteRelayUrl = ref('')
const remoteApprovalPolicy = ref<'allow-all' | 'confirm-high' | 'read-only'>('allow-all')
const remoteStatusText = ref('未开启')
const remotePairing = ref<{ qrText: string; code: string; expiresAt: number; fingerprint: string } | null>(null)
const remoteDevices = ref<RemoteDevice[]>([])
const remoteBusy = ref(false)
/** 配对二维码画布：生成配对码后绘制 qrText，手机扫码直达配对页。 */
const qrCanvas = ref<HTMLCanvasElement | null>(null)
const qrFailed = ref(false)

async function loadRemote(): Promise<void> {
  try {
    const st = await window.shangbo.remote.status()
    remoteEnabled.value = st.enabled
    remoteStatusText.value = st.enabled ? `状态：${st.status}${st.detail ? `（${st.detail}）` : ''}` : '未开启'
  } catch {
    remoteStatusText.value = '读取失败'
  }
  try {
    remoteDevices.value = await window.shangbo.remote.devices()
  } catch {
    remoteDevices.value = []
  }
}

async function toggleRemoteEnabled(): Promise<void> {
  await window.shangbo.settings.set('remote.enabled', remoteEnabled.value)
  feedback.value = {
    ok: true,
    message: remoteEnabled.value ? '手机远程已开启：桌面开始连接中转' : '手机远程已关闭：不再产生任何外网连接'
  }
  await loadRemote()
}

async function saveRemoteRelayUrl(): Promise<void> {
  await window.shangbo.settings.set('remote.relayUrl', remoteRelayUrl.value.trim())
  feedback.value = { ok: true, message: '中转地址已保存' }
}

async function saveRemotePolicy(): Promise<void> {
  await window.shangbo.settings.set('remote.approvalPolicy', remoteApprovalPolicy.value)
  feedback.value = { ok: true, message: '远程审批策略已更新' }
}

async function issueRemotePairing(): Promise<void> {
  if (!remoteEnabled.value) {
    feedback.value = { ok: false, message: '请先开启手机远程' }
    return
  }
  remoteBusy.value = true
  try {
    remotePairing.value = await window.shangbo.remote.pair()
    feedback.value = { ok: true, message: '配对码已生成：用手机扫码或手动输入配对码' }
    // 配对区 canvas 可能刚挂载，下一帧再画
    qrFailed.value = false
    await nextTick()
    const canvas = qrCanvas.value
    if (canvas && remotePairing.value) {
      qrFailed.value = !drawQr(canvas, remotePairing.value.qrText, 5)
    } else {
      qrFailed.value = true
    }
  } catch (error) {
    feedback.value = { ok: false, message: error instanceof Error ? error.message : '配对失败' }
  } finally {
    remoteBusy.value = false
  }
}

async function revokeRemoteDevice(id: string): Promise<void> {
  if (!confirm('确定吊销这台手机？吊销后其连接立即断开。')) return
  const ok = await window.shangbo.remote.revoke(id)
  feedback.value = ok ? { ok: true, message: '已吊销' } : { ok: false, message: '吊销失败' }
  await loadRemote()
}

async function disconnectRemoteAll(): Promise<void> {
  if (!confirm('立即断开所有远程设备并关闭远程功能？')) return
  await window.shangbo.remote.disconnect()
  remoteEnabled.value = false
  remotePairing.value = null
  feedback.value = { ok: true, message: '已断开所有远程设备并关闭远程功能' }
  await loadRemote()
}
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
const budgetTokens = ref(32000)
const autoApprove = ref<string[]>([])



async function load(): Promise<void> {
  const settings = await window.shangbo.settings.getAll()
  budgetTokens.value = (settings['agent.contextBudgetTokens'] as number) ?? 32000
  autoApprove.value = (settings['tools.autoApprove'] as string[]) ?? []
  customInstructions.value = (settings['agent.instructions'] as string) ?? ''
  userRole.value = (settings['agent.workRole'] as string) ?? 'software'
  chatFont.value = (settings['agent.chatFont'] as string) ?? 'default'
  reduceMotion.value = (settings['agent.reduceMotion'] as boolean) ?? false
  notifyOnCompletion.value = (settings['agent.notifyCompletion'] as boolean) ?? true
  readOnlyReview.value = (settings['agent.readOnly'] as boolean) ?? false
  wishEnabled.value = (settings['agent.wish.enabled'] as boolean) ?? true
  wishAutoApproveWorkspace.value =
    (settings['agent.wish.autoApproveWorkspace'] as boolean) ?? true
  wishAutoVerify.value = (settings['agent.wish.autoVerify'] as boolean) ?? true
  wishEvolve.value = (settings['agent.wish.evolve'] as boolean) ?? true
  wishAcceptance.value = (settings['agent.wish.acceptance'] as string) ?? ''
  wishVerifyCommand.value = (settings['agent.wish.verifyCommand'] as string) ?? ''
  wishMaxSteps.value = (settings['agent.wishMaxSteps'] as number) ?? 120
  wishVerifyRetries.value = (settings['agent.wish.verifyRetries'] as number) ?? 2
  wishDailyRunLimit.value = (settings['agent.wish.dailyRunLimit'] as number) ?? 12
  autonomousEnabled.value = (settings['agent.autonomous.enabled'] as boolean) ?? false
  computerUseEnabled.value = (settings['agent.computerUse'] as boolean) ?? true
  builtinBrowserEnabled.value = (settings['agent.browser.builtin'] as boolean) ?? true
  externalBrowserEnabled.value = (settings['agent.browser.external'] as boolean) ?? true
  defaultBrowser.value = (settings['agent.browser.default'] as 'external' | 'builtin') ?? 'external'
  autoScreenshot.value = (settings['agent.browser.autoScreenshot'] as boolean) ?? true
  // MCP 开关由 refreshMcp 从主进程实测状态还原，这里只触发拉取（不阻塞）。
  void refreshMcp()
  if (typeof settings['cowork.filesPath'] === 'string') {
    coworkFilesPath.value = settings['cowork.filesPath'] as string
  }
  if (Array.isArray(settings['cowork.trustedFolders'])) {
    trustedFolders.value = settings['cowork.trustedFolders'] as string[]
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
  remoteEnabled.value = (settings['remote.enabled'] as boolean) ?? false
  remoteRelayUrl.value = (settings['remote.relayUrl'] as string) ?? ''
  remoteApprovalPolicy.value =
    (settings['remote.approvalPolicy'] as 'allow-all' | 'confirm-high' | 'read-only') ?? 'allow-all'
  await loadRemote()
  await loadAutonomous()
  await loadLessons()
  await loadPlugins()
  await loadRealUsage()
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

async function addTrustedFolder(): Promise<void> {
  const chosen = await window.shangbo.dialog.pickFolder()
  if (chosen && !trustedFolders.value.includes(chosen)) {
    trustedFolders.value.push(chosen)
    await window.shangbo.settings.set('cowork.trustedFolders', [...trustedFolders.value])
    feedback.value = { ok: true, message: `已添加受信任文件夹：${chosen}` }
  }
}

async function removeTrustedFolder(index: number): Promise<void> {
  trustedFolders.value.splice(index, 1)
  await window.shangbo.settings.set('cowork.trustedFolders', [...trustedFolders.value])
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
    if (!open) return
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

async function saveRole(): Promise<void> {
  await window.shangbo.settings.set('agent.workRole', userRole.value)
}

async function saveFont(): Promise<void> {
  await window.shangbo.settings.set('agent.chatFont', chatFont.value)
}

async function toggleMotion(val: boolean): Promise<void> {
  reduceMotion.value = val
  await window.shangbo.settings.set('agent.reduceMotion', val)
}

async function toggleNotify(val: boolean): Promise<void> {
  notifyOnCompletion.value = val
  await window.shangbo.settings.set('agent.notifyCompletion', val)
}

async function toggleReadOnly(val: boolean): Promise<void> {
  readOnlyReview.value = val
  await window.shangbo.settings.set('agent.readOnly', val)
}

/* ------------------------------------------------------------------ */
/* 许愿模式 / 自主任务 / 经验库                                         */
/* ------------------------------------------------------------------ */

async function saveWishSettings(): Promise<void> {
  await window.shangbo.settings.set('agent.wish.enabled', wishEnabled.value)
  await window.shangbo.settings.set(
    'agent.wish.autoApproveWorkspace',
    wishAutoApproveWorkspace.value
  )
  await window.shangbo.settings.set('agent.wish.autoVerify', wishAutoVerify.value)
  await window.shangbo.settings.set('agent.wish.evolve', wishEvolve.value)
  await window.shangbo.settings.set('agent.wish.acceptance', wishAcceptance.value)
  await window.shangbo.settings.set('agent.wish.verifyCommand', wishVerifyCommand.value)
  await window.shangbo.settings.set('agent.wishMaxSteps', Number(wishMaxSteps.value))
  await window.shangbo.settings.set('agent.wish.verifyRetries', Number(wishVerifyRetries.value))
  await window.shangbo.settings.set('agent.wish.dailyRunLimit', Number(wishDailyRunLimit.value))
  feedback.value = { ok: true, message: '许愿模式设置已保存' }
}

async function toggleAutonomousEnabled(): Promise<void> {
  await window.shangbo.settings.set('agent.autonomous.enabled', autonomousEnabled.value)
  if (autonomousEnabled.value) {
    await window.shangbo.autonomous.resume()
    autonomousPaused.value = false
  }
  feedback.value = {
    ok: true,
    message: autonomousEnabled.value
      ? '自主调度已开启：已启用的周期任务会按计划执行'
      : '自主调度已关闭：已有任务定义保留，但不会自动触发'
  }
}

async function loadAutonomous(): Promise<void> {
  try {
    autonomousTasks.value = await window.shangbo.autonomous.list()
    const status = await window.shangbo.autonomous.status()
    autonomousPaused.value = status.paused
  } catch {
    autonomousTasks.value = []
  }
}

async function loadLessons(): Promise<void> {
  try {
    lessons.value = await window.shangbo.lessons.list()
  } catch {
    lessons.value = []
  }
}

function openNewTask(): void {
  editingTaskId.value = null
  taskForm.value = {
    name: '',
    prompt: '',
    acceptance: wishAcceptance.value,
    workingDir: coworkFilesPath.value,
    schedule: 'interval',
    intervalMinutes: 1440,
    verifyCommand: wishVerifyCommand.value,
    maxVerifyAttempts: wishVerifyRetries.value,
    enabled: true,
    maxSteps: wishMaxSteps.value,
    maxRunsPerDay: wishDailyRunLimit.value
  }
  taskEditorOpen.value = true
}

function editTask(task: import('@shared/types').AutonomousTask): void {
  editingTaskId.value = task.id
  taskForm.value = {
    name: task.name,
    prompt: task.prompt,
    acceptance: task.acceptance,
    workingDir: task.workingDir,
    schedule: task.schedule,
    intervalMinutes: task.intervalMinutes ?? 1440,
    verifyCommand: task.verifyCommand,
    maxVerifyAttempts: task.maxVerifyAttempts,
    enabled: task.enabled,
    maxSteps: task.maxSteps,
    maxRunsPerDay: task.maxRunsPerDay
  }
  taskEditorOpen.value = true
}

async function pickTaskWorkingDir(): Promise<void> {
  const dir = await window.shangbo.dialog.pickFolder()
  if (dir) taskForm.value.workingDir = dir
}

async function saveTask(): Promise<void> {
  if (!taskForm.value.name.trim() || !taskForm.value.prompt.trim()) {
    feedback.value = { ok: false, message: '请填写任务名称与愿望目标' }
    return
  }
  if (!taskForm.value.workingDir.trim()) {
    feedback.value = { ok: false, message: '请选择任务工作目录' }
    return
  }
  autonomousBusy.value = true
  try {
    await window.shangbo.autonomous.save({
      id: editingTaskId.value ?? undefined,
      ...taskForm.value,
      // 任务是否启用与全局调度开关分离：总开关关闭时任务保留启用状态，但不会触发。
      enabled: taskForm.value.enabled,
      intervalMinutes:
        taskForm.value.schedule === 'interval' ? Number(taskForm.value.intervalMinutes) : null
    })
    taskEditorOpen.value = false
    await loadAutonomous()
    feedback.value = { ok: true, message: '自主任务已保存' }
  } catch (error) {
    feedback.value = {
      ok: false,
      message: error instanceof Error ? error.message : '保存自主任务失败'
    }
  } finally {
    autonomousBusy.value = false
  }
}

async function removeTask(task: import('@shared/types').AutonomousTask): Promise<void> {
  if (!confirm(`删除自主任务「${task.name}」？运行历史会一并删除。`)) return
  await window.shangbo.autonomous.remove(task.id)
  await loadAutonomous()
}

async function toggleTask(task: import('@shared/types').AutonomousTask): Promise<void> {
  await window.shangbo.autonomous.setEnabled(task.id, !task.enabled)
  await loadAutonomous()
}

async function runTaskNow(task: import('@shared/types').AutonomousTask): Promise<void> {
  autonomousBusy.value = true
  try {
    const result = await window.shangbo.autonomous.runNow(task.id)
    feedback.value = { ok: true, message: `任务已启动，可在会话中查看进度` }
    await store.openConversation(result.conversationId)
    close()
  } catch (error) {
    feedback.value = {
      ok: false,
      message: error instanceof Error ? error.message : '启动任务失败'
    }
  } finally {
    autonomousBusy.value = false
  }
}

async function loadTaskRuns(taskId: string): Promise<void> {
  autonomousRuns.value = {
    ...autonomousRuns.value,
    [taskId]: await window.shangbo.autonomous.runs(taskId)
  }
}

async function toggleAutonomousPause(): Promise<void> {
  if (autonomousPaused.value) await window.shangbo.autonomous.resume()
  else await window.shangbo.autonomous.pause()
  autonomousPaused.value = !autonomousPaused.value
}

function openNewLesson(): void {
  lessonForm.value = {
    title: '',
    content: '',
    scope: 'project',
    projectPath: store.activeConversation?.workingDir ?? '',
    confidence: 0.75
  }
  lessonEditorOpen.value = true
}

async function saveLesson(): Promise<void> {
  if (!lessonForm.value.title.trim() || !lessonForm.value.content.trim()) {
    feedback.value = { ok: false, message: '请填写经验标题与内容' }
    return
  }
  await window.shangbo.lessons.save({
    title: lessonForm.value.title,
    content: lessonForm.value.content,
    scope: lessonForm.value.scope,
    projectPath: lessonForm.value.scope === 'project' ? lessonForm.value.projectPath : null,
    confidence: Number(lessonForm.value.confidence)
  })
  lessonEditorOpen.value = false
  await loadLessons()
  feedback.value = { ok: true, message: '经验已保存，后续许愿任务会自动复用' }
}

async function removeLesson(id: string): Promise<void> {
  if (!confirm('删除这条经验？')) return
  await window.shangbo.lessons.remove(id)
  await loadLessons()
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

// 真实 Token 统计账本 (100% 取自本地 SQLite 数据库，无任何假数据)
const realUsageStats = ref<import('@shared/types').UsageSummaryStats | null>(null)

async function loadRealUsage(): Promise<void> {
  try {
    realUsageStats.value = await window.shangbo.usage.getStats(usageDays.value)
  } catch (error) {
    console.error('加载真实 Token 统计失败:', error)
  }
}

watch(usageDays, () => {
  void loadRealUsage()
})

function formatTokensNumber(tokens: number): string {
  if (!tokens || tokens === 0) return '0'
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(2)}M`
  }
  if (tokens >= 1_000) {
    return `${(tokens / 1_000).toFixed(1)}k`
  }
  return String(tokens)
}

const maxDailyTokens = computed(() => {
  if (!realUsageStats.value || realUsageStats.value.dailyList.length === 0) return 1
  const max = Math.max(...realUsageStats.value.dailyList.map((d) => d.totalTokens))
  return max > 0 ? max : 1
})

async function saveBudgetTokens(): Promise<void> {
  await window.shangbo.settings.set('agent.contextBudgetTokens', Number(budgetTokens.value))
  feedback.value = { ok: true, message: `已保存上下文预算上限: ${Number(budgetTokens.value).toLocaleString()} tokens` }
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
  } catch {
    // 忽略
  }
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

async function copyPrompt(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    feedback.value = { ok: true, message: '示例提问已复制到剪贴板' }
    setTimeout(() => (feedback.value = null), 2000)
  } catch {
    // 忽略
  }
}

// ========================================================
// MCP Servers 管理（实测驱动：列表、状态、工具数全部来自主进程）
// ========================================================
export interface McpServerItem {
  id: string
  name: string
  enabled: boolean
  state: 'ready' | 'error' | 'disabled'
  toolCount: number
  tools: { name: string; description?: string }[]
  error?: string
}

const mcpServers = ref<McpServerItem[]>([])
const mcpLoading = ref(false)
const expandedMcp = ref<string | null>(null)

/** 拉取实时状态（会按需拉起服务进程，首次可能慢，不阻塞设置页打开）。 */
async function refreshMcp(): Promise<void> {
  if (mcpLoading.value) return
  mcpLoading.value = true
  try {
    mcpServers.value = await window.shangbo.mcp.status()
  } catch {
    mcpServers.value = []
  } finally {
    mcpLoading.value = false
  }
}

async function toggleMcpServer(item: McpServerItem): Promise<void> {
  item.enabled = !item.enabled
  const enabledIds = mcpServers.value.filter((s) => s.enabled).map((s) => s.id)
  await window.shangbo.settings.set('agent.mcpServers', enabledIds)
  feedback.value = {
    ok: true,
    message: item.enabled ? `已启用 MCP 服务「${item.name}」` : `已停用 MCP 服务「${item.name}」`
  }
  setTimeout(() => (feedback.value = null), 2000)
  void refreshMcp()
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

async function toggleBuiltinBrowser(): Promise<void> {
  builtinBrowserEnabled.value = !builtinBrowserEnabled.value
  await window.shangbo.settings.set('agent.browser.builtin', builtinBrowserEnabled.value)
}

async function toggleExternalBrowser(): Promise<void> {
  externalBrowserEnabled.value = !externalBrowserEnabled.value
  await window.shangbo.settings.set('agent.browser.external', externalBrowserEnabled.value)
}

async function saveDefaultBrowser(): Promise<void> {
  await window.shangbo.settings.set('agent.browser.default', defaultBrowser.value)
}

async function toggleAutoScreenshot(): Promise<void> {
  autoScreenshot.value = !autoScreenshot.value
  await window.shangbo.settings.set('agent.browser.autoScreenshot', autoScreenshot.value)
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

            <div class="setting-row">
              <div class="row-text">
                <span class="setting-label">你的主要工作领域？</span>
              </div>
              <select v-model="userRole" class="select-control" @change="saveRole">
                <option value="software">软件研发与系统架构</option>
                <option value="fullstack">全栈开发与前端工程</option>
                <option value="data">数据分析与算法模型</option>
                <option value="product">产品与项目管理</option>
                <option value="general">学术研究与通用办公</option>
              </select>
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
              <span class="setting-label">对话字体</span>
              <select v-model="chatFont" class="select-control" @change="saveFont">
                <option value="default">系统默认无衬线字体</option>
                <option value="mono">等宽代码字体 (JetBrains Mono)</option>
                <option value="serif">经典衬线阅读体 (Serif)</option>
              </select>
            </div>

            <div class="setting-row">
              <div class="row-text">
                <span class="setting-label">界面动效 (Motion)</span>
                <span class="row-sub">减弱流式输出与界面元素的过渡动画</span>
              </div>
              <div class="segmented-control">
                <button
                  class="seg-btn text-seg"
                  :class="{ active: !reduceMotion }"
                  @click="toggleMotion(false)"
                >
                  跟随系统
                </button>
                <button
                  class="seg-btn text-seg"
                  :class="{ active: reduceMotion }"
                  @click="toggleMotion(true)"
                >
                  减弱动画
                </button>
              </div>
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

          <!-- Agent 执行与安全策略 (步数上限已移除：循环到模型收手为止，防打转只靠行为保险丝) -->
          <div class="section-block">
            <h3 class="pane-title">执行与安全策略 (Execution & Safety)</h3>

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
        <section v-if="activeTab === 'privacy'" class="content-pane">
          <div class="privacy-banner-card">
            <p class="banner-text">
              您当前正通过本机及您指定的推理提供商（127.0.0.1 / 本地私有网关）运行尚搏 Agent。您的所有会话、文件与工作区内容均直接发送至您配置的端点，绝不会被转存或上传至任何第三方云端。
            </p>

            <div class="privacy-item-group">
              <h4 class="privacy-group-title">完全留在本机的核心隐私数据（绝不外传）：</h4>
              <ul class="privacy-bullet-list">
                <li>您的提问 Prompt、助手的回答及完整的会话历史树</li>
                <li>您的本地工程文件、代码内容及工作区目录数据</li>
                <li>您的本机操作系统账户与身份细节</li>
              </ul>
            </div>

            <div class="privacy-item-group">
              <h4 class="privacy-group-title">网关及调试诊断信息（仅本地安全保管）：</h4>
              <ul class="privacy-bullet-list">
                <li>本机运行时错误与崩溃诊断日志，用于故障定位</li>
                <li>匿名 Token 用量统计（仅计数，不包含对话文本正文）</li>
                <li>客户端版本更新检查请求，确保功能及时更新</li>
                <li>仅在您显式导出时才生成本地诊断报告</li>
              </ul>
            </div>
          </div>
        </section>

        <!-- ========================================================
             3. Token 用量统计 (图片 5 对标实现)
             ======================================================== -->
        <section v-if="activeTab === 'usage'" class="content-pane">
          <div class="usage-head">
            <p class="usage-desc">
              本设备在对话协同与代码模式下的 Token 用量统计。实际费用按您配置的模型供应商官方费率结算。
            </p>
            <div class="days-toggle">
              <button
                class="day-btn"
                :class="{ active: usageDays === 7 }"
                @click="usageDays = 7"
              >
                7天
              </button>
              <button
                class="day-btn"
                :class="{ active: usageDays === 30 }"
                @click="usageDays = 30"
              >
                30天
              </button>
              <button
                class="day-btn"
                :class="{ active: usageDays === 90 }"
                @click="usageDays = 90"
              >
                90天
              </button>
            </div>
          </div>

          <!-- 真实三卡片统计展示 -->
          <div class="usage-metric-cards">
            <div class="metric-card">
              <div class="metric-title">协同模式 (Cowork)</div>
              <div class="metric-value">
                {{ formatTokensNumber(realUsageStats?.coworkTokens ?? 0) }}
                <span class="metric-unit">tokens</span>
              </div>
              <div class="metric-sub subtle">日常问答与多轮对话消耗</div>
            </div>

            <div class="metric-card">
              <div class="metric-title">代码模式 (Code)</div>
              <div class="metric-value">
                {{ formatTokensNumber(realUsageStats?.codeTokens ?? 0) }}
                <span class="metric-unit">tokens</span>
              </div>
              <div class="metric-sub subtle">
                {{ realUsageStats?.toolCallsCount ?? 0 }} 次工具与终端命令调用
              </div>
            </div>

            <div class="metric-card highlight-card">
              <div class="metric-title">近 {{ usageDays }} 天真实总消耗</div>
              <div class="metric-value">
                {{ formatTokensNumber(realUsageStats?.totalTokens ?? 0) }}
                <span class="metric-unit">tokens</span>
              </div>
              <div class="metric-sub subtle">
                输入: {{ formatTokensNumber(realUsageStats?.dailyList.reduce((acc, d) => acc + d.promptTokens, 0) ?? 0) }} · 
                输出: {{ formatTokensNumber(realUsageStats?.dailyList.reduce((acc, d) => acc + d.completionTokens, 0) ?? 0) }}
              </div>
            </div>
          </div>

          <!-- 每日用量图表 (Tokens per day) -->
          <div class="usage-chart-card">
            <div class="chart-header">
              <div class="chart-title-area">
                <h4 class="chart-heading">每日真实 Token 用量 (Tokens per day)</h4>
                <p class="chart-sub subtle">过去 {{ usageDays }} 天各模式输入与输出真实统计 (无任何虚拟数据)</p>
              </div>
              <div class="chart-legend">
                <span class="legend-item"><span class="legend-box cowork-box" /> 协同模式</span>
                <span class="legend-item"><span class="legend-box code-box" /> 代码模式</span>
              </div>
            </div>

            <!-- 直方柱状图 -->
            <div class="histogram-wrapper">
              <div class="histogram-bars">
                <div
                  v-for="(day, index) in (realUsageStats?.dailyList ?? [])"
                  :key="index"
                  class="histogram-col"
                  :title="`${day.fullDate} | 协同: ${day.coworkTokens} tokens, 代码: ${day.codeTokens} tokens (合计: ${day.totalTokens})`"
                >
                  <div class="bar-stack">
                    <div
                      class="bar-segment code-segment"
                      :style="{
                        height: `${day.codeTokens > 0 ? Math.max(3, Math.round((day.codeTokens / maxDailyTokens) * 95)) : 0}px`
                      }"
                    />
                    <div
                      class="bar-segment cowork-segment"
                      :style="{
                        height: `${day.coworkTokens > 0 ? Math.max(3, Math.round((day.coworkTokens / maxDailyTokens) * 95)) : 0}px`
                      }"
                    />
                    <!-- 当天无数据时的占位小底线 -->
                    <div v-if="day.totalTokens === 0" class="bar-empty-dot" />
                  </div>
                  <span v-if="index % Math.ceil(usageDays / 8) === 0 || index === (realUsageStats?.dailyList.length ?? 0) - 1" class="date-label">
                    {{ day.date }}
                  </span>
                </div>
              </div>
            </div>
          </div>

          <!-- 上下文 Token 预算与安全控制 (回答“能不能设置用了多少token”) -->
          <div class="section-block">
            <h4 class="pane-title">上下文 Token 预算与防耗控制</h4>
            <div class="setting-row">
              <div class="row-text">
                <span class="setting-label">单会话上下文预算上限 (Context Window Budget)</span>
                <span class="row-sub">当对话历史累积接近该阈值时，自动压缩早期的工具细节与中间推理，保护 Token 额度并防止溢出</span>
              </div>
              <select v-model="budgetTokens" class="select-control" @change="saveBudgetTokens">
                <option :value="16000">16,000 tokens (轻量经济)</option>
                <option :value="32000">32,000 tokens (标准默认)</option>
                <option :value="64000">64,000 tokens (中等代码库)</option>
                <option :value="128000">128,000 tokens (大型项目工程)</option>
                <option :value="200000">200,000 tokens (Claude 原生满血)</option>
                <option :value="1000000">1,000,000 tokens (1M 极限长文本)</option>
              </select>
            </div>
          </div>
        </section>

        <!-- ========================================================
             4. 模型与推理网关 (Providers)
             ======================================================== -->
        <section v-if="activeTab === 'providers'" class="content-pane provider-redesign">
          <ProviderSettings />
        </section>

        <!-- ========================================================
             4b. 许愿与自主运行
             ======================================================== -->
        <section v-if="activeTab === 'autonomous'" class="content-pane wish-pane">
          <div class="wish-hero">
            <div class="wish-hero-copy">
              <span class="wish-kicker">WISH-DRIVEN PROGRAMMING</span>
              <h2>把愿望编译成可验收的工程流程</h2>
              <p>
                你只写目标与验收标准。Agent 在工作区内自动规划、修改、运行测试、读取报错并修复；
                主进程再用真实命令验收，通过后才算完成。
              </p>
            </div>
            <div class="wish-hero-mark">✦</div>
          </div>

          <div class="section-block wish-config-card">
            <div class="wish-section-head">
              <div>
                <h3 class="pane-title">许愿模式</h3>
                <p class="row-sub">作用于普通会话；自主任务始终以许愿模式运行。</p>
              </div>
              <label class="switch-control">
                <input v-model="wishEnabled" type="checkbox" @change="saveWishSettings" />
                <span class="switch-slider" />
              </label>
            </div>

            <div class="setting-row">
              <div class="row-text">
                <span class="setting-label">工作区内免审批</span>
                <span class="row-sub">
                  读写与命令只在当前项目目录内自动放行；工作区外、密钥库、数据库与不可逆系统操作仍会被拦截。
                </span>
              </div>
              <label class="switch-control">
                <input
                  v-model="wishAutoApproveWorkspace"
                  type="checkbox"
                  @change="saveWishSettings"
                />
                <span class="switch-slider" />
              </label>
            </div>

            <div class="setting-row">
              <div class="row-text">
                <span class="setting-label">自动验收</span>
                <span class="row-sub">任务完成后由主进程执行验收命令；失败自动带着错误继续修复。</span>
              </div>
              <label class="switch-control">
                <input v-model="wishAutoVerify" type="checkbox" @change="saveWishSettings" />
                <span class="switch-slider" />
              </label>
            </div>

            <div class="setting-row">
              <div class="row-text">
                <span class="setting-label">经验进化</span>
                <span class="row-sub">通过验收的任务沉淀为项目经验，后续同类任务自动注入。</span>
              </div>
              <label class="switch-control">
                <input v-model="wishEvolve" type="checkbox" @change="saveWishSettings" />
                <span class="switch-slider" />
              </label>
            </div>

            <div class="wish-field-grid">
              <label class="wish-field">
                <span class="field-label">默认验收标准</span>
                <textarea
                  v-model="wishAcceptance"
                  class="submodal-textarea"
                  rows="3"
                  placeholder="例如：npm test 全绿；npm run typecheck 通过；不新增依赖。"
                  @blur="saveWishSettings"
                />
              </label>
              <label class="wish-field">
                <span class="field-label">默认验收命令</span>
                <input
                  v-model="wishVerifyCommand"
                  class="submodal-input"
                  placeholder="例如：npm run typecheck && npm test"
                  @blur="saveWishSettings"
                />
                <span class="wish-field-hint">在主进程执行，不经过模型；超时 10 分钟。</span>
              </label>
              <label class="wish-field">
                <span class="field-label">单轮最大步数</span>
                <input
                  v-model.number="wishMaxSteps"
                  class="submodal-input"
                  type="number"
                  min="1"
                  max="500"
                  @blur="saveWishSettings"
                />
              </label>
              <label class="wish-field">
                <span class="field-label">验收失败自动修复次数</span>
                <input
                  v-model.number="wishVerifyRetries"
                  class="submodal-input"
                  type="number"
                  min="0"
                  max="10"
                  @blur="saveWishSettings"
                />
              </label>
              <label class="wish-field">
                <span class="field-label">每个任务每日运行上限</span>
                <input
                  v-model.number="wishDailyRunLimit"
                  class="submodal-input"
                  type="number"
                  min="1"
                  max="100"
                  @blur="saveWishSettings"
                />
              </label>
            </div>
          </div>

          <div class="divider" />

          <div class="section-block">
            <div class="wish-section-head">
              <div>
                <h3 class="pane-title">自主运行</h3>
                <p class="row-sub">
                  应用常驻托盘后按计划执行。关闭窗口不会停止任务；可在托盘或这里一键暂停。
                </p>
              </div>
              <label class="switch-control">
                <input
                  v-model="autonomousEnabled"
                  type="checkbox"
                  @change="toggleAutonomousEnabled"
                />
                <span class="switch-slider" />
              </label>
            </div>

            <p v-if="!autonomousEnabled" class="wish-autonomy-hint">
              总调度当前关闭：任务会保存但不会自动触发；可用“立即运行”手动执行。
            </p>

            <div class="wish-toolbar">
              <button
                class="btn tiny"
                :class="autonomousPaused ? 'btn-primary' : 'btn-ghost'"
                @click="toggleAutonomousPause"
              >
                {{ autonomousPaused ? '继续调度' : '全局暂停' }}
              </button>
              <button class="btn btn-primary tiny" @click="openNewTask">＋ 新建自主任务</button>
              <span class="subtle">{{ autonomousTasks.length }} 个任务</span>
            </div>

            <div v-if="autonomousTasks.length === 0" class="wish-empty">
              <span class="wish-empty-icon">✧</span>
              <h4>还没有自主任务</h4>
              <p>先写一个愿望，再给它一个周期和验收命令。</p>
              <button class="btn btn-primary tiny" @click="openNewTask">创建第一个任务</button>
            </div>

            <div v-else class="wish-task-list">
              <article
                v-for="task in autonomousTasks"
                :key="task.id"
                class="wish-task-card"
                :class="{ disabled: !task.enabled }"
              >
                <div class="wish-task-main">
                  <div class="wish-task-title-row">
                    <h4>{{ task.name }}</h4>
                    <span class="wish-status-pill" :class="`status-${task.lastStatus ?? 'idle'}`">
                      {{ task.lastStatus === 'success' ? '已验收' : task.lastStatus === 'failed' ? '失败' : task.lastStatus === 'running' ? '执行中' : task.enabled ? '待执行' : '已停用' }}
                    </span>
                    <span v-if="task.schedule === 'interval'" class="wish-cycle">
                      每 {{ task.intervalMinutes }} 分钟
                    </span>
                  </div>
                  <p class="wish-task-prompt">{{ task.prompt }}</p>
                  <div class="wish-task-meta">
                    <span class="mono">{{ task.workingDir }}</span>
                    <span v-if="task.verifyCommand">验收：<code>{{ task.verifyCommand }}</code></span>
                    <span>今日 {{ task.maxRunsPerDay }} 次上限</span>
                  </div>
                  <p v-if="task.lastError" class="wish-task-error">{{ task.lastError }}</p>
                  <div v-if="autonomousRuns[task.id]?.length" class="wish-run-history">
                    <div
                      v-for="run in autonomousRuns[task.id].slice(0, 5)"
                      :key="run.id"
                      class="wish-run-row"
                    >
                      <span class="wish-run-dot" :class="`run-${run.status}`" />
                      <span>{{ new Date(run.startedAt).toLocaleString() }}</span>
                      <span>{{ run.status }}</span>
                      <span class="text-truncate">{{ run.summary || run.error || '' }}</span>
                    </div>
                  </div>
                </div>
                <div class="wish-task-actions">
                  <button class="btn btn-ghost tiny" :disabled="autonomousBusy" @click="runTaskNow(task)">
                    立即运行
                  </button>
                  <button class="btn btn-ghost tiny" @click="editTask(task)">编辑</button>
                  <button class="btn btn-ghost tiny" @click="loadTaskRuns(task.id)">历史</button>
                  <button class="btn btn-ghost tiny" @click="toggleTask(task)">
                    {{ task.enabled ? '停用' : '启用' }}
                  </button>
                  <button class="btn btn-ghost tiny btn-danger" @click="removeTask(task)">删除</button>
                </div>
              </article>
            </div>
          </div>
        </section>

        <!-- ========================================================
             4c. 经验进化
             ======================================================== -->
        <section v-if="activeTab === 'lessons'" class="content-pane lessons-pane">
          <div class="wish-hero lessons-hero">
            <div class="wish-hero-copy">
              <span class="wish-kicker">VERIFIED EXPERIENCE</span>
              <h2>只沉淀经过验收的经验</h2>
              <p>
                失败路径不会写进经验库。许愿任务通过真实验收后，会生成一条项目级经验；
                后续任务自动带上，避免反复踩同一个坑。
              </p>
            </div>
            <div class="wish-hero-mark">◎</div>
          </div>

          <div class="wish-toolbar">
            <button class="btn btn-primary tiny" @click="openNewLesson">＋ 手动添加经验</button>
            <button class="btn btn-ghost tiny" @click="loadLessons">刷新</button>
          </div>

          <div v-if="lessons.length === 0" class="wish-empty">
            <span class="wish-empty-icon">◎</span>
            <h4>还没有已验证经验</h4>
            <p>先运行一个带验收命令的许愿任务，或手动记录项目规范。</p>
          </div>

          <div v-else class="lesson-list">
            <article v-for="lesson in lessons" :key="lesson.id" class="lesson-card">
              <div class="lesson-head">
                <span class="lesson-scope">{{ lesson.scope === 'project' ? '项目' : '全局' }}</span>
                <h4>{{ lesson.title }}</h4>
                <span class="lesson-confidence">{{ Math.round(lesson.confidence * 100) }}%</span>
              </div>
              <p class="lesson-content">{{ lesson.content }}</p>
              <div class="lesson-foot">
                <span v-if="lesson.projectPath" class="mono text-truncate">{{ lesson.projectPath }}</span>
                <span>已复用 {{ lesson.useCount }} 次</span>
                <button class="btn btn-ghost tiny btn-danger" @click="removeLesson(lesson.id)">
                  删除
                </button>
              </div>
            </article>
          </div>
        </section>

        <!-- ========================================================
             5. 常规与开发者选项 (General / Developer)
             ======================================================== -->
        <section v-if="activeTab === 'general' || activeTab === 'developer'" class="content-pane">
          <div class="section-block">
            <h3 class="pane-title">客户端与系统信息</h3>
            <div v-if="appInfo" class="info-grid">
              <div class="info-item"><span class="info-k">应用名称:</span> <span class="info-v">{{ appInfo.name }}</span></div>
              <div class="info-item"><span class="info-k">客户端版本:</span> <span class="info-v">{{ appInfo.version }}</span></div>
              <div class="info-item"><span class="info-k">Electron 版本:</span> <span class="info-v mono">{{ appInfo.electron }}</span></div>
              <div class="info-item"><span class="info-k">Node 运行时:</span> <span class="info-v mono">{{ appInfo.node }}</span></div>
              <div class="info-item"><span class="info-k">本地数据库:</span> <span class="info-v mono text-truncate" :title="appInfo.dbPath">{{ appInfo.dbPath }}</span></div>
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
        <section v-if="activeTab === 'remote'" class="content-pane">
          <div class="section-block">
            <h3 class="pane-title">手机远程</h3>
            <p class="row-sub">
              在外网用手机查看会话、发消息、批准高危命令。桌面主动外连中转服务，两边都不用开放端口；
              所有业务经端到端加密，中转只转发密文。默认关闭，开启后才产生外网连接。
            </p>

            <div class="setting-row">
              <div class="row-text">
                <span class="setting-label">开启手机远程</span>
                <span class="row-sub">{{ remoteStatusText }}</span>
              </div>
              <label class="switch-control">
                <input v-model="remoteEnabled" type="checkbox" @change="toggleRemoteEnabled" />
                <span class="switch-slider" />
              </label>
            </div>

            <div class="setting-row">
              <div class="row-text">
                <span class="setting-label">中转地址</span>
                <span class="row-sub">wss:// 开头。留空则不连接；可填自己的自建中转（relay/docker-compose.yml 一键启动）。</span>
              </div>
            </div>
            <div class="setting-row">
              <input
                v-model="remoteRelayUrl"
                type="text"
                class="select-control mono"
                placeholder="wss://relay.example.com"
                style="flex: 1"
              />
              <button class="btn btn-ghost tiny" @click="saveRemoteRelayUrl">保存</button>
            </div>

            <div class="setting-row">
              <div class="row-text">
                <span class="setting-label">远程审批策略</span>
                <span class="row-sub">允许所有 / 高危回桌面确认 / 完全只读（只能看不能操作）。</span>
              </div>
              <select v-model="remoteApprovalPolicy" class="select-control" @change="saveRemotePolicy">
                <option value="allow-all">允许所有审批</option>
                <option value="confirm-high">高危必须回桌面确认</option>
                <option value="read-only">完全只读</option>
              </select>
            </div>
          </div>

          <div class="divider" />

          <div class="section-block">
            <h3 class="pane-title">配对新手机</h3>
            <div class="setting-row">
              <div class="row-text">
                <span class="setting-label">一次性配对码</span>
                <span class="row-sub">5 分钟有效、只能用一次。手机扫码或手动输入配对码完成密钥交换。</span>
              </div>
              <button class="btn btn-primary tiny" :disabled="remoteBusy || !remoteEnabled" @click="issueRemotePairing">
                {{ remoteBusy ? '生成中…' : '生成配对码' }}
              </button>
            </div>
            <div v-if="remotePairing" class="remote-pair-box">
              <div class="remote-qr">
                <canvas ref="qrCanvas" class="remote-qr-canvas" />
                <p v-if="qrFailed" class="row-sub">二维码绘制失败，请手动输入配对码。</p>
              </div>
              <div class="info-grid">
                <div class="info-item"><span class="info-k">配对码:</span> <span class="info-v mono remote-code">{{ remotePairing.code }}</span></div>
                <div class="info-item"><span class="info-k">桌面公钥指纹:</span> <span class="info-v mono">{{ remotePairing.fingerprint }}</span></div>
                <div class="info-item"><span class="info-k">有效期至:</span> <span class="info-v">{{ new Date(remotePairing.expiresAt).toLocaleString() }}</span></div>
              </div>
            </div>
          </div>

          <div class="divider" />

          <div class="section-block">
            <h3 class="pane-title">已配对手机（{{ remoteDevices.length }}）</h3>
            <div v-if="remoteDevices.length === 0" class="row-sub">暂无已配对手机。</div>
            <div v-for="d in remoteDevices" :key="d.id" class="setting-row">
              <div class="row-text">
                <span class="setting-label">{{ d.name || '未命名手机' }}</span>
                <span class="row-sub">配对 {{ new Date(d.createdAt).toLocaleString() }} · 上次在线 {{ d.lastSeenAt ? new Date(d.lastSeenAt).toLocaleString() : '从未' }}</span>
              </div>
              <button class="btn btn-ghost tiny btn-danger" @click="revokeRemoteDevice(d.id)">吊销</button>
            </div>
            <div class="setting-row">
              <div class="row-text">
                <span class="setting-label">一键断开</span>
                <span class="row-sub">立即断开所有远程设备并关闭远程功能。</span>
              </div>
              <button class="btn btn-ghost tiny btn-danger" @click="disconnectRemoteAll">立即断开</button>
            </div>
          </div>
        </section>

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
              <button class="btn btn-ghost tiny" title="浏览官方扩展生态市场">发现 (Discover)</button>
              <button class="btn btn-primary tiny btn-add-plugin" title="从 GitHub 仓库或本地目录添加扩展插件">
                添加 (Add) ▾
              </button>
            </div>
          </div>

          <!-- 第二行：标签筛选与排序栏 (图片 2 次栏) -->
          <div class="plugins-filter-bar">
            <div class="filter-left">
              <button class="filter-tab-pill active">
                已安装插件 (Your plugins)
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
            <span class="repo-badge-text">1476989162/shangbo-agent</span>
            <span class="repo-badge-status">本地插件宿主就绪</span>
          </div>

          <!-- 分组标题：来自官方与合作伙伴 (图片 2 分组) -->
          <div class="plugins-group-heading">
            <span>来自官方与合作伙伴 · {{ filteredPlugins.length }} (From Anthropic & Partners · {{ filteredPlugins.length }})</span>
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
                    {{ item.enabled ? '已启用 Enabled' : '已禁用 Disabled' }}
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

          <!-- 技能使用与能力说明提示底栏 -->
          <div class="plugin-footer-note">
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
        <section v-if="activeTab === 'connectors'" class="content-pane mcp-pane">
          <!-- 顶部子标签栏 (插件 12 | 技能 89 | MCP 12 | 应用授权 2) -->
          <div class="mcp-subnav-row">
            <span class="mcp-subnav-item" @click="activeTab = 'plugins'">插件 12</span>
            <span class="mcp-subnav-item" @click="activeTab = 'skills'">技能 89</span>
            <span class="mcp-subnav-item active">MCP 12</span>
            <span class="mcp-subnav-item" @click="activeTab = 'privacy'">应用授权 2</span>
          </div>

          <!-- 项目级配置卡片 -->
          <div class="mcp-card-block">
            <div class="setting-row">
              <div class="row-text">
                <span class="setting-label">启用项目级 MCP</span>
                <span class="row-sub">允许自动从项目根目录下的 .trae/mcp.json 或 .mcp.json 中加载 MCP 配置</span>
              </div>
              <input type="checkbox" checked class="toggle-switch" />
            </div>
          </div>

          <!-- 已配置的 MCP Servers 主面板 -->
          <div class="mcp-card-block servers-block">
            <div class="mcp-servers-head">
              <div class="servers-head-text">
                <h4 class="servers-heading">MCP Servers 管理</h4>
                <p class="servers-subtle">管理您已添加的 MCP 服务端，可启用、配置或添加新的工具能力。</p>
              </div>
              <div class="servers-head-actions">
                <button class="btn btn-ghost tiny" title="刷新服务状态" @click="refreshMcp">↻</button>
                <button class="btn btn-primary tiny btn-add-mcp">+ 添加 ▾</button>
              </div>
            </div>

            <!-- MCP Servers 列表（状态与工具数全部实测，点击展开看工具） -->
            <div v-if="mcpLoading && mcpServers.length === 0" class="servers-subtle">正在检测服务状态…</div>
            <div class="mcp-servers-list">
              <div
                v-for="server in mcpServers"
                :key="server.id"
                class="mcp-server-row"
                :class="{ disabled: !server.enabled }"
              >
                <div class="server-left" @click="expandedMcp = expandedMcp === server.id ? null : server.id">
                  <span class="server-expand-arrow">{{ expandedMcp === server.id ? '▾' : '›' }}</span>
                  <div class="server-icon-badge">
                    <span>{{ server.name.slice(0, 2).toUpperCase() }}</span>
                  </div>
                  <div class="server-meta-col">
                    <div class="server-name-row">
                      <span class="server-name-txt">{{ server.name }}</span>
                      <span v-if="server.state === 'ready'" class="server-check-mark" :title="`服务已就绪（${server.toolCount} 个工具）`">✓ {{ server.toolCount }}</span>
                      <span v-else-if="server.state === 'error'" class="server-warn-pill" :title="server.error ?? '启动失败'">⚠ 未就绪</span>
                      <span v-else class="servers-subtle">已停用</span>
                    </div>
                    <div v-if="expandedMcp === server.id" class="servers-subtle">
                      <div v-if="server.error" :title="server.error">{{ server.error }}</div>
                      <div v-for="tool in server.tools" :key="tool.name" :title="tool.description ?? tool.name">
                        · {{ tool.name }}
                      </div>
                      <div v-if="server.state === 'ready' && server.tools.length === 0">（未返回工具）</div>
                    </div>
                  </div>
                </div>

                <div class="server-right-actions">
                  <button class="server-gear-btn" title="配置服务器参数">⚙</button>
                  <label class="switch-control">
                    <input
                      type="checkbox"
                      :checked="server.enabled"
                      @change="toggleMcpServer(server)"
                    />
                    <span class="switch-slider" />
                  </label>
                </div>
              </div>
            </div>
          </div>
        </section>

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
              <button class="btn btn-ghost tiny btn-import-data">导入…</button>
            </div>

            <div class="browser-card-item">
              <div class="row-text">
                <span class="card-main-title">允许 AI 控制内置浏览器</span>
                <span class="card-desc">允许 AI 助手在内置浏览器中自动执行网页浏览任务</span>
              </div>
              <label class="switch-control">
                <input
                  type="checkbox"
                  :checked="builtinBrowserEnabled"
                  @change="toggleBuiltinBrowser"
                />
                <span class="switch-slider" />
              </label>
            </div>

            <div class="browser-card-item">
              <div class="row-text">
                <span class="card-main-title">浏览器数据</span>
                <span class="card-desc">内置浏览器中的站点数据（如 Cookies、本地存储等）</span>
              </div>
              <button class="btn btn-ghost tiny btn-clear-data" @click="feedback = { ok: true, message: '已清除内置浏览器缓存数据' }">
                清除
              </button>
            </div>
          </div>

          <!-- 第二组：外部浏览器 -->
          <div class="browser-group-block">
            <div class="group-title-row">
              <span class="browser-group-name">外部浏览器</span>
            </div>

            <div class="browser-card-item">
              <div class="row-text">
                <span class="card-main-title">允许 AI 控制外部浏览器</span>
                <span class="card-desc">开启后，AI 助手可以使用外部 Chrome 浏览器执行网页浏览任务</span>
              </div>
              <label class="switch-control">
                <input
                  type="checkbox"
                  :checked="externalBrowserEnabled"
                  @change="toggleExternalBrowser"
                />
                <span class="switch-slider" />
              </label>
            </div>

            <div class="browser-card-item chrome-conn-item">
              <div class="row-text">
                <span class="card-main-title">连接到 Chrome</span>
                <span class="card-desc">如果未安装 Chrome 扩展或未启动调试端口，AI 可能无法正常打开浏览器。</span>
                <a href="javascript:void(0)" class="chrome-link">无法访问商店？尝试手动安装</a>
              </div>
              <div class="chrome-status-badge">
                <span class="status-green-dot">●</span>
                <span>已连接 ▾</span>
              </div>
            </div>
          </div>

          <!-- 第三组：通用 -->
          <div class="browser-group-block">
            <div class="group-title-row">
              <span class="browser-group-name">通用</span>
            </div>

            <div class="browser-card-item">
              <div class="row-text">
                <span class="card-main-title">AI 任务默认浏览器</span>
                <span class="card-desc">选择 AI 助手执行 Browser Use 任务时默认使用的浏览器</span>
              </div>
              <select v-model="defaultBrowser" class="browser-select-control" @change="saveDefaultBrowser">
                <option value="external">外部浏览器 (Chrome CDP)</option>
                <option value="builtin">内置浏览器 (Electron Chromium)</option>
              </select>
            </div>

            <div class="browser-card-item">
              <div class="row-text">
                <span class="card-main-title">自动截图</span>
                <span class="card-desc">浏览器操作后自动截取屏幕截图，仅用于展示，不消耗 Token</span>
              </div>
              <label class="switch-control">
                <input
                  type="checkbox"
                  :checked="autoScreenshot"
                  @change="toggleAutoScreenshot"
                />
                <span class="switch-slider" />
              </label>
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

            <!-- 2. Trusted Cowork folders -->
            <div class="cowork-item-block">
              <div class="cowork-item-main">
                <h4 class="cowork-block-title">Trusted Cowork folders (受信任协同文件夹)</h4>
                <p class="cowork-block-desc">
                  协同任务在读写这些受信任文件夹及其子目录时，可直接放行，无需每次打断提问。
                  <span class="trusted-count-badge">已信任 {{ trustedFolders.length }} 个目录</span>
                </p>
              </div>
              <div class="cowork-item-action">
                <button class="btn btn-outline tiny" @click="showTrustedFoldersModal = true">
                  <span>管理 (Manage)</span>
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
        <div v-if="taskEditorOpen" class="submodal-overlay" @click.self="taskEditorOpen = false">
          <div class="submodal-card submodal-wide">
            <div class="submodal-head">
              <h3 class="submodal-title">{{ editingTaskId ? '编辑自主任务' : '新建自主任务' }}</h3>
              <button class="btn-submodal-close" @click="taskEditorOpen = false">×</button>
            </div>
            <p class="submodal-tip">
              许愿模式会在工作区内自动执行，并在完成后用验收命令真实检查结果。
            </p>
            <div class="submodal-form">
              <label class="submodal-field">
                <span class="field-label">任务名称</span>
                <input v-model="taskForm.name" class="submodal-input" placeholder="例如：每晚修复 CI 失败" />
              </label>
              <label class="submodal-field">
                <span class="field-label">愿望目标</span>
                <textarea
                  v-model="taskForm.prompt"
                  class="submodal-textarea"
                  rows="4"
                  placeholder="说清要达成什么，而不是一步一步怎么做。"
                />
              </label>
              <label class="submodal-field">
                <span class="field-label">验收标准</span>
                <textarea
                  v-model="taskForm.acceptance"
                  class="submodal-textarea"
                  rows="3"
                  placeholder="例如：测试全绿、类型检查通过、不新增依赖。"
                />
              </label>
              <label class="submodal-field">
                <span class="field-label">工作目录</span>
                <div class="wish-path-row">
                  <input v-model="taskForm.workingDir" class="submodal-input mono" placeholder="选择项目目录" />
                  <button class="btn btn-ghost tiny" @click="pickTaskWorkingDir">选择</button>
                </div>
              </label>
              <label class="submodal-field">
                <span class="field-label">验收命令</span>
                <input
                  v-model="taskForm.verifyCommand"
                  class="submodal-input mono"
                  placeholder="例如：npm run typecheck && npm test"
                />
              </label>
              <div class="wish-form-grid">
                <label class="submodal-field">
                  <span class="field-label">执行周期</span>
                  <select v-model="taskForm.schedule" class="submodal-input">
                    <option value="interval">按间隔自动运行</option>
                    <option value="manual">仅手动运行</option>
                  </select>
                </label>
                <label v-if="taskForm.schedule === 'interval'" class="submodal-field">
                  <span class="field-label">间隔（分钟）</span>
                  <input v-model.number="taskForm.intervalMinutes" class="submodal-input" type="number" min="1" />
                </label>
                <label class="submodal-field">
                  <span class="field-label">单轮最大步数</span>
                  <input v-model.number="taskForm.maxSteps" class="submodal-input" type="number" min="1" max="500" />
                </label>
                <label class="submodal-field">
                  <span class="field-label">每日最多运行</span>
                  <input v-model.number="taskForm.maxRunsPerDay" class="submodal-input" type="number" min="1" max="100" />
                </label>
                <label class="submodal-field">
                  <span class="field-label">自动修复次数</span>
                  <input v-model.number="taskForm.maxVerifyAttempts" class="submodal-input" type="number" min="0" max="10" />
                </label>
              </div>
            </div>
            <div class="submodal-actions">
              <button class="btn btn-ghost" @click="taskEditorOpen = false">取消</button>
              <button class="btn btn-primary" :disabled="autonomousBusy" @click="saveTask">
                {{ autonomousBusy ? '保存中…' : '保存任务' }}
              </button>
            </div>
          </div>
        </div>

        <!-- 经验编辑弹窗 -->
        <div v-if="lessonEditorOpen" class="submodal-overlay" @click.self="lessonEditorOpen = false">
          <div class="submodal-card">
            <div class="submodal-head">
              <h3 class="submodal-title">添加已验证经验</h3>
              <button class="btn-submodal-close" @click="lessonEditorOpen = false">×</button>
            </div>
            <p class="submodal-tip">
              经验会注入后续许愿任务。只记录确实能提高成功率的项目事实与验证方式。
            </p>
            <div class="submodal-form">
              <label class="submodal-field">
                <span class="field-label">标题</span>
                <input v-model="lessonForm.title" class="submodal-input" placeholder="例如：本项目测试入口" />
              </label>
              <label class="submodal-field">
                <span class="field-label">内容</span>
                <textarea v-model="lessonForm.content" class="submodal-textarea" rows="5" placeholder="记录可复用的事实、命令与注意事项。" />
              </label>
              <label class="submodal-field">
                <span class="field-label">作用范围</span>
                <select v-model="lessonForm.scope" class="submodal-input">
                  <option value="project">当前项目</option>
                  <option value="global">全局</option>
                </select>
              </label>
              <label v-if="lessonForm.scope === 'project'" class="submodal-field">
                <span class="field-label">项目路径</span>
                <input v-model="lessonForm.projectPath" class="submodal-input mono" placeholder="项目根目录" />
              </label>
            </div>
            <div class="submodal-actions">
              <button class="btn btn-ghost" @click="lessonEditorOpen = false">取消</button>
              <button class="btn btn-primary" @click="saveLesson">保存经验</button>
            </div>
          </div>
        </div>

        <!-- 默认兜底展示 (code / import_export) -->
        <section v-if="['code', 'import_export'].includes(activeTab)" class="content-pane">
          <div class="placeholder-pane">
            <h3 class="pane-title">功能就绪</h3>
            <p class="subtle">该模块已在后台就绪并生效。您可以在聊天时随时直接唤起相应能力。</p>
          </div>
        </section>

        <!-- ========================================================
             受信任文件夹管理弹窗
             ======================================================== -->
        <div v-if="showTrustedFoldersModal" class="submodal-overlay" @click.self="showTrustedFoldersModal = false">
          <div class="submodal-card">
            <div class="submodal-head">
              <h4 class="submodal-title">受信任协同文件夹管理</h4>
              <button class="btn-submodal-close" @click="showTrustedFoldersModal = false">×</button>
            </div>
            <p class="submodal-tip">Agent 在这些目录内创建文件、读取文件或执行命令时将无需向您弹窗确认。</p>
            <div class="trusted-list">
              <div v-for="(dir, idx) in trustedFolders" :key="dir" class="trusted-row">
                <span class="trusted-dir-path text-truncate" :title="dir">📁 {{ dir }}</span>
                <button class="btn-del-trusted" title="移除此受信任目录" @click="removeTrustedFolder(idx)">✕</button>
              </div>
            </div>
            <div class="submodal-actions">
              <button class="btn btn-primary tiny" @click="addTrustedFolder">+ 添加受信任文件夹</button>
              <button class="btn btn-ghost tiny" @click="showTrustedFoldersModal = false">完成</button>
            </div>
          </div>
        </div>

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
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 2px;
  gap: 2px;
}

.seg-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 5px 8px;
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  transition: all 0.12s ease;
}

.seg-btn:hover {
  color: var(--text);
}

.seg-btn.active {
  background: var(--bg-elevated);
  color: var(--text);
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.08);
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

/* 隐私卡片 */
.privacy-banner-card {
  padding: 16px 20px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.banner-text {
  margin: 0;
  font-size: 13px;
  line-height: 1.6;
  color: var(--text);
}

.privacy-item-group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.privacy-group-title {
  margin: 0;
  font-size: 12.5px;
  font-weight: 600;
  color: var(--text);
}

.privacy-bullet-list {
  margin: 0;
  padding-left: 20px;
  font-size: 12px;
  color: var(--text-muted);
  line-height: 1.7;
}

/* Token 用量 */
.usage-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
}

.usage-desc {
  margin: 0;
  font-size: 12.5px;
  color: var(--text-muted);
  max-width: 65%;
}

.days-toggle {
  display: inline-flex;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 2px;
  gap: 2px;
}

.day-btn {
  padding: 3px 10px;
  font-size: 12px;
  border-radius: var(--radius-sm);
  color: var(--text-muted);
}

.day-btn.active {
  background: var(--bg-elevated);
  color: var(--text);
  font-weight: 600;
}

.usage-metric-cards {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 14px;
}

.metric-card {
  padding: 16px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.metric-title {
  font-size: 13px;
  font-weight: 500;
  color: var(--text-muted);
}

.metric-value {
  font-size: 26px;
  font-weight: 700;
  color: var(--text);
}

.metric-unit {
  font-size: 12px;
  font-weight: 400;
  color: var(--text-subtle);
}

.usage-chart-card {
  padding: 18px 20px;
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: var(--radius);
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.chart-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.chart-heading {
  margin: 0;
  font-size: 13.5px;
  font-weight: 600;
}

.chart-sub {
  margin: 2px 0 0;
  font-size: 11px;
}

.chart-legend {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 11.5px;
  color: var(--text-muted);
}

.legend-box {
  display: inline-block;
  width: 10px;
  height: 10px;
  border-radius: 2px;
}

.cowork-box {
  background: #d97757;
}

.code-box {
  background: #2f7d5d;
}

.histogram-wrapper {
  height: 140px;
  display: flex;
  align-items: flex-end;
  border-bottom: 1px solid var(--border-strong);
  padding-bottom: 4px;
}

.histogram-bars {
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  width: 100%;
  height: 100%;
  gap: 3px;
}

.histogram-col {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  height: 100%;
  justify-content: flex-end;
  position: relative;
}

.bar-stack {
  width: 100%;
  max-width: 14px;
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
  gap: 1px;
}

.bar-segment {
  width: 100%;
  border-radius: 2px;
  min-height: 2px;
}

.code-segment {
  background: #2f7d5d;
}

.cowork-segment {
  background: #d97757;
}

.date-label {
  position: absolute;
  bottom: -18px;
  font-size: 9.5px;
  color: var(--text-subtle);
  white-space: nowrap;
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
  background: #eef2ff;
  color: #4338ca;
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
  background: rgba(217, 119, 87, 0.08);
  border-color: rgba(217, 119, 87, 0.4);
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
  background: #111111;
  color: #ffffff;
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
  color: #ffffff;
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
  background: rgba(217, 119, 87, 0.1);
  border-color: rgba(217, 119, 87, 0.3);
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
  background: rgba(217, 119, 87, 0.06);
  border: 1px dashed rgba(217, 119, 87, 0.3);
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
  background: rgba(227, 98, 9, 0.12);
  color: #e36209;
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
  color: var(--primary, #d97757);
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
  color: var(--primary, #d97757);
  cursor: pointer;
  transition: all 0.12s ease;
}

.btn-add-memory:hover {
  background: var(--surface-hover);
  border-color: var(--primary, #d97757);
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
  border-color: var(--primary, #d97757);
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
.update-warn { padding: 10px 12px; border: 1px solid #d97706; background: rgba(217,119,6,0.1); border-radius: 8px; font-size: 12px; line-height: 1.6; }
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
  border: 1px solid rgba(217, 119, 87, 0.24);
  background:
    radial-gradient(circle at 88% 18%, rgba(245, 158, 11, 0.18), transparent 38%),
    linear-gradient(135deg, rgba(217, 119, 87, 0.11), rgba(247, 247, 248, 0.4));
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
  color: #b45309;
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 10px;
  font-weight: 700;
  letter-spacing: 1.5px;
}

.lessons-hero .wish-kicker {
  color: #047857;
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
  color: #d97757;
  font-size: 70px;
  line-height: 1;
  opacity: 0.3;
  transform: rotate(10deg);
}

.lessons-hero .wish-hero-mark {
  color: #10b981;
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

.wish-toolbar {
  display: flex;
  align-items: center;
  gap: 8px;
}

.wish-autonomy-hint {
  margin: -4px 0 0;
  padding: 8px 10px;
  border-radius: 7px;
  background: rgba(245, 158, 11, 0.09);
  color: #92400e;
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
  color: #d97757;
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
  border-color: rgba(217, 119, 87, 0.45);
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
  color: #047857;
  background: rgba(16, 185, 129, 0.1);
  border-color: rgba(16, 185, 129, 0.25);
}

.wish-status-pill.status-failed {
  color: var(--danger);
  background: var(--danger-soft);
  border-color: rgba(207, 34, 46, 0.25);
}

.wish-status-pill.status-running {
  color: #b45309;
  background: rgba(245, 158, 11, 0.1);
  border-color: rgba(245, 158, 11, 0.25);
}

.wish-cycle {
  color: #b45309;
  background: rgba(217, 119, 87, 0.08);
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
  background: #10b981;
}

.wish-run-dot.run-failed {
  background: var(--danger);
}

.wish-run-dot.run-verifying,
.wish-run-dot.run-running {
  background: #f59e0b;
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
  color: #047857;
  background: rgba(16, 185, 129, 0.1);
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
