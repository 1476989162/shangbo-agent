import type { ContentBlock, ProviderKind, Usage } from '../../shared/types'

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
}

export type StreamChunk =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'usage'; usage: Usage }
  | { type: 'stop'; reason: string }

export interface ProviderContext {
  baseUrl: string
  apiKey: string
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