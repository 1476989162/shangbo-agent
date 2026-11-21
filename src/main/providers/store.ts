import { randomUUID } from 'node:crypto'
import { getDb } from '../db'
import { deleteSecret, getSecret, hasSecret, setSecret } from '../secrets'
import { getSetting, setSetting } from '../settings'
import { anthropicAdapter } from './anthropic'
import { openAiCompatibleAdapter } from './openai'
import { openAiResponsesAdapter } from './responses'
import type { Provider, ProviderInput, ProviderKind } from '../../shared/types'
import type { ProviderAdapter } from './types'

const secretKey = (id: string) => `provider:${id}`
const SEED_FLAG = 'providers.seeded'

/** Magpie 网关种子唯一真源：新增模型只改这里，种子+自愈共用。 */
export const MAGPIE_BASE_URL = 'http://127.0.0.1:34254/v1'

/**
 * 本地推理引擎（OpenAI 兼容 / Anthropic messages / responses 三协议的常见端口）。
 * 预置但默认禁用：只有用户在本机跑起引擎并「真题验活」通过后才应启用，
 * 避免把一个没装好的端点混进供应商降级链。模型清单可在设置页用 /v1/models 刷新。
 */
export const LOCAL_ENGINE_BASE_URL = 'http://127.0.0.1:8080/v1'
export const LOCAL_ENGINE_MODELS = ['Qwen3.8-Flash-Next', 'Qwen3.6-35B-A3B', 'Qwen2.5-7B']
export const MAGPIE_MODELS = [
  'trae-cn/deepseek-v4.1-flash-max',
  'maas-qianwenaiapi/deepseek-v4.1-flash-1017',
  'maas-qianwenaiapi/glm-5.3-flash',
  'maas-qianwenaiapi/qwen3.8-flash'
]

interface ProviderRow {
  id: string
  name: string
  kind: string
  base_url: string
  models: string
  enabled: number
  priority: number
  headers: string
  created_at: number
  updated_at: number
}

