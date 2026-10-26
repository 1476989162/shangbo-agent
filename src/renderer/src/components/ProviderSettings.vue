<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import type { Provider, ProviderKind } from '@shared/types'
import { useChatStore } from '../stores/chat'
import { isFreeModel, parseHeaders, parseModels, providerHost, providerInitial } from '../lib/providers'

const store = useChatStore()

interface ProviderForm {
  id?: string
  name: string
  kind: ProviderKind
  baseUrl: string
  apiKey: string
  modelsText: string
  headersText: string
  enabled: boolean
  priority: number
}

const providers = ref<Provider[]>([])
const editing = ref<ProviderForm | null>(null)
const busy = ref(false)
const feedback = ref<{ ok: boolean; message: string } | null>(null)

const providerSearch = ref('')
const selectedId = ref<string | null>(null)
const detailTab = ref<'all' | 'selected'>('all')
const detailQuery = ref('')
const detailExpanded = ref(false)
const detailShowKey = ref(false)
const detailNewModel = ref('')

function blankForm(): ProviderForm {
  return {
    name: '',
    kind: 'openai-compatible',
    baseUrl: 'https://api.deepseek.com/v1',
    apiKey: '',
    modelsText: '',
    headersText: '',
    enabled: true,
    priority: 50
  }
}

async function load(): Promise<void> {
  providers.value = await window.shangbo.provider.list()
}

onMounted(() => {
  void load()
})

const filteredProviders = computed(() => {
  const q = providerSearch.value.trim().toLowerCase()
  if (!q) return providers.value
  return providers.value.filter(
    (p) =>
      p.name.toLowerCase().includes(q) ||
      p.baseUrl.toLowerCase().includes(q) ||
      p.models.some((m) => m.toLowerCase().includes(q))
  )
})

const selectedProvider = computed(() =>
  selectedId.value && selectedId.value !== '__new'
    ? (providers.value.find((p) => p.id === selectedId.value) ?? null)
    : null
)

const isNew = computed(() => selectedId.value === '__new')

function startEdit(p: Provider): void {
  feedback.value = null
  editing.value = {
    id: p.id,
    name: p.name,
    kind: p.kind,
    baseUrl: p.baseUrl,
    apiKey: '',
    modelsText: p.models.join('\n'),
    headersText: Object.entries(p.headers).map(([k, v]) => `${k}: ${v}`).join('\n'),
    enabled: p.enabled,
    priority: p.priority
  }
}

function openDetail(p: Provider): void {
  selectedId.value = p.id
  detailTab.value = 'all'
  detailQuery.value = ''
  detailExpanded.value = false
  detailShowKey.value = false
  detailNewModel.value = ''
  startEdit(p)
}

function startCreateNew(): void {
  feedback.value = null
  editing.value = blankForm()
  selectedId.value = '__new'
  detailTab.value = 'all'
  detailQuery.value = ''
  detailExpanded.value = false
  detailShowKey.value = false
  detailNewModel.value = ''
}

function closeDetail(): void {
  selectedId.value = null
  editing.value = null
}

function getVisibleCount(p: Provider): number {
  return p.models.filter((m) => !store.isModelHidden(p.id, m)).length
}

const detailVisibleModels = computed(() => {
  const q = detailQuery.value.trim().toLowerCase()
  let list: string[] = []
  let pid = ''
  if (selectedProvider.value) {
    list = [...selectedProvider.value.models]
    pid = selectedProvider.value.id
  } else if (isNew.value && editing.value) {
    list = parseModels(editing.value.modelsText)
    pid = '__new'
  }
  if (q) list = list.filter((m) => m.toLowerCase().includes(q))
  if (detailTab.value === 'selected' && pid && pid !== '__new') {
    list = list.filter((m) => !store.isModelHidden(pid, m))
  }
  return list
})

async function toggleEnabled(p: Provider): Promise<void> {
  busy.value = true
  try {
    await window.shangbo.provider.upsert({
      id: p.id,
      name: p.name,
      kind: p.kind,
      baseUrl: p.baseUrl,
      models: p.models,
      enabled: !p.enabled,
      priority: p.priority,
      headers: p.headers
    })
    await store.loadProviders()
    await load()
  } finally {
    busy.value = false
  }
}

async function showAll(p: Provider): Promise<void> {
  await store.setModelsHiddenBatch(p.id, p.models, false)
}

