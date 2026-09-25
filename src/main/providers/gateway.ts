import log from 'electron-log/main'
import { ProviderHttpError } from './sse'
import { adapterFor, getApiKey, getProvider, listProviders, routingOrder } from './store'
import type { CompletionRequest, StreamChunk } from './types'
import type { Provider } from '../../shared/types'

/**
 * 统一网关：
 *
 * 路由规则（重要）：
 * - 调用方显式指定了供应商时（UI 下拉框的选择总是显式的），只使用该供应商，
 *   绝不静默切换到别家——用户选的是谁，就该由谁服务或明确报错。
 * - 未指定时（理论兜底路径）按优先级遍历全部可用供应商。
 *
 * 重试规则：
 * - 429 限流按「每分钟窗口」处理：优先用响应头 Retry-After，否则每 10 秒一次，
 *   最多在约 60 秒内持续重试。TPM/RPM 窗口约 60 秒，1~4 秒的快速重试必然全部
 *   落在同一个窗口里，等够一个完整窗口才有意义。
 * - 5xx / 408 / 首字节超时 / 网络错误：3 次指数退避。
 * - 401 / 400 / 404 等配置类错误：立即抛出，不重试不切换。
 * - 任何重试都通过 retry_status 块实时告知调用方，用户可随时点「停止」。
 */

/** 连接建立后等待第一个流式分片的时限；放宽至 180 秒（3 分钟），为深度推理思考模型（如 R1、muse-spark 极限思考）及高负载排队提供充足窗口。 */
export let FIRST_BYTE_TIMEOUT_MS = 180_000

