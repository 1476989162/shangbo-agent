<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import type { AppInfo, Provider, ProviderKind } from '@shared/types'
import { useChatStore } from '../stores/chat'

const props = defineProps<{ open: boolean; theme: 'light' | 'dark' | 'system' }>()
const emit = defineEmits<{ 'update:open': [value: boolean]; 'update:theme': [value: 'light' | 'dark' | 'system'] }>()

const store = useChatStore()

type Tab = 'providers' | 'general'

interface ProviderForm {
  id?: string
  name: string
  kind: ProviderKind
  baseUrl: string
  apiKey: string
  modelsText: string
  enabled: boolean
  priority: number
}

const tab = ref<Tab>('providers')
const providers = ref<Provider[]>([])
const editing = ref<ProviderForm | null>(null)
const busy = ref(false)
const feedback = ref<{ ok: boolean; message: string } | null>(null)
const appInfo = ref<AppInfo | null>(null)
const budgetTokens = ref(32000)
const autoApprove = ref<string[]>([])

const isEditingExisting = computed(() => Boolean(editing.value?.id))

function blankForm(): ProviderForm {
  return {
    name: '',
    kind: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    modelsText: '',
    enabled: true,
    priority: 50
  }
}

async function load(): Promise<void> {
  providers.value = await window.shangbo.provider.list()
  const settings = await window.shangbo.settings.getAll()
  budgetTokens.value = (settings['agent.contextBudgetTokens'] as number) ?? 32000
  autoApprove.value = (settings['tools.autoApprove'] as string[]) ?? []
  appInfo.value = await window.shangbo.app.info()
}

onMounted(() => {
  void load()
})

watch(
  () => props.open,
  (open) => {
    if (!open) return
    feedback.value = null
    editing.value = null
    void load()
  }
)

function startCreate(): void {
  feedback.value = null
  editing.value = blankForm()
}

function startEdit(provider: Provider): void {
  feedback.value = null
  editing.value = {
    id: provider.id,
    name: provider.name,
    kind: provider.kind,
    baseUrl: provider.baseUrl,
    apiKey: '',
    modelsText: provider.models.join('\n'),
    enabled: provider.enabled,
    priority: provider.priority
  }
}

function parseModels(text: string): string[] {
  return text
    .split(/[\n,，]/)
    .map((item) => item.trim())
    .filter(Boolean)
}

async function save(): Promise<void> {
  const form = editing.value
  if (!form) return
  busy.value = true
  feedback.value = null
  try {
    await window.shangbo.provider.upsert({
      id: form.id,
      name: form.name.trim(),
      kind: form.kind,
      baseUrl: form.baseUrl.trim(),
      // 留空表示不修改已保存的密钥
      apiKey: form.apiKey.trim() || undefined,
      models: parseModels(form.modelsText),
      enabled: form.enabled,
      priority: form.priority
    })
    editing.value = null
    await load()
    await store.loadProviders()
    feedback.value = { ok: true, message: '已保存' }
  } catch (error) {
    feedback.value = { ok: false, message: error instanceof Error ? error.message : String(error) }
  } finally {
    busy.value = false
  }
}

async function remove(provider: Provider): Promise<void> {
  busy.value = true
  try {
    await window.shangbo.provider.remove(provider.id)
    if (editing.value?.id === provider.id) editing.value = null
    await load()
    await store.loadProviders()
    feedback.value = { ok: true, message: `已删除「${provider.name}」` }
  } finally {
    busy.value = false
  }
}

async function test(provider: Provider): Promise<void> {
  busy.value = true
  feedback.value = null
  try {
    const result = await window.shangbo.provider.test(provider.id)
    feedback.value = {
      ok: result.ok,
      message: result.ok ? `${result.message}（${result.latencyMs} ms）` : result.message
    }
  } finally {
    busy.value = false
  }
}

