import log from 'electron-log/main'
import { adapterFor, getApiKey, routingOrder } from './store'
import type { CompletionRequest, StreamChunk } from './types'
import type { Provider } from '../../shared/types'

/**
 * 统一网关：按优先级路由，并在"尚未产出任何内容"时静默降级到下一个供应商。
 * 一旦已经向界面吐出过内容就不再做降级，否则用户会看到两段互相矛盾的回复。
 */
export async function* streamWithFallback(
  request: CompletionRequest,
  signal: AbortSignal,
  preferredProviderId?: string | null
): AsyncGenerator<StreamChunk> {
  const candidates = routingOrder(preferredProviderId)

  if (candidates.length === 0) {
    throw new Error('没有可用的模型供应商：请到「设置 → 模型供应商」填入 API Key 并启用。')
  }

  const failures: string[] = []

  for (const provider of candidates) {
    const apiKey = getApiKey(provider.id)
    if (!apiKey) {
      failures.push(`${provider.name}：未配置 API Key`)
      continue
    }

    let emitted = false
    try {
      // 本地 Ollama 不校验密钥，用占位串即可
      for await (const chunk of adapterFor(provider).stream(request, {
        baseUrl: provider.baseUrl,
        apiKey,
        signal
      })) {
        emitted = true
        yield chunk
      }
      return
    } catch (error) {
      if (signal.aborted) throw error

      const message = error instanceof Error ? error.message : String(error)
      failures.push(`${provider.name}：${message}`)

      if (emitted) {
        log.error(`[gateway] ${provider.name} 在流式输出中途失败，不再降级`)
        throw error
      }
      log.warn(`[gateway] ${provider.name} 失败，尝试降级到下一个供应商`)
    }
  }

  throw new Error(`所有模型供应商均不可用：\n${failures.join('\n')}`)
}

/** 供「测试连接」使用：只验证凭据与网络，不产生对话内容。 */
export async function probeProvider(provider: Provider): Promise<{ latencyMs: number; models: number }> {
  const apiKey = getApiKey(provider.id)
  if (!apiKey) throw new Error('尚未配置 API Key')

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), 15_000)
  const startedAt = Date.now()

  try {
    const models = await adapterFor(provider).listModels({
      baseUrl: provider.baseUrl,
      apiKey,
      signal: controller.signal
    })
    return { latencyMs: Date.now() - startedAt, models: models.length }
  } finally {
    clearTimeout(timer)
  }
}