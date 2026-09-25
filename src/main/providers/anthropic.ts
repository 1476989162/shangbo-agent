import { ProviderHttpError, readSse } from './sse'
import {
  textOf,
  type CompletionRequest,
  type LLMMessage,
  type ProviderAdapter,
  type ProviderContext,
  type StreamChunk
} from './types'
import type { Usage } from '../../shared/types'

/**
 * Anthropic /v1/messages 协议适配。
 * 与 OpenAI 的三处主要差异：
 *   1. system 是顶层参数，不在 messages 里；
 *   2. 工具结果必须以 user 角色的 content block 回传；
 *   3. messages 的角色必须交替，因此需要合并相邻同角色消息。
 * 约定：provider.baseUrl 为 https://api.anthropic.com（不含 /v1）。
 */

const ANTHROPIC_VERSION = '2023-06-01'

interface ToolUseAccumulator {
  id: string
  name: string
  json: string
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`
}

function parseDataUrl(dataUrl: string): { mimeType: string; data: string } {
  const match = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl)
  if (!match) return { mimeType: 'image/png', data: '' }
  return { mimeType: match[1], data: match[2] }
}

interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: Record<string, unknown>[]
}

function toAnthropicMessages(messages: LLMMessage[]): AnthropicMessage[] {
  const out: AnthropicMessage[] = []

  const push = (role: 'user' | 'assistant', blocks: Record<string, unknown>[]): void => {
    if (blocks.length === 0) return
    const last = out[out.length - 1]
    if (last && last.role === role) {
      last.content.push(...blocks)
    } else {
      out.push({ role, content: blocks })
    }
  }

  for (const message of messages) {
    if (message.role === 'system') continue

    if (message.role === 'tool') {
      push(
        'user',
        message.blocks
          .filter((b) => b.type === 'tool_result')
          .map((b) => ({
            type: 'tool_result',
            tool_use_id: b.type === 'tool_result' ? b.toolUseId : '',
            content: b.type === 'tool_result' ? b.content : '',
            is_error: b.type === 'tool_result' ? b.isError : false
          }))
      )
      continue
    }

    if (message.role === 'assistant') {
      const blocks: Record<string, unknown>[] = []
      const text = textOf(message.blocks)
      if (text) blocks.push({ type: 'text', text })
      for (const block of message.blocks) {
        if (block.type === 'tool_use') {
          blocks.push({ type: 'tool_use', id: block.id, name: block.name, input: block.input })
        }
      }
      push('assistant', blocks)
      continue
    }

    const blocks: Record<string, unknown>[] = []
    const text = textOf(message.blocks)
    if (text) blocks.push({ type: 'text', text })
    for (const block of message.blocks) {
      if (block.type === 'image') {
        const { mimeType, data } = parseDataUrl(block.dataUrl)
        if (data) {
          blocks.push({ type: 'image', source: { type: 'base64', media_type: mimeType, data } })
        }
      }
    }
    push('user', blocks)
  }

  return out
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    return '<无法读取响应体>'
  }
}

export const anthropicAdapter: ProviderAdapter = {
  kind: 'anthropic',

  async *stream(request: CompletionRequest, context: ProviderContext): AsyncGenerator<StreamChunk> {
    const body: Record<string, unknown> = {
      model: request.model,
      max_tokens: request.maxTokens ?? 8192,
      stream: true,
      messages: toAnthropicMessages(request.messages)
    }
    if (request.system) body.system = request.system
    if (request.temperature !== undefined) body.temperature = request.temperature
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        input_schema: tool.parameters
      }))
    }

    const response = await fetch(joinUrl(context.baseUrl, '/v1/messages'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': context.apiKey,
        'anthropic-version': ANTHROPIC_VERSION
      },
      body: JSON.stringify(body),
      signal: context.signal
    })

    if (!response.ok || !response.body) {
      throw new ProviderHttpError(response.status, await readErrorBody(response), 'Anthropic')
    }

    const toolUses = new Map<number, ToolUseAccumulator>()
    let promptTokens = 0
    let completionTokens = 0
    let cacheReadTokens: number | undefined
    let stopReason = 'stop'
    let sawUsage = false

    for await (const event of readSse(response.body)) {
      if (!event.data || event.data === '[DONE]') continue

      let payload: Record<string, any>
      try {
        payload = JSON.parse(event.data)
      } catch {
        continue
      }

      if (payload.type === 'error') {
        throw new Error(payload.error?.message ?? JSON.stringify(payload.error))
      }

      if (payload.type === 'message_start') {
        promptTokens = payload.message?.usage?.input_tokens ?? 0
        cacheReadTokens = payload.message?.usage?.cache_read_input_tokens
        completionTokens = payload.message?.usage?.output_tokens ?? 0
        sawUsage = true
        continue
      }

      if (payload.type === 'content_block_start') {
        if (payload.content_block?.type === 'tool_use') {
          toolUses.set(payload.index, {
            id: payload.content_block.id,
            name: payload.content_block.name,
            json: ''
          })
        }
        continue
      }

      if (payload.type === 'content_block_delta') {
        const delta = payload.delta
        if (delta?.type === 'text_delta' && delta.text) {
          yield { type: 'text', text: delta.text }
        } else if (delta?.type === 'thinking_delta' && delta.thinking) {
          yield { type: 'reasoning', text: delta.thinking }
        } else if (delta?.type === 'input_json_delta') {
          const acc = toolUses.get(payload.index)
          if (acc) acc.json += delta.partial_json ?? ''
        }
        continue
      }

      if (payload.type === 'message_delta') {
        if (payload.usage?.output_tokens !== undefined) {
          completionTokens = payload.usage.output_tokens
          sawUsage = true
        }
        if (payload.delta?.stop_reason) stopReason = payload.delta.stop_reason
        continue
      }
    }

    for (const acc of toolUses.values()) {
      let input: unknown = {}
      try {
        input = acc.json.trim() ? JSON.parse(acc.json) : {}
      } catch {
        input = { __raw: acc.json }
      }
      yield { type: 'tool_use', id: acc.id, name: acc.name, input }
    }

    if (sawUsage) {
      const usage: Usage = { promptTokens, completionTokens }
      if (cacheReadTokens !== undefined) usage.cacheReadTokens = cacheReadTokens
      yield { type: 'usage', usage }
    }

    yield { type: 'stop', reason: stopReason }
  },

  async listModels(context: ProviderContext): Promise<string[]> {
    const response = await fetch(joinUrl(context.baseUrl, '/v1/models'), {
      headers: {
        'x-api-key': context.apiKey,
        'anthropic-version': ANTHROPIC_VERSION
      },
      signal: context.signal
    })
    if (!response.ok) {
      throw new ProviderHttpError(response.status, await readErrorBody(response), 'Anthropic')
    }
    const payload = (await response.json()) as { data?: { id: string }[] }
    return (payload.data ?? []).map((item) => item.id).sort()
  }
}