async function fetchModels(): Promise<void> {
  const form = editing.value
  if (!form) return
  busy.value = true
  feedback.value = null
  try {
    const models = await window.shangbo.provider.fetchModels({
      id: form.id,
      name: form.name.trim() || '临时配置',
      kind: form.kind,
      baseUrl: form.baseUrl.trim(),
      apiKey: form.apiKey.trim() || undefined,
      models: [],
      enabled: true,
      priority: form.priority
    })
    if (models.length === 0) {
      feedback.value = { ok: false, message: '接口没有返回任何模型' }
    } else {
      form.modelsText = models.join('\n')
      feedback.value = { ok: true, message: `已拉取 ${models.length} 个模型` }
    }
  } catch (error) {
    feedback.value = { ok: false, message: error instanceof Error ? error.message : String(error) }
  } finally {
    busy.value = false
  }
}

async function saveBudget(): Promise<void> {
  await window.shangbo.settings.set('agent.contextBudgetTokens', budgetTokens.value)
  feedback.value = { ok: true, message: '已保存上下文预算' }
}

async function clearAutoApprove(): Promise<void> {
  autoApprove.value = []
  await window.shangbo.settings.set('tools.autoApprove', [])
  feedback.value = { ok: true, message: '已清空自动放行列表' }
}

function close(): void {
  emit('update:open', false)
}
</script>

