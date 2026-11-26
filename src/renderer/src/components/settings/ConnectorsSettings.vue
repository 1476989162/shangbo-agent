<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'

const props = withDefaults(
  defineProps<{
    pluginsCount?: number
    skillsCount?: number
    approvedCount?: number
  }>(),
  {
    pluginsCount: 0,
    skillsCount: 0,
    approvedCount: 0
  }
)

const emit = defineEmits<{
  feedback: [value: { ok: boolean; message: string }]
  navigate: [tab: string]
  mcpChange: [count: number]
}>()

// ========================================================
// MCP Servers 管理（实测驱动：列表、状态、工具数全部来自主进程）
// （自 SettingsDialog.vue 迁出，逻辑与模板逐字搬运）
// ========================================================
export interface McpServerItem {
  id: string
  name: string
  enabled: boolean
  state: 'ready' | 'error' | 'disabled'
  toolCount: number
  tools: { name: string; description?: string }[]
  error?: string
  kind?: 'stdio' | 'http'
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
}

const mcpServers = ref<McpServerItem[]>([])
const mcpLoading = ref(false)
const expandedMcp = ref<string | null>(null)
const projectMcpEnabled = ref(true)

async function toggleProjectMcp(): Promise<void> {
  await window.shangbo.settings.set('agent.mcp.projectLevel', projectMcpEnabled.value)
  emit('feedback', {
    ok: true,
    message: projectMcpEnabled.value ? '已启用项目级 MCP 配置自动加载' : '已关闭项目级 MCP 配置加载'
  })
}

/** MCP 添加/编辑表单：stdio 命令 或 Streamable HTTP 二选一。 */
const mcpEditorOpen = ref(false)
const mcpEditingId = ref<string | null>(null)
const mcpForm = ref({ name: '', kind: 'stdio' as 'stdio' | 'http', command: '', args: '', url: '' })
const mcpAddMenuOpen = ref(false)

function openMcpAdd(kind: 'stdio' | 'http'): void {
  mcpEditingId.value = null
  mcpForm.value = { name: '', kind, command: '', args: '', url: '' }
  mcpAddMenuOpen.value = false
  mcpEditorOpen.value = true
}

function openMcpEdit(id: string): void {
  const item = mcpServers.value.find((s) => s.id === id)
  mcpEditingId.value = id
  const kind = (item?.url || item?.kind === 'http') ? 'http' : 'stdio'
  mcpForm.value = {
    name: item?.name ?? id,
    kind,
    command: item?.command ?? '',
    args: Array.isArray(item?.args) ? item.args.join(' ') : (typeof item?.args === 'string' ? item.args : ''),
    url: item?.url ?? ''
  }
  mcpEditorOpen.value = true
}

function slugId(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
}

async function saveMcpServer(): Promise<void> {
  const name = mcpForm.value.name.trim()
  if (!name) {
    emit('feedback', { ok: false, message: '请填写服务名称' })
    return
  }
  const id = mcpEditingId.value ?? slugId(name)
  if (!id) {
    emit('feedback', { ok: false, message: '名称需包含字母或数字' })
    return
  }
  try {
    const settings = await window.shangbo.settings.getAll()
    const stored = settings['agent.mcp.servers'] as Record<string, unknown>[] | undefined
    const base: Record<string, unknown>[] = Array.isArray(stored) && stored.length > 0
      ? stored.map((s) => ({ ...s }))
      : mcpServers.value.map((s) => ({
          id: s.id,
          name: s.name,
          enabled: s.enabled,
          kind: s.kind,
          command: s.command,
          args: s.args,
          url: s.url,
          env: s.env
        }))
    const entry: Record<string, unknown> = { id, name, enabled: true, kind: mcpForm.value.kind }
    if (mcpForm.value.kind === 'http') {
      const url = mcpForm.value.url.trim()
      if (!/^https?:\/\/.+/.test(url)) {
        emit('feedback', { ok: false, message: '请填写 http(s):// 开头的 URL' })
        return
      }
      entry['url'] = url
      entry['command'] = ''
      entry['args'] = []
    } else {
      const command = mcpForm.value.command.trim()
      if (!command) {
        emit('feedback', { ok: false, message: '请填写启动命令' })
        return
      }
      entry['command'] = command
      entry['args'] = mcpForm.value.args.split(/\s+/).filter(Boolean)
      entry['url'] = ''
    }
    const next = base.some((s) => s['id'] === id)
      ? base.map((s) => (s['id'] === id ? { ...s, ...entry, id } : s))
      : [...base, entry]
    await window.shangbo.settings.set('agent.mcp.servers', next)
    // 白名单同步加上，否则生效逻辑取交集后新服务被过滤
    const enabledIds = new Set(mcpServers.value.filter((s) => s.enabled).map((s) => s.id))
    enabledIds.add(id)
    await window.shangbo.settings.set('agent.mcpServers', [...enabledIds])
    mcpEditorOpen.value = false
    emit('feedback', { ok: true, message: `MCP 服务「${name}」已保存` })
    void refreshMcp()
  } catch (error) {
    emit('feedback', { ok: false, message: error instanceof Error ? error.message : '保存失败' })
  }
}