async function hideAll(p: Provider): Promise<void> {
  await store.setModelsHiddenBatch(p.id, p.models, true)
}

async function selectFreeOnly(): Promise<void> {
  const p = selectedProvider.value
  if (!p) return
  const free = p.models.filter((m) => isFreeModel(m))
  const hidden = p.models.filter((m) => !isFreeModel(m))
  await store.setModelsHiddenBatch(p.id, free, false)
  await store.setModelsHiddenBatch(p.id, hidden, true)
}

function toggleModel(pid: string, m: string): void {
  if (pid === '__new') {
    // 新建时还没 pid：只改 editing 文本勾选态用本地集合
    void store.toggleModelHidden(pid, m)
    return
  }
  void store.toggleModelHidden(pid, m)
}

function addDetailModel(): void {
  if (!editing.value) return
  const v = detailNewModel.value.trim()
  if (!v) return
  const cur = parseModels(editing.value.modelsText)
  if (!cur.includes(v)) {
    cur.push(v)
    editing.value.modelsText = cur.join('\n')
  }
  detailNewModel.value = ''
}

async function saveProvider(): Promise<void> {
  if (!editing.value) return
  const form = editing.value
  const models = parseModels(form.modelsText)
  if (!isNew.value && models.length === 0) {
    feedback.value = { ok: false, message: '请至少保留一个模型' }
    return
  }
  if (isNew.value && models.length === 0) {
    feedback.value = { ok: false, message: '请至少指定一个模型名' }
    return
  }
  busy.value = true
  feedback.value = null
  try {
    const saved = await window.shangbo.provider.upsert({
      id: isNew.value ? undefined : form.id,
      name: form.name.trim(),
      kind: form.kind,
      baseUrl: form.baseUrl.trim(),
      apiKey: form.apiKey.trim() || undefined,
      models,
      enabled: form.enabled,
      priority: Number(form.priority) || 50,
      headers: parseHeaders(form.headersText)
    })
    await store.loadProviders()
    await load()
    selectedId.value = saved.id
    startEdit(saved)
    detailNewModel.value = ''
    feedback.value = { ok: true, message: '供应商配置保存成功' }
  } catch (e) {
    feedback.value = { ok: false, message: e instanceof Error ? e.message : String(e) }
  } finally {
    busy.value = false
  }
}

async function testCurrent(): Promise<void> {
  const p = selectedProvider.value
  if (!p) return
  busy.value = true
  feedback.value = null
  try {
    const r = await window.shangbo.provider.test(p.id)
    feedback.value = {
      ok: r.ok,
      message: r.ok ? `测试成功（响应延迟 ${r.latencyMs}ms）：${r.message}` : `测试失败：${r.message}`
    }
  } catch (e) {
    feedback.value = { ok: false, message: e instanceof Error ? e.message : String(e) }
  } finally {
    busy.value = false
  }
}

async function removeCurrent(): Promise<void> {
  const p = selectedProvider.value
  if (!p) return
  if (!confirm(`确定要移除供应商「${p.name}」吗？`)) return
  busy.value = true
  try {
    await window.shangbo.provider.remove(p.id)
    await store.loadProviders()
    await load()
    closeDetail()
    feedback.value = { ok: true, message: '已移除供应商' }
  } catch (e) {
    feedback.value = { ok: false, message: e instanceof Error ? e.message : String(e) }
  } finally {
    busy.value = false
  }
}

