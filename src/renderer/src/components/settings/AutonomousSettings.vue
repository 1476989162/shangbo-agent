<script setup lang="ts">
import { onMounted, ref } from 'vue'
import { useChatStore } from '../../stores/chat'

const props = defineProps<{
  tab: 'autonomous' | 'lessons'
}>()

const emit = defineEmits<{
  feedback: [value: { ok: boolean; message: string }]
  close: []
  lessonsChange: [count: number]
}>()

const store = useChatStore()

/* ------------------------------------------------------------------ */
/* 许愿模式 / 自主任务 / 经验库                                         */
/* （自 SettingsDialog.vue 迁出，逻辑与模板逐字搬运）                  */
/* ------------------------------------------------------------------ */
// 许愿模式
const wishEnabled = ref(true)
const wishAutoApproveWorkspace = ref(true)
const wishAllowMcp = ref(true)
const wishMcpAutoApproveServers = ref<string[]>([])
const wishAutoVerify = ref(true)
const wishEvolve = ref(true)
const wishAcceptance = ref('')
const wishVerifyCommand = ref('')
const wishMaxSteps = ref(120)
const wishVerifyRetries = ref(2)

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

// 新建任务时的默认工作目录（原 SettingsDialog 取 cowork.filesPath 设置项）
const coworkFilesPath = ref('')

/** MCP 免审批勾选用：只读拉取服务清单，不接管开关逻辑（开关归 ConnectorsSettings）。 */
const mcpServers = ref<{ id: string; name: string; enabled: boolean; toolCount: number }[]>([])

async function loadMcpMini(): Promise<void> {
  try {
    const list = await window.shangbo.mcp.status()
    mcpServers.value = (list as { id: string; name: string; enabled: boolean; toolCount: number }[]).map(
      (s) => ({ id: s.id, name: s.name, enabled: s.enabled, toolCount: s.toolCount ?? 0 })
    )
  } catch {
    mcpServers.value = []
  }
}

async function saveWishSettings(): Promise<void> {
  await window.shangbo.settings.set('agent.wish.enabled', wishEnabled.value)
  await window.shangbo.settings.set(
    'agent.wish.autoApproveWorkspace',
    wishAutoApproveWorkspace.value
  )
  await window.shangbo.settings.set('agent.wish.allowMcp', wishAllowMcp.value)
  await window.shangbo.settings.set(
    'agent.wish.mcpAutoApproveServers',
    wishMcpAutoApproveServers.value
  )
  await window.shangbo.settings.set('agent.wish.autoVerify', wishAutoVerify.value)
  await window.shangbo.settings.set('agent.wish.evolve', wishEvolve.value)
  await window.shangbo.settings.set('agent.wish.acceptance', wishAcceptance.value)
  await window.shangbo.settings.set('agent.wish.verifyCommand', wishVerifyCommand.value)
  await window.shangbo.settings.set('agent.wishMaxSteps', Number(wishMaxSteps.value))
  await window.shangbo.settings.set('agent.wish.verifyRetries', Number(wishVerifyRetries.value))
  emit('feedback', { ok: true, message: '许愿模式设置已保存' })
}

