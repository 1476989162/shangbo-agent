import { randomUUID } from 'node:crypto'
import { ProviderHttpError, readSse } from './sse'
import { isResponsesModel, openAiResponsesAdapter } from './responses'
import {
  textOf,
  withAgentHeaders,
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

/** 把 `unknown` 收成非负数；缺失、非数字、NaN 一律视为「本帧没有该字段」。 */
function asCount(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return value
}

/**
 * 合并单帧 usage 到已累积的 usage。
 *
 * 为什么不是整体覆盖：OpenAI 兼容协议里 usage 通常只在最后一帧出现，
 * 但部分中转网关会在多帧重复下发，且各帧字段不齐——先发 `prompt_tokens`、
 * 后续帧只发 `completion_tokens`，或末尾帧把 `prompt_tokens` 写回 0。
 * 直接 `usage = {...}` 会让先拿到的输入侧被后帧的 0 覆盖，
 * 最终表现为「累计输入 0、输出正常」。
 *
 * 规则：只在本帧字段真实存在时才更新对应字段；累计值取见过的最大值，
 * 因为流式协议下 usage 只会随生成推进而单调增长，回退值一律视为脏数据。
 */
export function mergeUsage(
  previous: Usage | null,
  raw: Record<string, any>
): Usage {
  // DeepSeek 系返回 prompt_cache_hit_tokens / prompt_cache_miss_tokens 而不是
  // prompt_tokens；只把这两项映射到 cacheRead/cacheWrite 会让 promptTokens 恒为 0。
  // 因此当 prompt_tokens 缺失时，用命中 + 未命中回填输入侧。
  const cacheHit = asCount(raw.prompt_cache_hit_tokens)
  const cacheMiss = asCount(raw.prompt_cache_miss_tokens)
  const explicitPrompt = asCount(raw.prompt_tokens) ?? asCount(raw.input_tokens)
  const derivedPrompt =
    cacheHit !== undefined || cacheMiss !== undefined
      ? (cacheHit ?? 0) + (cacheMiss ?? 0)
      : undefined

  // 显式字段为 0 而派生值 > 0 时以派生值为准：这类网关只回缓存拆分，
  // 用 0 会白白丢掉整段输入统计。两者都为 0 时仍按 0 处理（真实空输入）。
  const framePrompt =
    explicitPrompt !== undefined && (explicitPrompt > 0 || derivedPrompt === undefined)
      ? explicitPrompt
      : derivedPrompt !== undefined
        ? derivedPrompt
        : explicitPrompt

  const pickMax = (a: number | undefined, b: number | undefined): number | undefined => {
    if (a === undefined) return b
    if (b === undefined) return a
    return Math.max(a, b)
  }

  return {
    promptTokens: pickMax(previous?.promptTokens, framePrompt) ?? 0,
    completionTokens:
      pickMax(previous?.completionTokens, asCount(raw.completion_tokens) ?? asCount(raw.output_tokens)) ?? 0,
    ...(cacheHit !== undefined || previous?.cacheReadTokens !== undefined
      ? { cacheReadTokens: pickMax(previous?.cacheReadTokens, cacheHit) }
      : {}),
    ...(cacheMiss !== undefined || previous?.cacheWriteTokens !== undefined
      ? { cacheWriteTokens: pickMax(previous?.cacheWriteTokens, cacheMiss) }
      : {})
  }
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
          // 带图结果（Computer Use 截图）：tool 消息支持图文混排。
          if (block.image?.dataUrl) {
            out.push({
              role: 'tool',
              tool_call_id: block.toolUseId,
              content: [
                { type: 'text', text: block.content },
                { type: 'image_url', image_url: { url: block.image.dataUrl } }
              ]
            })
          } else {
            out.push({ role: 'tool', tool_call_id: block.toolUseId, content: block.content })
          }
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

    const images = message.blocks.filter((b) => b.type === 'image' && b.dataUrl)
    if (images.length > 0) {
      out.push({
        role: message.role,
        content: [
          { type: 'text', text: textOf(message.blocks) },
          ...images.map((b) => ({
            type: 'image_url',
            // 已过滤掉未水合的图片，这里 dataUrl 必定存在
            image_url: { url: b.type === 'image' ? (b.dataUrl as string) : '' }
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
    // 若模型或端点属于 Responses API（如 OpenCode Go 下的 muse-spark 系列），自动走 responses 协议
    if (isResponsesModel(request.model, context.baseUrl)) {
      yield* openAiResponsesAdapter.stream(request, context)
      return
    }

    const body: Record<string, unknown> = {
      model: request.model,
      messages: toOpenAiMessages(request.system, request.messages),
      stream: true,
      stream_options: { include_usage: true }
    }
    if (request.temperature !== undefined) body.temperature = request.temperature
    if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens
    // DeepSeek V4 与 SenseNova 吃顶层 reasoning_effort；其他模型不发送，
    // 严格网关会对未知参数直接 400。
    if (request.reasoningEffort !== undefined && /deepseek|sensenova/i.test(request.model)) {
      body.reasoning_effort = request.reasoningEffort
    }
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
        authorization: `Bearer ${context.apiKey}`,
        ...withAgentHeaders(context.headers)
      },
      body: JSON.stringify(body),
      signal: context.signal
    })
    if (!response.ok || !response.body) {
      throw new ProviderHttpError(
        response.status,
        await readErrorBody(response),
        'OpenAI 兼容接口',
        response.headers.get('retry-after')
      )
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
          if (call.function?.name) {
            // 标准协议按分片递增拼接函数名；但部分兼容网关（某些 GLM/千问中转）
            // 每个 chunk 都重发完整函数名，直接拼接会得到重复串。
            // 已有名字且新名是它的后缀时视为重发，保持不变；否则按分片拼接。
            if (acc.name && acc.name.endsWith(call.function.name)) {
              // 网关重发完整名：忽略
            } else {
              acc.name += call.function.name
            }
          }
          if (call.function?.arguments) acc.args += call.function.arguments
          toolCalls.set(index, acc)
        }
      }

      if (choice?.finish_reason) stopReason = choice.finish_reason

      if (payload.usage) {
        // 逐帧合并而不是整体覆盖：部分兼容网关会在中间帧带 usage，且只填其中一侧
        // （例如先发 prompt_tokens、后续帧只发 completion_tokens，或末尾帧把
        // prompt_tokens 写回 0）。整体覆盖会把先前拿到的输入侧覆盖成 0，
        // 表现为「累计输入恒为 0、输出正常」。
        const merged = mergeUsage(usage, payload.usage)
        usage = merged
      }    }

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
      headers: {
        authorization: `Bearer ${context.apiKey}`,
        ...withAgentHeaders(context.headers)
      },
      signal: context.signal
    })
    if (!response.ok) {
      throw new ProviderHttpError(
        response.status,
        await readErrorBody(response),
        'OpenAI 兼容接口',
        response.headers.get('retry-after')
      )
    }
    const payload = (await response.json()) as { data?: { id: string }[] }
    return (payload.data ?? []).map((item) => item.id).sort()
  }
}