export function setFirstByteTimeoutForTesting(ms: number): void {
  FIRST_BYTE_TIMEOUT_MS = ms
}
/** 普通可重试错误（5xx/超时/网络）的尝试次数。 */
const MAX_ATTEMPTS_TRANSIENT = 3
/** 429 限流的尝试次数：配合 10 秒间隔覆盖一个完整的每分钟限流窗口。 */
const MAX_ATTEMPTS_RATE_LIMIT = 6
/** 没有 Retry-After 头时，429 重试的固定间隔。 */
const RATE_LIMIT_INTERVAL_MS = 10_000
/** Retry-After 给出的等待时间封顶，避免异常长的等待。 */
const RETRY_AFTER_CAP_MS = 60_000

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const onAbort = (): void => {
      clearTimeout(timer)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/** 5xx/超时等瞬态错误的指数退避 + 抖动：1s → 2s → 4s（封顶 8s）。 */
function backoffDelayMs(attempt: number): number {
  const base = Math.min(1000 * 2 ** (attempt - 1), 8000)
  return base + Math.floor(Math.random() * 400)
}

function isRateLimit(error: unknown): boolean {
  return error instanceof ProviderHttpError && error.isRateLimit
}

/** 决定本次失败还要不要再试、等多久。 */
function retryPlan(
  error: unknown,
  attempt: number,
  firstByteTimedOut: boolean
): { retry: boolean; waitMs: number; maxAttempts: number; reason: string } | null {
  if (isRateLimit(error)) {
    if (attempt >= MAX_ATTEMPTS_RATE_LIMIT) return null
    const headerMs = (error as ProviderHttpError).retryAfterMs
    const waitMs = Math.min(
      headerMs ?? RATE_LIMIT_INTERVAL_MS,
      RETRY_AFTER_CAP_MS
    )
    return { retry: true, waitMs, maxAttempts: MAX_ATTEMPTS_RATE_LIMIT, reason: '触发每分钟 token / 请求限流（TPM/RPM）' }
  }

  if (error instanceof ProviderHttpError && !error.retryable) return null
  // 网络错误与首字节超时也归为瞬态；AbortError（用户主动取消）在调用处已提前抛出，不会到这里
  if (attempt >= MAX_ATTEMPTS_TRANSIENT) return null
  return {
    retry: true,
    waitMs: backoffDelayMs(attempt),
    maxAttempts: MAX_ATTEMPTS_TRANSIENT,
    reason: firstByteTimedOut ? '首字节超时' : '服务暂时不可用'
  }
}

/**
 * 解析本次实际要尝试的供应商序列：
 * 显式选择 → 只用它；未指定 → 按优先级全部可用供应商。
 */
function resolveCandidates(preferredProviderId?: string | null): Provider[] {
  if (preferredProviderId) {
    const preferred = getProvider(preferredProviderId)
    if (preferred && preferred.enabled && listProviders().some((p) => p.id === preferred.id && p.hasApiKey)) {
      return [preferred]
    }
    // 显式选择但不可用：返回空，由调用方给出明确错误，不允许悄悄换别家
    return []
  }
  return routingOrder(null)
}

export async function* streamWithFallback(
  request: CompletionRequest,
  signal: AbortSignal,
  preferredProviderId?: string | null
): AsyncGenerator<StreamChunk> {
  const candidates = resolveCandidates(preferredProviderId)
  const explicitlySelected = Boolean(preferredProviderId)

  if (candidates.length === 0) {
    if (explicitlySelected) {
      const named = getProvider(preferredProviderId!)
      throw new Error(
        named
          ? `当前选择的供应商「${named.name}」未启用或尚未配置 API Key，请到「设置 → 模型供应商」检查。`
          : '当前选择的供应商不存在或未配置，请到「设置 → 模型供应商」检查。'
      )
    }
    throw new Error('没有可用的模型供应商：请到「设置 → 模型供应商」填入 API Key 并启用。')
  }

  const failures: string[] = []
  /** 第一个候选即用户首选；只有真正换到「别的」供应商时才下发切换通知。 */
  const firstName = candidates[0]?.name ?? ''
  /** 切换发生时记录原因（前一个供应商的最后一条失败描述），用于通知与错误链。 */
  let lastFailureReason = ''

  // 最终抛错时带上此前累积的失败链——否则用户只看到最后一条错误，看不到真正起因。
  const withChain = (tail: string): string =>
    failures.length > 1 ? `${tail}\n此前的尝试：\n${failures.slice(0, -1).join('\n')}` : tail

  for (const provider of candidates) {
    const apiKey = getApiKey(provider.id)
    if (!apiKey) {
      failures.push(`${provider.name}：未配置 API Key`)
      lastFailureReason = '未配置 API Key'
      continue
    }

    // 跨供应商的模型清单互不通用：首选模型在该供应商存在则沿用，否则取其首个模型。
    // 否则把 A 家的模型名发给 B 家必然得到 404 model is not found。
    const effectiveModel = provider.models.includes(request.model)
      ? request.model
      : provider.models[0]
    if (!effectiveModel) {
      failures.push(`${provider.name}：没有配置可用模型，已跳过`)
      lastFailureReason = '没有配置可用模型'
      continue
    }
    const effectiveRequest =
      effectiveModel === request.model ? request : { ...request, model: effectiveModel }

    let attempt = 0
    while (true) {
      attempt++
      // 首字节超时需要能单独拉断本次尝试，同时不干扰外层的用户取消信号，
      // 因此外层 signal 与本次尝试的超时 AbortController 做一次桥接
      const attemptController = new AbortController()
      const onOuterAbort = (): void => attemptController.abort()
      signal.addEventListener('abort', onOuterAbort, { once: true })

      let firstByteTimer: ReturnType<typeof setTimeout> | null = null
      let firstByteTimedOut = false
      let emitted = false

      try {
        firstByteTimer = setTimeout(() => {
          firstByteTimedOut = true
          attemptController.abort()
        }, FIRST_BYTE_TIMEOUT_MS)

        // 本地 Ollama 不校验密钥，用占位串即可
        for await (const chunk of adapterFor(provider).stream(effectiveRequest, {
          baseUrl: provider.baseUrl,
          apiKey,
          headers: provider.headers,
          signal: attemptController.signal
        })) {
          // 在第一个内容分片之前下发一次切换通知（末尾的 stop 元数据块不算）
          if (!emitted && provider.name !== firstName && chunk.type !== 'stop') {
            yield {
              type: 'provider_switch',
              fromProviderName: firstName,
              providerId: provider.id,
              providerName: provider.name,
              model: effectiveModel,
              reason: lastFailureReason || '首选供应商不可用'
            }
          }

          // 收到第一个分片即解除首字节限制；后续分片间的慢速不在此拦（属停带问题，另议）
          if (firstByteTimer) {
            clearTimeout(firstByteTimer)
            firstByteTimer = null
          }
          emitted = true
          yield chunk
        }
        return
      } catch (error) {
        if (signal.aborted) throw error

        // 超时触发的是底层的 AbortError，报错文案换成对用户有意义的描述
        const message = firstByteTimedOut
          ? `${FIRST_BYTE_TIMEOUT_MS / 1000} 秒内未返回任何数据（首字节超时）`
          : error instanceof Error
            ? error.message
            : String(error)
        lastFailureReason = message
        failures.push(`${provider.name}（第 ${attempt} 次尝试）：${message}`)

        if (emitted) {
          log.error(`[gateway] ${provider.name} 在流式输出中途失败，不再重试`)
          throw new Error(withChain(`${provider.name}：${message}`))
        }

        const plan = retryPlan(error, attempt, firstByteTimedOut)
        if (!plan) {
          // 配置类错误（401/400/404 等，且不是限流重试耗尽）：任何模式下都立即中止，
          // 换到下一家只会掩盖"供应商没配好/模型不存在"这个真正的问题。
          const isConfigError =
            error instanceof ProviderHttpError && !error.retryable && !error.isRateLimit
          if (isConfigError || explicitlySelected) {
            const hint = isRateLimitError(error)
              ? '\n提示：该供应商返回了每分钟限流（TPM/RPM），应用已在约 60 秒内自动重试仍未恢复，请稍候再试；也可在 OpenCode 控制台开启 Use balance（使用余额）避免请求被拦截。'
              : ''
            throw new Error(withChain(`${provider.name}：${message}`) + hint)
          }
          break // 瞬态错误重试耗尽（多候选兜底场景）：进入下一家供应商
        }

        log.warn(
          `[gateway] ${provider.name} 第 ${attempt} 次尝试失败（${plan.reason}），${plan.waitMs}ms 后重试`
        )
        yield {
          type: 'retry_status',
          providerName: provider.name,
          attempt,
          maxAttempts: plan.maxAttempts,
          waitMs: plan.waitMs,
          reason: plan.reason
        }
        // 退避期间用户点了「停止」会在这里抛 AbortError，由外层按取消处理
        await abortableSleep(plan.waitMs, signal)
      } finally {
        if (firstByteTimer) clearTimeout(firstByteTimer)
        signal.removeEventListener('abort', onOuterAbort)
      }
    }

    // 显式选择时上面的失败已直接抛出；走到这里说明是多候选场景，继续下一家
    log.warn(`[gateway] ${provider.name} 尝试次数耗尽，降级到下一个供应商`)
  }

  throw new Error(`所有模型供应商均不可用：\n${failures.join('\n')}`)
}

function isRateLimitError(error: unknown): boolean {
  return error instanceof ProviderHttpError && error.isRateLimit
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
      headers: provider.headers,
      signal: controller.signal
    })
    return { latencyMs: Date.now() - startedAt, models: models.length }
  } finally {
    clearTimeout(timer)
  }
}
