import { randomUUID } from 'node:crypto'
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
 * OpenAI /chat/completions 协议适配。
 * 同时覆盖 OpenAI、DeepSeek、通义千问（兼容模式）、智谱 GLM、Moonshot、Ollama、vLLM 等。
 * 约定：provider.baseUrl 需包含版本前缀，例如 https://api.deepseek.com/v1
 */

interface ToolCallAccumulator {
  id: string
  name: string
  args: string
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`
}

function parseArgs(raw: string): unknown {
  const trimmed = raw.trim()
  if (!trimmed) return {}
  try {
    return JSON.parse(trimmed)
  } catch {
    return { __raw: trimmed }
  }
}

function toOpenAiMessages(system: string | undefined, messages: LLMMessage[]): unknown[] {
  const out: Record<string, unknown>[] = []
  if (system) out.push({ role: 'system', content: system })

  for (const message of messages) {
    if (message.role === 'tool') {
      for (const block of message.blocks) {
        if (block.type === 'tool_result') {
          out.push({ role: 'tool', tool_call_id: block.toolUseId, content: block.content })
        }
      }
      continue
    }

    if (message.role === 'assistant') {
      const text = textOf(message.blocks)
      const toolCalls = message.blocks
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({
          id: b.type === 'tool_use' ? b.id : '',
          type: 'function',
          function: {
            name: b.type === 'tool_use' ? b.name : '',
            arguments: JSON.stringify(b.type === 'tool_use' ? b.input : {})
          }
        }))
      const payload: Record<string, unknown> = { role: 'assistant', content: text || null }
      if (toolCalls.length > 0) payload.tool_calls = toolCalls
      out.push(payload)
      continue
    }

    const images = message.blocks.filter((b) => b.type === 'image')
    if (images.length > 0) {
      out.push({
        role: message.role,
        content: [
          { type: 'text', text: textOf(message.blocks) },
          ...images.map((b) => ({
            type: 'image_url',
            image_url: { url: b.type === 'image' ? b.dataUrl : '' }
          }))
        ]
      })
    } else {
      out.push({ role: message.role, content: textOf(message.blocks) })
    }
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

export const openAiCompatibleAdapter: ProviderAdapter = {
  kind: 'openai-compatible',

  async *stream(request: CompletionRequest, context: ProviderContext): AsyncGenerator<StreamChunk> {
    const body: Record<string, unknown> = {
      model: request.model,
      messages: toOpenAiMessages(request.system, request.messages),
      stream: true,
      stream_options: { include_usage: true }
    }
    if (request.temperature !== undefined) body.temperature = request.temperature
    if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({
        type: 'function',
        function: {
          name: tool.name,
          description: tool.description,
          parameters: tool.parameters
        }
      }))
    }

    const response = await fetch(joinUrl(context.baseUrl, '/chat/completions'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${context.apiKey}`
      },
      body: JSON.stringify(body),
      signal: context.signal
    })

    if (!response.ok || !response.body) {
      throw new ProviderHttpError(response.status, await readErrorBody(response), 'OpenAI 兼容接口')
    }

    const toolCalls = new Map<number, ToolCallAccumulator>()
    let usage: Usage | null = null
    let stopReason = 'stop'

    for await (const event of readSse(response.body)) {
      if (event.data === '[DONE]') break

      let payload: Record<string, any>
      try {
        payload = JSON.parse(event.data)
      } catch {
        continue
      }

      if (payload.error) {
        throw new Error(payload.error.message ?? JSON.stringify(payload.error))
      }

      const choice = payload.choices?.[0]
      const delta = choice?.delta

      if (typeof delta?.content === 'string' && delta.content) {
        yield { type: 'text', text: delta.content }
      }

      // DeepSeek 用 reasoning_content，部分网关用 reasoning
      const reasoning = delta?.reasoning_content ?? delta?.reasoning
      if (typeof reasoning === 'string' && reasoning) {
        yield { type: 'reasoning', text: reasoning }
      }

      if (Array.isArray(delta?.tool_calls)) {
        for (const call of delta.tool_calls) {
          const index: number = call.index ?? 0
          const acc = toolCalls.get(index) ?? { id: '', name: '', args: '' }
          if (call.id) acc.id = call.id
          if (call.function?.name) acc.name += call.function.name
          if (call.function?.arguments) acc.args += call.function.arguments
          toolCalls.set(index, acc)
        }
      }

      if (choice?.finish_reason) stopReason = choice.finish_reason

      if (payload.usage) {
        usage = {
          promptTokens: payload.usage.prompt_tokens ?? 0,
          completionTokens: payload.usage.completion_tokens ?? 0,
          cacheReadTokens: payload.usage.prompt_cache_hit_tokens,
          cacheWriteTokens: payload.usage.prompt_cache_miss_tokens
        }
      }
    }

    for (const acc of toolCalls.values()) {
      if (!acc.name) continue
      yield {
        type: 'tool_use',
        // 极少数兼容实现不回传 tool_calls[].id，而回传历史时 tool_call_id 必须能被引用，
        // 因此仍需兜底生成一个。用 UUID 而不是随机串，保证同一个响应重放时 id 一致、便于排查。
        id: acc.id || `call_${randomUUID()}`,
        name: acc.name,
        input: parseArgs(acc.args)
      }
    }

    if (usage) yield { type: 'usage', usage }
    yield { type: 'stop', reason: stopReason }
  },

  async listModels(context: ProviderContext): Promise<string[]> {
    const response = await fetch(joinUrl(context.baseUrl, '/models'), {
      headers: { authorization: `Bearer ${context.apiKey}` },
      signal: context.signal
    })
    if (!response.ok) {
      throw new ProviderHttpError(response.status, await readErrorBody(response), 'OpenAI 兼容接口')
    }
    const payload = (await response.json()) as { data?: { id: string }[] }
    return (payload.data ?? []).map((item) => item.id).sort()
  }
}