<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { useChatStore } from '../../stores/chat'
import { t } from '../../i18n'

const props = withDefaults(
  defineProps<{
    tab: 'plugins' | 'skills'
    appName?: string
  }>(),
  {
    appName: 'shangbo-agent'
  }
)

const emit = defineEmits<{
  feedback: [value: { ok: boolean; message: string }]
  navigate: [tab: string]
  countsChange: [counts: { plugins: number; skills: number }]
}>()

const store = useChatStore()

let unmounted = false

// ========================================================
// 插件中心 (Plugins) 与技能 (Skills) 数据与状态
// （自 SettingsDialog.vue 迁出，逻辑与模板逐字搬运）
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

function emitCounts(): void {
  if (unmounted) return
  emit('countsChange', { plugins: pluginsList.value.length, skills: skillDirs.value.length })
}

async function addSkillDir(): Promise<void> {
  const dir = await window.shangbo.dialog.pickFolder()
  if (!dir) return
  if (skillDirs.value.includes(dir)) {
    emit('feedback', { ok: false, message: '该目录已添加' })
    return
  }
  skillDirs.value.push(dir)
  await window.shangbo.settings.set('agent.skillDirs', [...skillDirs.value])
  emit('feedback', { ok: true, message: `已添加外部技能目录：${dir}` })
  emitCounts()
}

async function removeSkillDir(index: number): Promise<void> {
  skillDirs.value.splice(index, 1)
  await window.shangbo.settings.set('agent.skillDirs', [...skillDirs.value])
  emit('feedback', { ok: true, message: '已移除该技能目录' })
  emitCounts()
}

async function togglePlugin(plugin: PluginItem): Promise<void> {
  plugin.enabled = !plugin.enabled
  const enabledIds = pluginsList.value.filter((p) => p.enabled).map((p) => p.id)
  await window.shangbo.settings.set('agent.plugins', enabledIds)
  emit('feedback', {
    ok: true,
    message: plugin.enabled ? `已启用「${plugin.name}」技能` : `已停用「${plugin.name}」`
  })
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
  return props.appName || 'shangbo-agent'
})

async function copyPrompt(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    emit('feedback', { ok: true, message: '示例提问已复制到剪贴板' })
  } catch {
    // 忽略
  }
}

onMounted(async () => {
  await loadPlugins()
  if (unmounted) return
  emitCounts()
})

onBeforeUnmount(() => {
  unmounted = true
})
</script>

<template>
  <section class="content-pane plugins-pane">
    <!-- 顶部标题与全局操作栏 -->
    <div class="plugins-header-row">
      <h3 class="plugins-main-title">{{ tab === 'skills' ? '技能中心 (Skills)' : '插件中心 (Plugins)' }}</h3>

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
        <button class="btn btn-ghost tiny" title="去 MCP 页添加外部服务" @click="emit('navigate', 'connectors')">发现 (Discover)</button>
        <button
          class="btn btn-primary tiny btn-add-plugin"
          title="添加外部技能目录（SKILL.md 技能包，如 D:\foxtable\foxtablecoderv7）"
          @click="addSkillDir"
        >
          添加 (Add) ▾
        </button>
      </div>
    </div>

    <!-- 第二行：标签筛选与排序栏 -->
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

    <!-- 第三行：当前仓库与工作区绑定标识卡 -->
    <div class="repo-badge-card">
      <svg width="15" height="15" viewBox="0 0 16 16" fill="currentColor" class="repo-icon">
        <path fill-rule="evenodd" d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z" />
      </svg>
      <span class="repo-badge-text">{{ currentRepoName }}</span>
      <span class="repo-badge-status">本地插件宿主就绪</span>
    </div>

    <!-- 分组标题：来自官方与合作伙伴 -->
    <div class="plugins-group-heading">
      <span>{{ t('settings.officialPartners') }} · {{ filteredPlugins.length }}</span>
    </div>

    <!-- 8 大核心插件与技能列表 -->
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

    <!-- 外部技能目录（SKILL.md 技能包） -->
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

    <!-- 技能使用与能力说明提示底栏 -->
    <div class="plugin-footer-note">
      <span class="note-spark">✦</span>
      <span class="note-text">
        <strong>技能使用说明：</strong>开启的插件已直接打通「尚搏 Agent」的本地执行运行时。在聊天输入框说出对应任务（如直接说“/commit 提交代码”、“用 Ralph loop 循环运行测试并修报错”、“进行安全审计”），Agent 将自动按对应流程精准执行！
      </span>
    </div>
  </section>

  <!-- 技能使用详情弹窗 -->
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
</template>

<style scoped>

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


.content-pane {
  display: flex;
  flex-direction: column;
  gap: 20px;
}
</style>
