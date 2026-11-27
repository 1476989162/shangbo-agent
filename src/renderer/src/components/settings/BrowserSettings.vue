<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'

const emit = defineEmits<{
  feedback: [value: { ok: boolean; message: string }]
  navigate: [tab: string]
}>()

/* ------------------------------------------------------------------ */
/* 浏览器控制：内置预览 + MCP 自动化引擎 + 外部 9222 真实闭环            */
/* （自 SettingsDialog.vue 迁出；已删除假「导入…」按钮）                */
/* ------------------------------------------------------------------ */

interface EngineItem {
  id: string
  name: string
  enabled: boolean
  state: 'ready' | 'error' | 'disabled'
  toolCount: number
  error?: string
}

const ENGINE_IDS = ['playwright', 'chrome-devtools']

let unmounted = false

const chromePortConnected = ref(false)
const checkingChromePort = ref(false)
const chromeAttach9222 = ref(false)
const chromeBrowserName = ref('')
const chromeDetailsError = ref('')
const launchingChrome = ref(false)

const engines = ref<EngineItem[]>([])
const enginesLoading = ref(false)

function toEngineItem(raw: {
  id: string
  name: string
  enabled: boolean
  state: 'ready' | 'error' | 'disabled'
  toolCount: number
  error?: string
}): EngineItem {
  return {
    id: raw.id,
    name: raw.name,
    enabled: raw.enabled,
    state: raw.state,
    toolCount: raw.toolCount,
    error: raw.error
  }
}

async function checkChromeDebuggingPort(): Promise<void> {
  checkingChromePort.value = true
  chromeDetailsError.value = ''
  try {
    const res = await window.shangbo.browser.chromeDetails()
    if (unmounted) return
    chromePortConnected.value = res.connected
    chromeBrowserName.value = res.connected ? (res.browser ?? '') : ''
  } catch (err: unknown) {
    if (unmounted) return
    chromePortConnected.value = false
    chromeBrowserName.value = ''
    chromeDetailsError.value = err instanceof Error ? err.message : String(err)
  } finally {
    if (!unmounted) checkingChromePort.value = false
  }
}

async function toggleChromeAttach(): Promise<void> {
  const next = !chromeAttach9222.value
  try {
    await window.shangbo.settings.set('browser.chromeAttach9222', next)
    if (unmounted) return
    chromeAttach9222.value = next
    emit('feedback', {
      ok: true,
      message: next
        ? '已开启 9222 附着：chrome-devtools 下次启动将附着到本机 Chrome（旧实例已自动重建）'
        : '已关闭 9222 附着：chrome-devtools 恢复独立浏览器模式（旧实例已自动重建）'
    })
    void refreshEngines()
  } catch (err: unknown) {
    if (unmounted) return
    emit('feedback', { ok: false, message: `切换失败：${err instanceof Error ? err.message : String(err)}` })
  }
}

async function launchDebugChrome(): Promise<void> {
  launchingChrome.value = true
  chromeDetailsError.value = ''
  try {
    const res = await window.shangbo.browser.launchChrome()
    if (unmounted) return
    if (res.ok) {
      emit('feedback', {
        ok: true,
        message: res.alreadyRunning
          ? `Chrome 9222 调试端口已在运行${res.browser ? `（${res.browser}）` : ''}`
          : `调试版 Chrome 已就绪${res.browser ? `（${res.browser}）` : ''}`
      })
      await checkChromeDebuggingPort()
    } else {
      chromeDetailsError.value = res.error
      emit('feedback', { ok: false, message: res.error })
    }
  } catch (err: unknown) {
    if (unmounted) return
    const msg = err instanceof Error ? err.message : String(err)
    chromeDetailsError.value = msg
    emit('feedback', { ok: false, message: `启动失败：${msg}` })
  } finally {
    if (!unmounted) launchingChrome.value = false
  }
}