async function fetchModels(): Promise<void> {
  if (!editing.value) return
  const form = editing.value
  busy.value = true
  feedback.value = null
  try {
    const models = await window.shangbo.provider.fetchModels({
      id: form.id,
      name: form.name.trim() || '临时测试',
      kind: form.kind,
      baseUrl: form.baseUrl.trim(),
      apiKey: form.apiKey.trim() || undefined,
      models: [],
      enabled: true,
      priority: 50,
      headers: parseHeaders(form.headersText)
    })
    form.modelsText = models.join('\n')
    feedback.value = { ok: true, message: `成功拉取到 ${models.length} 个模型` }
  } catch (e) {
    feedback.value = { ok: false, message: `拉取失败：${e instanceof Error ? e.message : String(e)}` }
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="prov-wrap">
    <div v-if="feedback" class="prov-toast" :class="{ error: !feedback.ok }">
      {{ feedback.message }}
    </div>

    <!-- 列表页：对标图2 -->
    <template v-if="!selectedId">
      <div class="prov-topbar">
        <h3 class="prov-title">供应商</h3>
        <input v-model="providerSearch" class="prov-search" placeholder="查找供应商" spellcheck="false" />
      </div>
      <p class="prov-tip">密钥由系统安全密钥环加密托管于本地，支持 OpenAI 兼容、Responses 协议及 Anthropic 直连。</p>
      <div class="prov-list-card">
        <div
          v-for="p in filteredProviders"
          :key="p.id"
          class="prov-row"
          :class="{ disabled: !p.enabled }"
          @click="openDetail(p)"
        >
          <div class="prov-icon">{{ providerInitial(p.name) }}</div>
          <div class="prov-main">
            <div class="prov-name">{{ p.name }}<span v-if="p.kind === 'openai-responses'" class="prov-badge">Responses</span><span v-else-if="p.kind === 'anthropic'" class="prov-badge">Anthropic</span></div>
            <div class="prov-sub">{{ providerHost(p.baseUrl) }} · {{ p.models.length }} 个模型</div>
          </div>
          <span class="prov-dot" :class="{ on: p.enabled && p.hasApiKey, off: !(p.enabled && p.hasApiKey) }" />
          <span class="prov-keystate">{{ p.hasApiKey ? `${getVisibleCount(p)}/${p.models.length} 可见` : '缺少密钥' }}</span>
          <label class="switch-control prov-switch" @click.stop>
            <input type="checkbox" :checked="p.enabled" @change="toggleEnabled(p)" />
            <span class="switch-slider" />
          </label>
          <span class="prov-arrow">›</span>
        </div>
        <p v-if="filteredProviders.length === 0" class="prov-empty">没有匹配的供应商。</p>
      </div>
      <button class="btn btn-primary tiny prov-add" :disabled="busy" @click="startCreateNew">+ 新增端点</button>
    </template>

    <!-- 详情页：对标图3 -->
    <template v-else-if="editing">
      <div class="prov-detail-head">
        <button class="btn btn-ghost tiny" @click="closeDetail">‹ 返回</button>
        <div class="prov-detail-title">
          <span class="prov-icon">{{ providerInitial(editing.name || '新') }}</span>
          <div>
            <div class="prov-name">{{ editing.name || '新建供应商' }}</div>
            <div class="prov-sub mono">{{ editing.baseUrl }}</div>
          </div>
        </div>
        <div class="prov-detail-actions">
          <button v-if="!isNew" class="btn btn-ghost tiny" :disabled="busy" @click="testCurrent">测试模型</button>
          <button v-if="!isNew" class="btn btn-ghost tiny btn-danger" :disabled="busy" @click="removeCurrent">删除</button>
        </div>
      </div>

      <form class="prov-detail-form" @submit.prevent="saveProvider">
        <div class="prov-field-row">
          <span class="prov-field-label">名称</span>
          <input v-model="editing.name" class="input prov-input" placeholder="例如 OpenCode Go" required />
        </div>
        <div class="prov-field-row">
          <span class="prov-field-label">ID</span>
          <input class="input prov-input mono" :value="isNew ? '(保存后生成)' : (selectedProvider?.id ?? '')" disabled />
        </div>
        <div class="prov-field-row">
          <span class="prov-field-label">协议</span>
          <select v-model="editing.kind" class="input prov-input">
            <option value="openai-compatible">OpenAI 兼容 (/chat/completions)</option>
            <option value="openai-responses">OpenAI Responses 协议 (/responses)</option>
            <option value="anthropic">Anthropic 原生协议 (/v1/messages)</option>
          </select>
        </div>
        <div class="prov-field-row">
          <span class="prov-field-label">端点</span>
          <input v-model="editing.baseUrl" class="input prov-input mono" placeholder="https://..." required />
        </div>
        <div class="prov-field-row">
          <span class="prov-field-label">账号</span>
          <input
            v-model="editing.apiKey"
            class="input prov-input mono"
            :type="detailShowKey ? 'text' : 'password'"
            :placeholder="isNew ? '输入你的 API 密钥' : '留空保持原有密钥不变，粘贴即替换'"
            autocomplete="off"
          />
          <button type="button" class="btn btn-ghost tiny" @click="detailShowKey = !detailShowKey">
            {{ detailShowKey ? '隐藏' : '显示' }}
          </button>
        </div>
        <p class="prov-field-tip">勾选要使用的模型。请求先走已勾选，Agent 下拉列表只显示已勾选。</p>

        <div class="prov-models-head">
          <span class="prov-field-label">模型</span>
          <div class="prov-models-tabs">
            <button type="button" class="prov-tab" :class="{ active: detailTab === 'all' }" @click="detailTab = 'all'">供应商列表</button>
            <button type="button" class="prov-tab" :class="{ active: detailTab === 'selected' }" @click="detailTab = 'selected'">仅所选</button>
          </div>
        </div>
        <div class="prov-models-toolbar">
          <input v-model="detailQuery" class="input prov-input" :placeholder="`筛选 ${detailVisibleModels.length} 个模型...`" />
          <button v-if="selectedProvider" type="button" class="btn btn-ghost tiny" @click="showAll(selectedProvider)">全选</button>
          <button v-if="selectedProvider" type="button" class="btn btn-ghost tiny" @click="hideAll(selectedProvider)">全不选</button>
          <button v-if="selectedProvider" type="button" class="btn btn-ghost tiny" @click="selectFreeOnly">只选免费</button>
        </div>
        <div class="prov-pills" :class="{ collapsed: !detailExpanded && detailVisibleModels.length > 14 }">
          <button
            v-for="m in (detailExpanded ? detailVisibleModels : detailVisibleModels.slice(0, 14))"
            :key="m"
            type="button"
            class="prov-pill"
            :class="{ on: selectedProvider ? !store.isModelHidden(selectedProvider.id, m) : true }"
            :title="m"
            @click="selectedProvider && toggleModel(selectedProvider.id, m)"
          >{{ (selectedProvider && !store.isModelHidden(selectedProvider.id, m) ? '✓ ' : '') + m }}</button>
        </div>
        <button
          v-if="detailVisibleModels.length > 14"
          type="button"
          class="prov-expand"
          @click="detailExpanded = !detailExpanded"
        >{{ detailExpanded ? '收起列表 ˄' : '展开列表 ˅' }}</button>

        <div class="prov-models-toolbar">
          <input v-model="detailNewModel" class="input prov-input mono" placeholder="添加模型 ID..." />
          <button type="button" class="btn btn-ghost tiny" @click="addDetailModel">添加模型</button>
          <button type="button" class="btn btn-ghost tiny" :disabled="busy" @click="fetchModels">重新获取模型</button>
        </div>

        <details class="prov-adv">
          <summary>高级：自定义请求头与优先级</summary>
          <textarea v-model="editing.headersText" class="input mono prov-headers" rows="2" placeholder="x-custom: value（每行一个）" />
          <div class="prov-priority-row">
            <span>优先级（越小越优先）</span>
            <input v-model.number="editing.priority" type="number" class="input prov-priority" />
          </div>
        </details>

        <div class="prov-detail-foot">
          <span v-if="selectedProvider" class="prov-foot-state">{{ getVisibleCount(selectedProvider) }}/{{ selectedProvider.models.length }} 可见</span>
          <span v-else class="prov-foot-state">新建端点</span>
          <div class="prov-foot-actions">
            <button type="button" class="btn btn-ghost tiny" @click="closeDetail">取消</button>
            <button type="submit" class="btn btn-primary tiny" :disabled="busy">保存</button>
          </div>
        </div>
      </form>
    </template>
  </div>
</template>

<style scoped>
.prov-wrap { display: flex; flex-direction: column; gap: 12px; }
.prov-toast { padding: 8px 14px; border-radius: 6px; background: var(--success-soft); color: var(--success); border: 1px solid var(--success); font-size: 12px; }
.prov-toast.error { background: var(--danger-soft); color: var(--danger); border-color: var(--danger); }
.prov-topbar { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
.prov-title { margin: 0; font-size: 18px; font-weight: 700; }
.prov-search { width: 220px; padding: 7px 12px; font-size: 12.5px; border-radius: 8px; border: 1px solid var(--border); background: var(--surface); color: var(--text); outline: none; }
.prov-tip { margin: 0; font-size: 12px; color: var(--text-muted); }
.prov-list-card { background: var(--surface); border: 1px solid var(--border); border-radius: 12px; overflow: hidden; }
.prov-row { display: flex; align-items: center; gap: 12px; padding: 12px 14px; cursor: pointer; border-bottom: 1px solid var(--border); }
.prov-row:last-child { border-bottom: none; }
.prov-row:hover { background: var(--surface-hover); }
.prov-row.disabled { opacity: 0.65; }
.prov-icon { width: 32px; height: 32px; border-radius: 8px; background: var(--bg-elevated); border: 1px solid var(--border); display: flex; align-items: center; justify-content: center; font-size: 12px; font-weight: 700; flex-shrink: 0; }
.prov-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.prov-name { font-size: 13.5px; font-weight: 600; }
.prov-badge { margin-left: 6px; padding: 1px 6px; font-size: 10px; font-weight: 500; border-radius: 999px; background: rgba(84,104,255,0.14); color: #5468ff; border: 1px solid rgba(84,104,255,0.35); vertical-align: 1px; }
.prov-sub { font-size: 11.5px; color: var(--text-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.prov-dot { width: 7px; height: 7px; border-radius: 50%; flex-shrink: 0; }
.prov-dot.on { background: #2ea043; }
.prov-dot.off { background: var(--border-strong); }
.prov-keystate { font-size: 11.5px; color: var(--text-muted); white-space: nowrap; }
.prov-switch { width: 36px; height: 20px; }
.prov-arrow { color: var(--text-subtle); font-size: 16px; }
.prov-empty { padding: 16px; text-align: center; }
.prov-add { align-self: flex-start; }
.prov-detail-head { display: flex; align-items: center; gap: 12px; }
.prov-detail-title { flex: 1; display: flex; align-items: center; gap: 10px; min-width: 0; }
.prov-detail-actions { display: flex; gap: 6px; }
.prov-detail-form { display: flex; flex-direction: column; gap: 10px; background: var(--surface); border: 1px solid var(--border); border-radius: 12px; padding: 16px; }
.prov-field-row { display: flex; align-items: center; gap: 10px; }
.prov-field-label { width: 44px; flex-shrink: 0; font-size: 12.5px; color: var(--text-muted); }
.prov-input { flex: 1; }
.prov-field-tip { margin: 0; font-size: 11.5px; color: var(--text-muted); }
.prov-models-head { display: flex; align-items: center; justify-content: space-between; margin-top: 4px; }
.prov-models-tabs { display: flex; gap: 6px; }
.prov-tab { padding: 5px 12px; font-size: 12px; border-radius: 999px; border: 1px solid var(--border); background: var(--bg-elevated); }
.prov-tab.active { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 600; }
.prov-models-toolbar { display: flex; gap: 8px; align-items: center; }
.prov-pills { display: flex; flex-wrap: wrap; gap: 8px; }
.prov-pill { padding: 5px 12px; font-size: 12px; border-radius: 999px; border: 1px solid var(--border); background: var(--bg-elevated); color: var(--text-muted); cursor: pointer; max-width: 260px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.prov-pill.on { border-color: #5468ff; background: rgba(84, 104, 255, 0.14); color: var(--text); font-weight: 500; }
.prov-expand { background: none; border: none; color: var(--text-muted); font-size: 12px; cursor: pointer; align-self: center; }
.prov-adv { border-top: 1px solid var(--border); padding-top: 8px; font-size: 12px; color: var(--text-muted); }
.prov-headers { width: 100%; margin-top: 8px; }
.prov-priority-row { display: flex; align-items: center; justify-content: space-between; margin-top: 8px; }
.prov-priority { width: 100px; }
.prov-detail-foot { display: flex; align-items: center; justify-content: space-between; border-top: 1px solid var(--border); padding-top: 12px; margin-top: 4px; }
.prov-foot-state { font-size: 12px; color: var(--text-muted); }
.prov-foot-actions { display: flex; gap: 8px; }
.switch-control { position: relative; display: inline-block; width: 36px; height: 20px; cursor: pointer; }
.switch-control input { opacity: 0; width: 0; height: 0; }
.switch-slider { position: absolute; inset: 0; background: var(--border-strong); border-radius: 20px; transition: 0.2s; }
.switch-slider:before { position: absolute; content: ''; height: 14px; width: 14px; left: 3px; bottom: 3px; background: white; border-radius: 50%; transition: 0.2s; }
.switch-control input:checked + .switch-slider { background: var(--accent); }
.switch-control input:checked + .switch-slider:before { transform: translateX(16px); }
</style>