<template>
  <div v-if="props.open" class="overlay" @click.self="close" @keydown.esc="close">
    <div class="dialog" role="dialog" aria-modal="true">
      <header class="dialog-head">
        <h2 class="dialog-title">设置</h2>
        <button class="btn btn-ghost icon-only" title="关闭" @click="close">✕</button>
      </header>

      <nav class="tabs">
        <button class="tab" :class="{ active: tab === 'providers' }" @click="tab = 'providers'">
          模型供应商
        </button>
        <button class="tab" :class="{ active: tab === 'general' }" @click="tab = 'general'">
          通用
        </button>
      </nav>

      <div class="dialog-body">
        <template v-if="tab === 'providers'">
          <p class="hint subtle">
            密钥通过系统密钥环加密保存在本机，不会写入数据库，也不会发送到除该供应商以外的任何地方。
            优先级的数值越小越先被使用，失败时会自动降级到下一个可用供应商。
          </p>

          <div class="provider-list">
            <div v-for="provider in providers" :key="provider.id" class="provider-row">
              <div class="provider-info">
                <div class="provider-name-line">
                  <span class="provider-name">{{ provider.name }}</span>
                  <span v-if="provider.enabled" class="tag tag-on">已启用</span>
                  <span v-else class="tag">已停用</span>
                  <span v-if="provider.hasApiKey" class="tag tag-key">已配置密钥</span>
                  <span v-else class="tag tag-warn">缺少密钥</span>
                </div>
                <p class="provider-meta subtle mono">{{ provider.baseUrl }}</p>
              </div>
              <div class="provider-actions">
                <button class="btn btn-ghost tiny" :disabled="busy" @click="test(provider)">测试</button>
                <button class="btn btn-ghost tiny" :disabled="busy" @click="startEdit(provider)">
                  编辑
                </button>
                <button class="btn btn-ghost tiny btn-danger" :disabled="busy" @click="remove(provider)">
                  删除
                </button>
              </div>
            </div>

            <p v-if="providers.length === 0" class="hint subtle">还没有任何供应商，先新建一个。</p>
          </div>

          <button v-if="!editing" class="btn" :disabled="busy" @click="startCreate">
            + 新建供应商
          </button>

          <form v-if="editing" class="editor" @submit.prevent="save">
            <h3 class="editor-title">{{ isEditingExisting ? '编辑供应商' : '新建供应商' }}</h3>

            <div class="grid-2">
              <label class="field">
                <span class="field-label">名称</span>
                <input v-model="editing.name" class="input" placeholder="例如 DeepSeek" required />
              </label>

              <label class="field">
                <span class="field-label">协议类型</span>
                <select v-model="editing.kind" class="input">
                  <option value="openai-compatible">OpenAI 兼容（/chat/completions）</option>
                  <option value="anthropic">Anthropic（/v1/messages）</option>
                </select>
              </label>
            </div>

            <label class="field">
              <span class="field-label">Base URL</span>
              <input
                v-model="editing.baseUrl"
                class="input mono"
                placeholder="https://api.deepseek.com/v1"
                required
              />
              <span class="field-hint subtle">
                OpenAI 兼容协议请带上版本前缀（如 /v1）；Anthropic 填 https://api.anthropic.com
              </span>
            </label>

            <label class="field">
              <span class="field-label">API Key</span>
              <input
                v-model="editing.apiKey"
                class="input mono"
                type="password"
                :placeholder="isEditingExisting ? '留空表示不修改' : 'sk-...'"
              />
            </label>

            <label class="field">
              <span class="field-label">模型列表（每行一个，或用逗号分隔）</span>
              <textarea v-model="editing.modelsText" class="textarea mono" rows="4" />
            </label>

            <div class="grid-2">
              <label class="field">
                <span class="field-label">优先级（越小越优先）</span>
                <input v-model.number="editing.priority" class="input" type="number" min="0" />
              </label>

              <label class="checkbox">
                <input v-model="editing.enabled" type="checkbox" />
                <span>启用该供应商</span>
              </label>
            </div>

            <div class="editor-actions">
              <button class="btn btn-primary" type="submit" :disabled="busy">保存</button>
              <button class="btn" type="button" :disabled="busy" @click="fetchModels">
                拉取模型列表
              </button>
              <button class="btn btn-ghost" type="button" @click="editing = null">取消</button>
            </div>
          </form>
        </template>

        <template v-else>
          <section class="section">
            <h3 class="section-title">外观</h3>
            <div class="segmented">
              <button
                v-for="option in (['light', 'dark', 'system'] as const)"
                :key="option"
                class="segment"
                :class="{ active: props.theme === option }"
                @click="emit('update:theme', option)"
              >
                {{ option === 'light' ? '浅色' : option === 'dark' ? '深色' : '跟随系统' }}
              </button>
            </div>
          </section>

          <section class="section">
            <h3 class="section-title">上下文预算</h3>
            <p class="hint subtle">
              超过预算时，最旧的对话轮次会被整轮裁掉（以轮为单位，避免破坏工具调用与结果的配对关系）。
            </p>
            <div class="inline-row">
              <input v-model.number="budgetTokens" class="input narrow" type="number" min="2000" step="1000" />
              <span class="muted">tokens</span>
              <button class="btn" @click="saveBudget">保存</button>
            </div>
          </section>

          <section class="section">
            <h3 class="section-title">工具自动放行</h3>
            <p class="hint subtle">
              这些工具不会再弹出确认框。写文件与执行命令默认需要确认，请谨慎放行。
            </p>
            <div v-if="autoApprove.length" class="inline-row">
              <span v-for="name in autoApprove" :key="name" class="tag mono">{{ name }}</span>
              <button class="btn btn-ghost tiny" @click="clearAutoApprove">全部撤销</button>
            </div>
            <p v-else class="hint subtle">当前没有自动放行的工具。</p>
          </section>

          <section v-if="appInfo" class="section">
            <h3 class="section-title">系统信息</h3>
            <dl class="info">
              <div><dt>版本</dt><dd class="mono">{{ appInfo.version }}</dd></div>
              <div><dt>Electron</dt><dd class="mono">{{ appInfo.electron }}</dd></div>
              <div><dt>Node</dt><dd class="mono">{{ appInfo.node }}</dd></div>
              <div><dt>Chromium</dt><dd class="mono">{{ appInfo.chrome }}</dd></div>
              <div><dt>数据目录</dt><dd class="mono break">{{ appInfo.userDataPath }}</dd></div>
              <div><dt>数据库</dt><dd class="mono break">{{ appInfo.dbPath }}</dd></div>
            </dl>
          </section>
        </template>

        <p v-if="feedback" class="feedback" :class="feedback.ok ? 'ok' : 'fail'">
          {{ feedback.message }}
        </p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--text) 32%, transparent);
  backdrop-filter: blur(2px);
}

.dialog {
  display: flex;
  flex-direction: column;
  width: min(760px, calc(100vw - 64px));
  max-height: calc(100vh - 96px);
  background: var(--bg);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-lg);
  overflow: hidden;
}