async function handleClearBrowserData(): Promise<void> {
  try {
    const ok = await window.shangbo.browser.clearData()
    if (unmounted) return
    emit('feedback', {
      ok,
      message: ok ? '已成功清除 Chromium 内置浏览器 Cookies 与本地缓存数据' : '清除浏览器数据失败'
    })
  } catch (err: unknown) {
    if (unmounted) return
    emit('feedback', {
      ok: false,
      message: `清除失败：${err instanceof Error ? err.message : String(err)}`
    })
  }
}

async function refreshEngines(): Promise<void> {
  if (enginesLoading.value) return
  enginesLoading.value = true
  try {
    const all = await window.shangbo.mcp.status()
    if (unmounted) return
    engines.value = (all as Array<EngineItem & { id: string }>)
      .filter((s) => ENGINE_IDS.includes(s.id))
      .map(toEngineItem)
  } catch {
    if (unmounted) return
    engines.value = []
  } finally {
    if (!unmounted) enginesLoading.value = false
  }
}

/** 与 ConnectorsSettings.vue 同规范：白名单 + 配置双写，保证两种回退口径一致。 */
async function toggleEngine(item: EngineItem): Promise<void> {
  const next = !item.enabled
  try {
    const all = await window.shangbo.mcp.status()
    const rows = all as Array<{ id: string; enabled: boolean }>
    const enabledIds = rows.filter((s) => (s.id === item.id ? next : s.enabled)).map((s) => s.id)
    await window.shangbo.settings.set('agent.mcpServers', enabledIds)
  } catch (err: unknown) {
    if (unmounted) return
    emit('feedback', { ok: false, message: `开关保存失败：${err instanceof Error ? err.message : String(err)}` })
    return
  }
  try {
    const settings = await window.shangbo.settings.getAll()
    const servers = settings['agent.mcp.servers'] as Array<{ id: string; enabled?: boolean }> | undefined
    if (Array.isArray(servers) && servers.length > 0) {
      const ids = new Set(servers.map((s) => s.id))
      const nextServers = [...servers]
      for (const id of ENGINE_IDS) {
        if (ids.has(id)) continue
        nextServers.push({ id, enabled: id === item.id ? next : engines.value.find((e) => e.id === id)?.enabled ?? true })
      }
      await window.shangbo.settings.set(
        'agent.mcp.servers',
        nextServers.map((s) => (s.id === item.id ? { ...s, enabled: next } : s))
      )
    } else {
      await window.shangbo.settings.set(
        'agent.mcp.servers',
        ENGINE_IDS.map((id) => ({ id, enabled: id === item.id ? next : engines.value.find((e) => e.id === id)?.enabled ?? true }))
      )
    }
  } catch {
    // 白名单已写，刷新后至少状态一致；配置写失败下次打开再试
  }
  if (unmounted) return
  item.enabled = next
  emit('feedback', {
    ok: true,
    message: next ? `已启用「${item.name}」` : `已停用「${item.name}」`
  })
  void refreshEngines()
}

function goConnectors(): void {
  emit('navigate', 'connectors')
}

onMounted(async () => {
  try {
    const settings = await window.shangbo.settings.getAll()
    if (unmounted) return
    chromeAttach9222.value = (settings['browser.chromeAttach9222'] as boolean) ?? false
  } catch {
    /* 读不到就用默认值 */
  }
  await checkChromeDebuggingPort()
  await refreshEngines()
})

onBeforeUnmount(() => {
  unmounted = true
})
</script>