async function removeMcpServer(): Promise<void> {
  const id = mcpEditingId.value
  if (!id) return
  if (!confirm('删除该 MCP 服务？')) return
  try {
    const settings = await window.shangbo.settings.getAll()
    const stored = settings['agent.mcp.servers'] as Record<string, unknown>[] | undefined
    const base: Record<string, unknown>[] = Array.isArray(stored) && stored.length > 0
      ? stored
      : mcpServers.value.map((s) => ({ id: s.id, enabled: s.enabled }))
    await window.shangbo.settings.set(
      'agent.mcp.servers',
      base.filter((s) => s['id'] !== id)
    )
    mcpEditorOpen.value = false
    emit('feedback', { ok: true, message: 'MCP 服务已删除' })
    void refreshMcp()
  } catch (error) {
    emit('feedback', { ok: false, message: error instanceof Error ? error.message : '删除失败' })
  }
}

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
  try {
    await window.shangbo.settings.set('agent.mcpServers', enabledIds)
  } catch (error) {
    item.enabled = !item.enabled
    emit('feedback', { ok: false, message: error instanceof Error ? error.message : '开关保存失败' })
    return
  }
  // 白名单存在时以后端白名单为准（预置 enabled:false 的服务如 Magpie 也能打开），
  // 同时把配置 enabled 双写对齐，保证白名单缺失/回退时仍一致。
  // 库里没 agent.mcp.servers 时按设置页全量列表落一份全量快照：
  // 只写白名单的话，merge 回落内置的默认 enabled:false 会盖住白名单。
  try {
    const settings = await window.shangbo.settings.getAll()
    const servers = settings['agent.mcp.servers'] as { id: string; enabled?: boolean }[] | undefined
    if (Array.isArray(servers) && servers.length > 0) {
      const ids = new Set(servers.map((s) => s.id))
      const next = [...servers]
      for (const s of mcpServers.value) {
        if (ids.has(s.id)) continue
        next.push({ id: s.id, enabled: s.id === item.id ? item.enabled : s.enabled })
      }
      await window.shangbo.settings.set(
        'agent.mcp.servers',
        next.map((s) => (s.id === item.id ? { ...s, enabled: item.enabled } : s))
      )
    } else {
      // 无快照或残留空数组：按当前开关状态落全量，避免 merge 回落内置盖住刚打开的 Magpie
      await window.shangbo.settings.set(
        'agent.mcp.servers',
        mcpServers.value.map((s) => ({ id: s.id, enabled: s.id === item.id ? item.enabled : s.enabled }))
      )
    }
  } catch {
    // 白名单已写，刷新后至少状态一致；配置写失败下次打开再试
  }
  emit('feedback', {
    ok: true,
    message: item.enabled ? `已启用 MCP 服务「${item.name}」` : `已停用 MCP 服务「${item.name}」`
  })
  void refreshMcp()
}

watch(
  () => mcpServers.value.length,
  (count) => {
    emit('mcpChange', count)
  }
)

onMounted(async () => {
  try {
    const settings = await window.shangbo.settings.getAll()
    projectMcpEnabled.value = (settings['agent.mcp.projectLevel'] as boolean) ?? true
  } catch {
    /* 读不到就用默认值 */
  }
  await refreshMcp()
  emit('mcpChange', mcpServers.value.length)
})
</script>