function toProvider(row: ProviderRow): Provider {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind as ProviderKind,
    baseUrl: row.base_url,
    models: JSON.parse(row.models) as string[],
    enabled: row.enabled === 1,
    priority: row.priority,
    headers: JSON.parse(row.headers || '{}') as Record<string, string>,
    hasApiKey: hasSecret(secretKey(row.id)),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

export function listProviders(): Provider[] {
  const rows = getDb()
    .prepare('SELECT * FROM providers ORDER BY priority ASC, name ASC')
    .all() as ProviderRow[]
  return rows.map(toProvider)
}

export function getProvider(id: string): Provider | null {
  const row = getDb().prepare('SELECT * FROM providers WHERE id = ?').get(id) as
    | ProviderRow
    | undefined
  return row ? toProvider(row) : null
}

export function upsertProvider(input: ProviderInput): Provider {
  const db = getDb()
  const now = Date.now()
  const id = input.id ?? randomUUID()

  const existing = input.id ? getProvider(input.id) : null

  if (existing) {
    db.prepare(
      `UPDATE providers
       SET name = @name, kind = @kind, base_url = @baseUrl, models = @models,
           enabled = @enabled, priority = @priority, headers = @headers, updated_at = @updatedAt
       WHERE id = @id`
    ).run({
      id,
      name: input.name,
      kind: input.kind,
      baseUrl: input.baseUrl,
      models: JSON.stringify(input.models),
      enabled: input.enabled ? 1 : 0,
      priority: input.priority,
      headers: JSON.stringify(input.headers ?? {}),
      updatedAt: now
    })
  } else {
    db.prepare(
      `INSERT INTO providers
         (id, name, kind, base_url, models, enabled, priority, headers, created_at, updated_at)
       VALUES (@id, @name, @kind, @baseUrl, @models, @enabled, @priority, @headers, @createdAt, @updatedAt)`
    ).run({
      id,
      name: input.name,
      kind: input.kind,
      baseUrl: input.baseUrl,
      models: JSON.stringify(input.models),
      enabled: input.enabled ? 1 : 0,
      priority: input.priority,
      headers: JSON.stringify(input.headers ?? {}),
      createdAt: now,
      updatedAt: now
    })
  }

  // apiKey 为空字符串表示「显式清除」，为 undefined 表示「保持不变」
  if (input.apiKey === '') {
    deleteSecret(secretKey(id))
  } else if (typeof input.apiKey === 'string' && input.apiKey.trim()) {
    setSecret(secretKey(id), input.apiKey.trim())
  }

  return getProvider(id)!
}

export function deleteProvider(id: string): void {
  getDb().prepare('DELETE FROM providers WHERE id = ?').run(id)
  deleteSecret(secretKey(id))
  getDb().prepare('UPDATE conversations SET provider_id = NULL WHERE provider_id = ?').run(id)
}

export function getApiKey(id: string): string | null {
  return getSecret(secretKey(id))
}

export function adapterForKind(kind: ProviderKind): ProviderAdapter {
  if (kind === 'anthropic') return anthropicAdapter
  if (kind === 'openai-responses') return openAiResponsesAdapter
  return openAiCompatibleAdapter
}

export function adapterFor(provider: Provider): ProviderAdapter {
  return adapterForKind(provider.kind)
}

/**
 * 路由顺序：优先指定的 provider，其次其余已启用且配好密钥的 provider，
 * 按 priority 升序排列。调用方按顺序做失败降级。
 */
export function routingOrder(preferredId?: string | null): Provider[] {
  const usable = listProviders().filter((p) => p.enabled && p.hasApiKey)
  const preferred = preferredId ? usable.find((p) => p.id === preferredId) : undefined
  const rest = usable.filter((p) => p.id !== preferred?.id)
  return preferred ? [preferred, ...rest] : rest
}

/** 首次启动写入常用供应商模板（默认关闭，填好密钥后自行启用）。 */
export function ensureDefaultProviders(): void {
  if (!getSetting(SEED_FLAG, false)) {
    const presets: Omit<ProviderInput, 'id'>[] = [
    {
      name: 'DeepSeek',
      kind: 'openai-compatible',
      baseUrl: 'https://api.deepseek.com/v1',
      models: ['deepseek-chat', 'deepseek-reasoner'],
      enabled: false,
      priority: 10
    },
    {
      name: '通义千问',
      kind: 'openai-compatible',
      baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
      models: ['qwen-max', 'qwen-plus', 'qwen-turbo'],
      enabled: false,
      priority: 20
    },
    {
      name: '智谱 GLM',
      kind: 'openai-compatible',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      models: ['glm-4-plus', 'glm-4-air'],
      enabled: false,
      priority: 30
    },
    {
      name: 'Claude',
      kind: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      models: ['claude-sonnet-4-5', 'claude-haiku-4-5'],
      enabled: false,
      priority: 40
    },
    {
      name: 'Magpie 网关',
      kind: 'openai-compatible',
      baseUrl: MAGPIE_BASE_URL,
      models: [...MAGPIE_MODELS],
      enabled: false,
      priority: 5
    },
    {
      name: 'Ollama 本地',
      kind: 'openai-compatible',
      baseUrl: 'http://localhost:11434/v1',
      models: ['qwen2.5:7b'],
      enabled: false,
      priority: 90
    },
    {
      name: '本地推理引擎（OpenAI 兼容）',
      kind: 'openai-compatible',
      baseUrl: LOCAL_ENGINE_BASE_URL,
      models: [...LOCAL_ENGINE_MODELS],
      enabled: false,
      priority: 95
    }
  ]

  for (const preset of presets) {
    upsertProvider(preset)
  }
  setSetting(SEED_FLAG, true)
  }

  // 老库迁移：已种子化的 Magpie 网关只有 trae-cn 单模型，
  // 网关 /v1/models 明明有 50 个（含 3 个 maas-qianwenaiapi/*），
  // 用户在尚搏下拉里看不到就是因为这里没收录。自动补齐，不覆盖用户已有勾选。
  healMagpieModels()
  healLocalEngineProvider()
}

/**
 * 老库自愈：已经种子化过的库不会再走 presets，这里补一个默认禁用的本地端点。
 * 幂等；用户删掉后不会强行塞回（只有完全不存在于 providers 表时才补）。
 */
export function healLocalEngineProvider(): void {
  try {
    const existing = getDb()
      .prepare('SELECT id FROM providers WHERE base_url = ?')
      .get(LOCAL_ENGINE_BASE_URL)
    if (existing) return
    upsertProvider({
      name: '本地推理引擎（OpenAI 兼容）',
      kind: 'openai-compatible',
      baseUrl: LOCAL_ENGINE_BASE_URL,
      models: [...LOCAL_ENGINE_MODELS],
      enabled: false,
      priority: 95
    })
  } catch {
    // 自愈失败不挡启动，用户可手动新增供应商
  }
}

/** 补齐 Magpie 网关缺失模型（幂等，可重复跑；保留用户自加模型，只做并集）。 */
export function healMagpieModels(): void {
  const wanted = MAGPIE_MODELS
  try {
    const rows = getDb()
      .prepare(`SELECT * FROM providers WHERE base_url = ?`)
      .all(MAGPIE_BASE_URL) as ProviderRow[]
    for (const row of rows) {
      const models = JSON.parse(row.models) as string[]
      const missing = wanted.filter((m) => !models.includes(m))
      if (missing.length === 0) continue
      const merged = [...models, ...missing]
      getDb()
        .prepare(`UPDATE providers SET models = @models, updated_at = @updatedAt WHERE id = @id`)
        .run({ id: row.id, models: JSON.stringify(merged), updatedAt: Date.now() })
    }
  } catch {
    // 迁移失败不挡启动：用户仍可用「重新获取模型」手动拉取
  }
}