async function toggleAutonomousEnabled(): Promise<void> {
  await window.shangbo.settings.set('agent.autonomous.enabled', autonomousEnabled.value)
  if (autonomousEnabled.value) {
    await window.shangbo.autonomous.resume()
    autonomousPaused.value = false
  }
  emit('feedback', {
    ok: true,
    message: autonomousEnabled.value
      ? '自主调度已开启：已启用的周期任务会按计划执行'
      : '自主调度已关闭：已有任务定义保留，但不会自动触发'
  })
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
  emit('lessonsChange', lessons.value.length)
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
    maxRunsPerDay: 12
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
    emit('feedback', { ok: false, message: '请填写任务名称与愿望目标' })
    return
  }
  if (!taskForm.value.workingDir.trim()) {
    emit('feedback', { ok: false, message: '请选择任务工作目录' })
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
    emit('feedback', { ok: true, message: '自主任务已保存' })
  } catch (error) {
    emit('feedback', {
      ok: false,
      message: error instanceof Error ? error.message : '保存自主任务失败'
    })
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
    emit('feedback', { ok: true, message: `任务已启动，可在会话中查看进度` })
    await store.openConversation(result.conversationId)
    emit('close')
  } catch (error) {
    emit('feedback', {
      ok: false,
      message: error instanceof Error ? error.message : '启动任务失败'
    })
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

const editingLessonId = ref<string | null>(null)

function openNewLesson(): void {
  editingLessonId.value = null
  lessonForm.value = {
    title: '',
    content: '',
    scope: 'project',
    projectPath: store.activeConversation?.workingDir ?? '',
    confidence: 0.75
  }
  lessonEditorOpen.value = true
}

function editLesson(lesson: import('@shared/types').Lesson): void {
  editingLessonId.value = lesson.id
  lessonForm.value = {
    title: lesson.title,
    content: lesson.content,
    scope: lesson.scope,
    projectPath: lesson.projectPath ?? '',
    confidence: lesson.confidence
  }
  lessonEditorOpen.value = true
}

async function saveLesson(): Promise<void> {
  if (!lessonForm.value.title.trim() || !lessonForm.value.content.trim()) {
    emit('feedback', { ok: false, message: '请填写经验标题与内容' })
    return
  }
  await window.shangbo.lessons.save({
    id: editingLessonId.value ?? undefined,
    title: lessonForm.value.title,
    content: lessonForm.value.content,
    scope: lessonForm.value.scope,
    projectPath: lessonForm.value.scope === 'project' ? lessonForm.value.projectPath : null,
    confidence: Number(lessonForm.value.confidence)
  })
  lessonEditorOpen.value = false
  editingLessonId.value = null
  await loadLessons()
  emit('feedback', { ok: true, message: '经验已保存，后续任务会自动复用' })
}

async function removeLesson(id: string): Promise<void> {
  if (!confirm('删除这条经验？')) return
  await window.shangbo.lessons.remove(id)
  await loadLessons()
}

onMounted(async () => {
  try {
    const settings = await window.shangbo.settings.getAll()
    wishEnabled.value = (settings['agent.wish.enabled'] as boolean) ?? true
    wishAutoApproveWorkspace.value =
      (settings['agent.wish.autoApproveWorkspace'] as boolean) ?? true
    wishAllowMcp.value = (settings['agent.wish.allowMcp'] as boolean) ?? true
    wishMcpAutoApproveServers.value =
      (settings['agent.wish.mcpAutoApproveServers'] as string[]) ?? []
    wishAutoVerify.value = (settings['agent.wish.autoVerify'] as boolean) ?? true
    wishEvolve.value = (settings['agent.wish.evolve'] as boolean) ?? true
    wishAcceptance.value = (settings['agent.wish.acceptance'] as string) ?? ''
    wishVerifyCommand.value = (settings['agent.wish.verifyCommand'] as string) ?? ''
    wishMaxSteps.value = (settings['agent.wishMaxSteps'] as number) ?? 120
    wishVerifyRetries.value = (settings['agent.wish.verifyRetries'] as number) ?? 2
    autonomousEnabled.value = (settings['agent.autonomous.enabled'] as boolean) ?? false
    if (typeof settings['cowork.filesPath'] === 'string') {
      coworkFilesPath.value = settings['cowork.filesPath'] as string
    }
  } catch {
    /* 读不到就用默认值 */
  }
  await loadMcpMini()
  await loadAutonomous()
  await loadLessons()
})
</script>

<template>
  <template v-if="props.tab === 'autonomous'">
    <section class="content-pane wish-pane">
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
            <span class="setting-label">允许调用 MCP</span>
            <span class="row-sub">
              许愿模式可直接使用已启用的外部 MCP 服务（浏览器自动化、抓网页、检索文档、记忆库等）；关闭后回到“只用本地工作区工具”。
            </span>
          </div>
          <label class="switch-control">
            <input v-model="wishAllowMcp" type="checkbox" @change="saveWishSettings" />
            <span class="switch-slider" />
          </label>
        </div>

        <div v-if="wishAllowMcp" class="setting-row">
          <div class="row-text">
            <span class="setting-label">MCP 免审批服务</span>
            <span class="row-sub">
              不勾选＝所有已启用服务免审批（许愿模式无人值守，弹窗只会超时后按拒绝处理）；勾选后只有列出的服务放行，其余服务会被直接拒绝。
            </span>
          </div>
        </div>
        <div v-if="wishAllowMcp" class="wish-mcp-picks">
          <div v-if="mcpServers.length === 0" class="servers-subtle">
            未读取到 MCP 服务清单，请到「连接器 → MCP」刷新。
          </div>
          <label
            v-for="server in mcpServers.filter((s) => s.enabled)"
            :key="server.id"
            class="wish-mcp-pick"
          >
            <input
              v-model="wishMcpAutoApproveServers"
              type="checkbox"
              :value="server.id"
              @change="saveWishSettings"
            />
            <span>{{ server.name }}</span>
            <span class="servers-subtle">{{ server.toolCount }} 工具</span>
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
  </template>

  <template v-if="props.tab === 'lessons'">
    <section class="content-pane lessons-pane">
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
            <button class="btn btn-ghost tiny" @click="editLesson(lesson)">编辑</button>
            <button class="btn btn-ghost tiny btn-danger" @click="removeLesson(lesson.id)">
              删除
            </button>
          </div>
        </article>
      </div>
    </section>
  </template>

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

  <div v-if="lessonEditorOpen" class="submodal-overlay" @click.self="lessonEditorOpen = false">
    <div class="submodal-card">
      <div class="submodal-head">
        <h3 class="submodal-title">{{ editingLessonId ? '编辑经验' : '添加已验证经验' }}</h3>
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
</template>

<style scoped>

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


.field-label {
  font-size: 12px;
  font-weight: 500;
}

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


.servers-subtle {
  margin: 3px 0 0;
  font-size: 11.5px;
  color: var(--text-subtle);
}


.submodal-spacer {
  flex: 1;
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
  background: var(--success);
}


.switch-control input:checked + .switch-slider::before {
  transform: translateX(16px);
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