<template>
  <section class="content-pane mcp-pane">
    <!-- 顶部子标签栏 (插件 | 技能 | MCP | 应用授权) -->
    <div class="mcp-subnav-row">
      <span class="mcp-subnav-item" @click="emit('navigate', 'plugins')">插件 {{ props.pluginsCount }}</span>
      <span class="mcp-subnav-item" @click="emit('navigate', 'skills')">技能 {{ props.skillsCount }}</span>
      <span class="mcp-subnav-item active">MCP {{ mcpServers.length }}</span>
      <span class="mcp-subnav-item" @click="emit('navigate', 'general')">应用授权 {{ props.approvedCount }}</span>
    </div>

    <!-- 项目级配置卡片 -->
    <div class="mcp-card-block">
      <div class="setting-row">
        <div class="row-text">
          <span class="setting-label">启用项目级 MCP</span>
          <span class="row-sub">允许自动从项目根目录下的 .trae/mcp.json 或 .mcp.json 中加载 MCP 配置</span>
        </div>
        <label class="switch-control">
          <input v-model="projectMcpEnabled" type="checkbox" @change="toggleProjectMcp" />
          <span class="switch-slider" />
        </label>
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
          <div class="mcp-add-wrap">
            <button class="btn btn-primary tiny btn-add-mcp" @click="mcpAddMenuOpen = !mcpAddMenuOpen">+ 添加 ▾</button>
            <div v-if="mcpAddMenuOpen" class="mcp-add-menu" @click.self="mcpAddMenuOpen = false">
              <button class="menu-item" @click="openMcpAdd('stdio')">命令行（stdio）</button>
              <button class="menu-item" @click="openMcpAdd('http')">网址（Streamable HTTP）</button>
            </div>
          </div>
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
            <button class="server-gear-btn" title="配置服务器参数" @click="openMcpEdit(server.id)">⚙</button>
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

    <!-- MCP 添加/编辑弹窗 -->
    <div v-if="mcpEditorOpen" class="submodal-overlay" @click.self="mcpEditorOpen = false">
      <div class="submodal-card">
        <div class="submodal-head">
          <h3 class="submodal-title">{{ mcpEditingId ? '配置 MCP 服务' : '添加 MCP 服务' }}</h3>
          <button class="btn-submodal-close" @click="mcpEditorOpen = false">×</button>
        </div>
        <label class="wish-field">
          <span class="field-label">服务名称</span>
          <input v-model="mcpForm.name" class="submodal-input" placeholder="例如：我的 HTTP 服务" :disabled="!!mcpEditingId" />
        </label>
        <label class="wish-field">
          <span class="field-label">类型</span>
          <select v-model="mcpForm.kind" class="submodal-input">
            <option value="stdio">命令行（stdio）</option>
            <option value="http">网址（Streamable HTTP）</option>
          </select>
        </label>
        <template v-if="mcpForm.kind === 'http'">
          <label class="wish-field">
            <span class="field-label">URL</span>
            <input v-model="mcpForm.url" class="submodal-input mono" placeholder="http://127.0.0.1:34254/mcp/xxx" />
            <span class="wish-field-hint">密钥走网关复用，无需填写。</span>
          </label>
        </template>
        <template v-else>
          <label class="wish-field">
            <span class="field-label">启动命令</span>
            <input v-model="mcpForm.command" class="submodal-input mono" placeholder="例如：npx.cmd 或 docker" />
          </label>
          <label class="wish-field">
            <span class="field-label">参数（空格分隔）</span>
            <input v-model="mcpForm.args" class="submodal-input mono" placeholder="例如：-y @modelcontextprotocol/server-fetch" />
            <span class="wish-field-hint">密钥走系统环境变量，不落盘。</span>
          </label>
        </template>
        <div class="submodal-actions">
          <button v-if="mcpEditingId" class="btn btn-ghost tiny btn-danger" @click="removeMcpServer">删除</button>
          <span class="submodal-spacer" />
          <button class="btn btn-ghost tiny" @click="mcpEditorOpen = false">取消</button>
          <button class="btn btn-primary tiny" @click="saveMcpServer">保存</button>
        </div>
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


.wish-path-row .submodal-input {
  flex: 1;
  min-width: 0;
}
</style>
