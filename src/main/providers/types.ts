import type { ContentBlock, ProviderKind, Usage } from '../../shared/types'

/**
 * 网关侧按 User-Agent 认客户端（Magpie 路由页显示 Codex/node 即按此区分）。
 * 收成常量：各 adapter 统一引用，用户在供应商“自定义请求头”里仍可覆盖。
 */
export const SHANGBO_AGENT_NAME = 'shangbo-agent'

/** 默认 UA：shangbo-agent/<版本号>拿不到版本时退化为纯名。 */
export function shangboUserAgent(): string {
  try {
    const req = new Function(
      'return typeof require !== "undefined" ? require : undefined'
    )() as ((id: string) => { app?: { getVersion?: () => string } }) | undefined
    const v = req?.('electron')?.app?.getVersion?.()
    if (v) return `${SHANGBO_AGENT_NAME}/${v}`
  } catch {
    // 无 Electron 环境（单测）时用纯名
  }
  return SHANGBO_AGENT_NAME
}

/** 合并默认 UA 与自定义头：用户自定义的 user-agent 优先（大小写不敏感）。 */
export function withAgentHeaders(custom?: Record<string, string>): Record<string, string> {
  const merged: Record<string, string> = { 'user-agent': shangboUserAgent() }
  if (!custom) return merged
  for (const [k, v] of Object.entries(custom)) {
    if (k.toLowerCase() === 'user-agent') {
      delete merged['user-agent']
      merged[k] = v
    } else {
      merged[k] = v
    }
  }
  return merged
}

/** 与具体厂商无关的对话消息。 */
export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  blocks: ContentBlock[]
}

export interface ToolSchema {
  name: string
  description: string
  /** JSON Schema 对象 */
  parameters: Record<string, unknown>
}

export interface CompletionRequest {
  model: string
  system?: string
  messages: LLMMessage[]
  tools?: ToolSchema[]
  maxTokens?: number
  temperature?: number
  /**
   * 思考强度原始值（minimal/low/medium/high/max）。
   * 各 adapter 按自家线制转发，不支持的家族必须忽略——严格网关会对未知参数 400。
   */
  reasoningEffort?: string
}

export type StreamChunk =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'usage'; usage: Usage }
  | { type: 'stop'; reason: string }
  /**
   * 网关通知：实际服务本次请求的供应商/模型与首选不同（跨供应商降级时下发，且仅一次）。
   * 各供应商的模型清单互不通用，降级时模型会被重映射，必须告知调用方与用户。
   */
  | {
      type: 'provider_switch'
      fromProviderName: string
      providerId: string
      providerName: string
      model: string
      reason: string
    }
  /**
   * 可重试错误后的等待通知（429 限流、5xx、超时等）。
   * 调用方据此在 UI 上显示倒计时；waitMs 结束后网关自动重试。
   */
  | {
      type: 'retry_status'
      providerName: string
      /** 本次是第几次失败（即将发起第 attempt+1 次请求）。 */
      attempt: number
      maxAttempts: number
      waitMs: number
      /** 对用户可读的一句原因，如「触发每分钟 token 限流」。 */
      reason: string
    }

export interface ProviderContext {
  baseUrl: string
  apiKey: string
  /** 供应商配置的自定义请求头，优先级高于适配器默认头。 */
  headers?: Record<string, string>
  signal: AbortSignal
}

export interface ProviderAdapter {
  readonly kind: ProviderKind
  stream(request: CompletionRequest, context: ProviderContext): AsyncGenerator<StreamChunk>
  listModels(context: ProviderContext): Promise<string[]>
}

/** 提取消息中的纯文本，供不支持多模态块的位置降级使用。 */
export function textOf(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
    .map((b) => b.text)
    .join('')
}