.dialog-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px 12px;
}

.dialog-title {
  margin: 0;
  font-size: var(--text-lg);
  font-weight: 600;
}

.icon-only {
  padding: 4px 8px;
  border-radius: var(--radius-sm);
  color: var(--text-muted);
}

.tabs {
  display: flex;
  gap: 4px;
  padding: 0 20px;
  border-bottom: 1px solid var(--border);
}

.tab {
  padding: 8px 12px;
  margin-bottom: -1px;
  border-bottom: 2px solid transparent;
  color: var(--text-muted);
  font-size: var(--text-sm);
}

.tab.active {
  border-bottom-color: var(--accent);
  color: var(--text);
}

.dialog-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px 20px 20px;
}

.hint {
  margin: 0 0 14px;
  font-size: var(--text-xs);
  line-height: 1.7;
}

.provider-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  margin-bottom: 12px;
}

.provider-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-elevated);
}

.provider-info {
  flex: 1;
  min-width: 0;
}

.provider-name-line {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-wrap: wrap;
}

.provider-name {
  font-size: var(--text-sm);
  font-weight: 600;
}

.provider-meta {
  margin: 3px 0 0;
  font-size: 11px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.provider-actions {
  display: flex;
  gap: 2px;
  flex: none;
}

.tag {
  padding: 1px 7px;
  border-radius: var(--radius-full);
  background: var(--surface);
  border: 1px solid var(--border);
  color: var(--text-muted);
  font-size: 11px;
}

.tag-on {
  background: var(--success-soft);
  border-color: color-mix(in srgb, var(--success) 40%, transparent);
  color: var(--success);
}

.tag-key {
  background: var(--accent-soft);
  border-color: color-mix(in srgb, var(--accent) 35%, transparent);
  color: var(--accent);
}

.tag-warn {
  background: var(--danger-soft);
  border-color: color-mix(in srgb, var(--danger) 35%, transparent);
  color: var(--danger);
}

.tiny {
  padding: 2px 8px;
  font-size: var(--text-xs);
  border-radius: var(--radius-sm);
}

.editor {
  margin-top: 14px;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-elevated);
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.editor-title {
  margin: 0;
  font-size: var(--text-sm);
  font-weight: 600;
}

.grid-2 {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 12px;
}

.field-hint {
  font-size: 11px;
}

.checkbox {
  display: flex;
  align-items: center;
  gap: 8px;
  align-self: end;
  padding-bottom: 9px;
  font-size: var(--text-sm);
}

.checkbox input {
  width: 15px;
  height: 15px;
  accent-color: var(--accent);
}

.editor-actions {
  display: flex;
  gap: 8px;
}

.section {
  padding: 14px 0;
  border-bottom: 1px solid var(--border);
}

.section:last-of-type {
  border-bottom: none;
}

.section-title {
  margin: 0 0 8px;
  font-size: var(--text-sm);
  font-weight: 600;
}

.segmented {
  display: inline-flex;
  padding: 2px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--surface);
}

.segment {
  padding: 5px 14px;
  border-radius: var(--radius-sm);
  font-size: var(--text-sm);
  color: var(--text-muted);
}

.segment.active {
  background: var(--bg-elevated);
  color: var(--text);
  box-shadow: var(--shadow-sm);
}

.inline-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}

.narrow {
  width: 130px;
}

.info {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: var(--text-xs);
}

.info > div {
  display: grid;
  grid-template-columns: 90px 1fr;
  gap: 10px;
}

.info dt {
  color: var(--text-muted);
}

.info dd {
  margin: 0;
}

.break {
  word-break: break-all;
}

.feedback {
  margin: 14px 0 0;
  padding: 8px 12px;
  border-radius: var(--radius);
  font-size: var(--text-sm);
  white-space: pre-wrap;
}

.feedback.ok {
  background: var(--success-soft);
  color: var(--success);
}

.feedback.fail {
  background: var(--danger-soft);
  color: var(--danger);
}
</style>