import { randomUUID } from 'node:crypto'
import { getDb } from '../db'
import { deleteSecret, getSecret, hasSecret, setSecret } from '../secrets'
import { getSetting, setSetting } from '../settings'
import { anthropicAdapter } from './anthropic'
import { openAiCompatibleAdapter } from './openai'
import type { Provider, ProviderInput, ProviderKind } from '../../shared/types'
import type { ProviderAdapter } from './types'

const secretKey = (id: string) => `provider:${id}`
const SEED_FLAG = 'providers.seeded'

interface ProviderRow {
  id: string
  name: string
  kind: string
  base_url: string
  models: string
  enabled: number
  priority: number
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
           enabled = @enabled, priority = @priority, updated_at = @updatedAt
       WHERE id = @id`
    ).run({
      id,
      name: input.name,
      kind: input.kind,
      baseUrl: input.baseUrl,
      models: JSON.stringify(input.models),
      enabled: input.enabled ? 1 : 0,
      priority: input.priority,
      updatedAt: now
    })
  } else {
    db.prepare(
      `INSERT INTO providers
         (id, name, kind, base_url, models, enabled, priority, created_at, updated_at)
       VALUES (@id, @name, @kind, @baseUrl, @models, @enabled, @priority, @createdAt, @updatedAt)`
    ).run({
      id,
      name: input.name,
      kind: input.kind,
      baseUrl: input.baseUrl,
      models: JSON.stringify(input.models),
      enabled: input.enabled ? 1 : 0,
      priority: input.priority,
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
  return kind === 'anthropic' ? anthropicAdapter : openAiCompatibleAdapter
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
  if (getSetting(SEED_FLAG, false)) return

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
      name: 'Ollama 本地',
      kind: 'openai-compatible',
      baseUrl: 'http://localhost:11434/v1',
      models: ['qwen2.5:7b'],
      enabled: false,
      priority: 90
    }
  ]

  for (const preset of presets) {
    upsertProvider(preset)
  }
  setSetting(SEED_FLAG, true)
}