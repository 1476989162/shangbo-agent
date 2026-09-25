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
 * OpenAI Responses API (/v1/responses) 协议适配器。
 * 适配 OpenCode Go 的 muse-spark、grok 等 Responses 架构模型以及 OpenAI Responses 协议规范。
 */

interface ToolCallState {
  id: string
  name: string
  args: string
}

function joinUrl(baseUrl: string, path: string): string {
  return `${baseUrl.replace(/\/+$/, '')}${path}`
}

export function responsesUrl(baseUrl: string): string {
  const clean = baseUrl.replace(/\/+$/, '')
  return clean.endsWith('/responses') ? clean : `${clean}/responses`
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

/**
 * 判断某个模型是否应该走 Responses API：
 * 1. muse-spark 系列（OpenCode Go 上游仅挂载在 /responses）
 * 2. grok-4.6/4.7, luna, omen 等 Responses 专属模型
 * 3. baseUrl 本身以 /responses 结尾
 */
export function isResponsesModel(model: string, baseUrl?: string): boolean {
  const m = model.toLowerCase()
  if (m.startsWith('muse-') || m.includes('muse-spark')) return true
  if (baseUrl?.includes('opencode.ai')) {
    if (
      m.startsWith('grok-') ||
      m.includes('luna') ||
      m.startsWith('omen-') ||
      m.includes('union-alpha')
    ) {
      return true
    }
  }
  if (baseUrl?.replace(/\/+$/, '').endsWith('/responses')) return true
  return false
}

/**
 * 将领域模型 LLMMessage[] 转换为 OpenAI Responses API 的 input 数组。
 * - user 消息转为 { role: 'user', content: [{ type: 'input_text', text }, ...] }
 * - assistant 消息转为 { role: 'assistant', content: [{ type: 'output_text', text }] }
 * - tool_use 提升为顶层 { type: 'function_call', call_id, name, arguments }
 * - tool_result 提升为顶层 { type: 'function_call_output', call_id, output }
 */
export function toResponsesInput(messages: LLMMessage[]): Record<string, unknown>[] {
  const input: Record<string, unknown>[] = []

  for (const message of messages) {
    if (message.role === 'tool') {
      for (const block of message.blocks) {
        if (block.type === 'tool_result') {
          input.push({
            type: 'function_call_output',
            call_id: block.toolUseId,
            output: block.content
          })
        }
      }
      continue
    }

    if (message.role === 'assistant') {
      const text = textOf(message.blocks)
      if (text) {
        input.push({
          role: 'assistant',
          content: [{ type: 'output_text', text }]
        })
      }
      for (const block of message.blocks) {
        if (block.type === 'tool_use') {
          input.push({
            type: 'function_call',
            call_id: block.id,
            name: block.name,
            arguments:
              typeof block.input === 'string' ? block.input : JSON.stringify(block.input ?? {})
          })
        }
      }
      continue
    }

    // user 消息
    const text = textOf(message.blocks)
    const images = message.blocks.filter((b) => b.type === 'image')
    const contentParts: Record<string, unknown>[] = []

    if (text) {
      contentParts.push({ type: 'input_text', text })
    }
    for (const img of images) {
      if (img.type === 'image') {
        contentParts.push({ type: 'input_image', image_url: img.dataUrl })
      }
    }

    if (contentParts.length > 0) {
      input.push({
        role: 'user',
        content: contentParts
      })
    }
  }

  return input
}

async function readErrorBody(response: Response): Promise<string> {
  try {
    return await response.text()
  } catch {
    return '<无法读取响应体>'
  }
}

export const openAiResponsesAdapter: ProviderAdapter = {
  kind: 'openai-responses',

  async *stream(request: CompletionRequest, context: ProviderContext): AsyncGenerator<StreamChunk> {
    const body: Record<string, unknown> = {
      model: request.model,
      input: toResponsesInput(request.messages),
      stream: true
    }

    if (request.system) {
      body.instructions = request.system
    }
    if (request.temperature !== undefined) {
      body.temperature = request.temperature
    }
    if (request.maxTokens !== undefined) {
      // Responses API 规定 max_output_tokens 必须 >= 16
      body.max_output_tokens = Math.max(16, request.maxTokens)
    }
    if (request.tools && request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({
        type: 'function',
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters
      }))
    }

    const endpoint = responsesUrl(context.baseUrl)
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${context.apiKey}`,
        ...(context.headers ?? {})
      },
      body: JSON.stringify(body),
      signal: context.signal
    })

    if (!response.ok || !response.body) {
      throw new ProviderHttpError(
        response.status,
        await readErrorBody(response),
        'OpenAI Responses 接口',
        response.headers.get('retry-after')
      )
    }

    const contentType = response.headers.get('content-type') || ''
    // 若服务端直接返回 application/json（非流式回退）
    if (!contentType.includes('text/event-stream')) {
      const payload = (await response.json()) as Record<string, any>
      if (payload.error) {
        throw new Error(payload.error.message ?? JSON.stringify(payload.error))
      }
      const outputItems = Array.isArray(payload.output) ? payload.output : []
      for (const item of outputItems) {
        if (item.type === 'message' && Array.isArray(item.content)) {
          for (const part of item.content) {
            if (part.type === 'output_text' && typeof part.text === 'string') {
              yield { type: 'text', text: part.text }
            }
          }
        } else if (item.type === 'function_call') {
          yield {
            type: 'tool_use',
            id: item.call_id || item.id || `call_${randomUUID()}`,
            name: item.name,
            input: parseArgs(item.arguments || '')
          }
        }
      }
      if (payload.usage) {
        yield {
          type: 'usage',
          usage: {
            promptTokens: payload.usage.input_tokens ?? payload.usage.prompt_tokens ?? 0,
            completionTokens: payload.usage.output_tokens ?? payload.usage.completion_tokens ?? 0,
            cacheReadTokens:
              payload.usage.input_tokens_details?.cached_tokens ??
              payload.usage.prompt_tokens_details?.cached_tokens,
            cacheWriteTokens:
              payload.usage.input_tokens_details?.cache_write_tokens ??
              payload.usage.cache_creation_input_tokens
          }
        }
      }
      yield { type: 'stop', reason: payload.status === 'completed' ? 'stop' : (payload.status ?? 'stop') }
      return
    }

    const toolCalls = new Map<string | number, ToolCallState>()
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

      if (payload.type === 'error' || payload.error) {
        const errorObj = payload.error ?? payload
        const errorMsg =
          errorObj.message ?? (typeof errorObj === 'string' ? errorObj : JSON.stringify(errorObj))
        throw new Error(errorMsg)
      }

      const eventType = event.event || payload.type || ''

      // 1. 文本内容增量
      if (
        eventType === 'response.output_text.delta' ||
        eventType === 'response.text.delta' ||
        eventType === 'output_text.delta' ||
        eventType === 'text.delta'
      ) {
        const delta = typeof payload.delta === 'string' ? payload.delta : payload.text
        if (delta) {
          yield { type: 'text', text: delta }
        }
      }

      // 2. 思考/推理增量
      if (
        eventType.includes('reasoning') ||
        eventType.includes('thinking') ||
        payload.type?.includes('reasoning')
      ) {
        const reasoningDelta = typeof payload.delta === 'string' ? payload.delta : payload.text
        if (reasoningDelta) {
          yield { type: 'reasoning', text: reasoningDelta }
        }
      }

      // 3. 工具调用 (Function Call)
      // response.output_item.added
      if (eventType === 'response.output_item.added' || eventType === 'output_item.added') {
        const item = payload.item
        if (item?.type === 'function_call') {
          const key = payload.output_index ?? item.call_id ?? item.id ?? toolCalls.size
          const callId = item.call_id || item.id || `call_${randomUUID()}`
          toolCalls.set(key, {
            id: callId,
            name: item.name || '',
            args: item.arguments || ''
          })
        }
      }

      // response.function_call_arguments.delta
      if (
        eventType === 'response.function_call_arguments.delta' ||
        eventType === 'function_call_arguments.delta'
      ) {
        const key = payload.output_index ?? payload.call_id ?? payload.item_id ?? 0
        const acc = toolCalls.get(key) ?? {
          id: payload.call_id || payload.item_id || `call_${randomUUID()}`,
          name: '',
          args: ''
        }
        if (payload.call_id && !acc.id) acc.id = payload.call_id
        if (payload.delta) acc.args += payload.delta
        toolCalls.set(key, acc)
      }

      // response.output_item.done
      if (eventType === 'response.output_item.done' || eventType === 'output_item.done') {
        const item = payload.item
        if (item?.type === 'function_call') {
          const key = payload.output_index ?? item.call_id ?? item.id ?? 0
          const acc = toolCalls.get(key) ?? {
            id: item.call_id || item.id || `call_${randomUUID()}`,
            name: item.name || '',
            args: ''
          }
          if (item.name) acc.name = item.name
          if (item.arguments) acc.args = item.arguments
          toolCalls.set(key, acc)
        }
      }

      // 4. Token 使用与结束事件
      if (
        eventType === 'response.completed' ||
        eventType === 'response.done' ||
        payload.response?.usage ||
        payload.usage
      ) {
        const u = payload.response?.usage || payload.usage
        if (u) {
          usage = {
            promptTokens: u.input_tokens ?? u.prompt_tokens ?? 0,
            completionTokens: u.output_tokens ?? u.completion_tokens ?? 0,
            cacheReadTokens:
              u.input_tokens_details?.cached_tokens ??
              u.prompt_tokens_details?.cached_tokens ??
              u.cache_read_input_tokens,
            cacheWriteTokens:
              u.input_tokens_details?.cache_write_tokens ?? u.cache_creation_input_tokens
          }
        }
        const respStatus = payload.response?.status || payload.status
        if (respStatus) {
          stopReason = respStatus === 'completed' ? 'stop' : respStatus
        }
      }
    }

    // 产出累积的所有工具调用
    for (const acc of toolCalls.values()) {
      if (!acc.name) continue
      yield {
        type: 'tool_use',
        id: acc.id || `call_${randomUUID()}`,
        name: acc.name,
        input: parseArgs(acc.args)
      }
    }

    if (usage) yield { type: 'usage', usage }
    yield { type: 'stop', reason: stopReason }
  },

  async listModels(context: ProviderContext): Promise<string[]> {
    // 获取模型列表时，baseUrl 若含有 /responses 路径则去除后访问 /models
    const cleanBase = context.baseUrl.replace(/\/responses\/?$/, '')
    const response = await fetch(joinUrl(cleanBase, '/models'), {
      headers: { authorization: `Bearer ${context.apiKey}`, ...(context.headers ?? {}) },
      signal: context.signal
    })
    if (!response.ok) {
      throw new ProviderHttpError(
        response.status,
        await readErrorBody(response),
        'OpenAI Responses 接口',
        response.headers.get('retry-after')
      )
    }
    const payload = (await response.json()) as { data?: { id: string }[] }
    return (payload.data ?? []).map((item) => item.id).sort()
  }
}