<template>
  <section class="content-pane browser-pane">
    <h3 class="pane-large-title">浏览器</h3>

    <!-- 第一组：内置浏览器（仅右侧预览栏站点数据） -->
    <div class="browser-group-block">
      <div class="group-title-row">
        <span class="browser-group-name">内置浏览器</span>
      </div>

      <div class="browser-card-item">
        <div class="row-text">
          <span class="card-main-title">浏览器数据</span>
          <span class="card-desc">仅清除右侧预览栏站点数据；AI 操控浏览器通过下方自动化引擎执行</span>
        </div>
        <button class="btn btn-ghost tiny btn-clear-data" @click="handleClearBrowserData">
          清除
        </button>
      </div>
    </div>

    <!-- 第二组：浏览器自动化引擎（MCP） -->
    <div class="browser-group-block">
      <div class="group-title-row">
        <span class="browser-group-name">浏览器自动化引擎（MCP）</span>
        <button class="btn btn-ghost tiny" :disabled="enginesLoading" @click="refreshEngines">
          {{ enginesLoading ? '检测中…' : '刷新' }}
        </button>
      </div>

      <div v-if="enginesLoading && engines.length === 0" class="row-sub">正在检测引擎状态…</div>
      <div v-for="engine in engines" :key="engine.id" class="browser-card-item">
        <div class="row-text">
          <span class="card-main-title">{{ engine.id === 'playwright' ? 'Playwright（独立受控浏览器）' : 'Chrome DevTools' }}</span>
          <span v-if="engine.state === 'ready'" class="card-desc">
            已就绪 · {{ engine.toolCount }} 个工具{{ engine.enabled ? '' : '（已停用）' }}
          </span>
          <span v-else-if="engine.state === 'error'" class="card-desc">
            未就绪 · {{ engine.error ?? '启动失败' }}
          </span>
          <span v-else class="card-desc">已停用</span>
        </div>
        <label class="switch-control">
          <input type="checkbox" :checked="engine.enabled" @change="toggleEngine(engine)" />
          <span class="switch-slider" />
        </label>
      </div>
      <div v-if="!enginesLoading && engines.length === 0" class="row-sub">未能读取引擎状态，请稍后点「刷新」重试。</div>

      <div class="browser-card-item">
        <div class="row-text">
          <span class="card-main-title">更多 MCP 服务</span>
          <span class="card-desc">在「连接器 / MCP」中管理全部服务与参数。</span>
        </div>
        <button class="btn btn-ghost tiny" @click="goConnectors">连接器 / MCP</button>
      </div>
    </div>

    <!-- 第三组：外部浏览器 -->
    <div class="browser-group-block">
      <div class="group-title-row">
        <span class="browser-group-name">外部浏览器</span>
      </div>

      <div class="browser-card-item chrome-conn-item">
        <div class="row-text">
          <span class="card-main-title">连接到 Chrome</span>
          <span class="card-desc">本机 9222 调试端口就绪后，模型才能操作你已打开的 Chrome（含登录态）。</span>
          <a href="javascript:void(0)" class="chrome-link" @click="checkChromeDebuggingPort">尝试连接端口 9222 / 重新检测</a>
          <span v-if="chromeBrowserName" class="row-sub" style="display: block; margin-top: 4px;">{{ chromeBrowserName }}</span>
          <span v-if="chromeDetailsError" class="row-sub" style="display: block; margin-top: 4px; color: var(--danger, #c0392b);">{{ chromeDetailsError }}</span>
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

      <div class="browser-card-item">
        <div class="row-text">
          <span class="card-main-title">附着到已打开的 Chrome（9222）</span>
          <span class="card-desc">打开后 chrome-devtools 将附着到 127.0.0.1:9222，直接用你本机的 Chrome；关闭则恢复独立浏览器模式。切换后旧实例自动重建，无需重启应用。</span>
        </div>
        <label class="switch-control">
          <input type="checkbox" :checked="chromeAttach9222" @change="toggleChromeAttach" />
          <span class="switch-slider" />
        </label>
      </div>

      <div class="browser-card-item">
        <div class="row-text">
          <span class="card-main-title">一键启动调试版 Chrome</span>
          <span class="card-desc">未检测到 9222 时自动用独立配置目录启动（保留登录态，不占用你的默认 Chrome 配置）。</span>
        </div>
        <button class="btn btn-ghost tiny" :disabled="launchingChrome" @click="launchDebugChrome">
          {{ launchingChrome ? '启动中…' : '启动并检测' }}
        </button>
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

.browser-pane {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.pane-large-title {
  margin: 0;
  font-size: 20px;
  font-weight: 700;
  color: var(--text);
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
