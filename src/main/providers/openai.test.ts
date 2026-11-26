import { afterEach, describe, expect, it, vi } from 'vitest'
import { mergeUsage, openAiCompatibleAdapter } from './openai'
import type { CompletionRequest, StreamChunk } from './types'

/*
 * Token 统计失真回归测试。
 *
 * 线上症状：Token 用量页显示「累计输入 0 / 累计输出 859.7k」，
 * 总消耗恰好等于输出量。根因是 usage 逐帧整体覆盖——部分兼容网关
 * 先发 prompt_tokens、后续帧只发 completion_tokens，或末尾帧把
 * prompt_tokens 写回 0，覆盖后输入侧整段丢失。
 */

describe('mergeUsage 逐帧合并', () => {
  it('后帧把 prompt_tokens 写回 0 时，不覆盖已拿到的输入侧', () => {
    const first = mergeUsage(null, { prompt_tokens: 1200, completion_tokens: 10 })
    expect(first.promptTokens).toBe(1200)

    // 末尾帧只带输出，且把 prompt_tokens 写成 0（真实网关行为）
    const last = mergeUsage(first, { prompt_tokens: 0, completion_tokens: 240 })
    expect(last.promptTokens).toBe(1200) // 关键：不被 0 覆盖
    expect(last.completionTokens).toBe(240)
  })

  it('先发输入、后帧只发输出时，两侧都能留下', () => {
    let usage = mergeUsage(null, { prompt_tokens: 900 })
    usage = mergeUsage(usage, { completion_tokens: 50 })
    usage = mergeUsage(usage, { completion_tokens: 120 })
    expect(usage.promptTokens).toBe(900)
    expect(usage.completionTokens).toBe(120)
  })

  it('DeepSeek 只回缓存拆分时，用命中+未命中回填输入侧', () => {
    const usage = mergeUsage(null, {
      prompt_cache_hit_tokens: 800,
      prompt_cache_miss_tokens: 400,
      completion_tokens: 60
    })
    expect(usage.promptTokens).toBe(1200)
    expect(usage.cacheReadTokens).toBe(800)
    expect(usage.cacheWriteTokens).toBe(400)
  })

  it('显式 prompt_tokens 为 0 但缓存拆分有值，以派生值为准', () => {
    const usage = mergeUsage(null, {
      prompt_tokens: 0,
      prompt_cache_hit_tokens: 700,
      prompt_cache_miss_tokens: 300,
      completion_tokens: 30
    })
    expect(usage.promptTokens).toBe(1000)
  })

  it('确实空输入（全 0）时保持 0，不臆造数据', () => {
    const usage = mergeUsage(null, { prompt_tokens: 0, completion_tokens: 0 })
    expect(usage.promptTokens).toBe(0)
    expect(usage.completionTokens).toBe(0)
  })

  it('兼容 input_tokens / output_tokens 命名（部分网关如此）', () => {
    const usage = mergeUsage(null, { input_tokens: 500, output_tokens: 100 })
    expect(usage.promptTokens).toBe(500)
    expect(usage.completionTokens).toBe(100)
  })

  it('非法字段（null / 字符串 / NaN）视为缺失，不污染统计', () => {
    const usage = mergeUsage(null, {
      prompt_tokens: null,
      completion_tokens: 'abc',
      prompt_cache_hit_tokens: Number.NaN
    })
    expect(usage.promptTokens).toBe(0)
    expect(usage.completionTokens).toBe(0)
  })

  it('累计值单调不回退：中间帧出现更小的值时不采纳', () => {
    let usage = mergeUsage(null, { prompt_tokens: 1000, completion_tokens: 200 })
    usage = mergeUsage(usage, { prompt_tokens: 300, completion_tokens: 150 })
    expect(usage.promptTokens).toBe(1000)
    expect(usage.completionTokens).toBe(200)
  })

  it('标准 prompt_tokens_details.cached_tokens 映射到 cacheRead，不参与输入回填', () => {
    // 标准形态：prompt_tokens 已是总量（含缓存），cached_tokens 只补 cacheRead 口径
    const usage = mergeUsage(null, {
      prompt_tokens: 500,
      completion_tokens: 50,
      prompt_tokens_details: { cached_tokens: 200, audio_tokens: 0 }
    })
    expect(usage.promptTokens).toBe(500)
    expect(usage.cacheReadTokens).toBe(200)
    expect(usage.cacheWriteTokens).toBeUndefined()
  })
})

/* ---- 工具名流式拼接（=== 精确匹配）回归 ---- */

const sse = (events: unknown[]): string =>
  events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('') + 'data: [DONE]\n\n'

const streamCtx = (): { baseUrl: string; apiKey: string; signal: AbortSignal } => ({
  baseUrl: 'https://api.deepseek.com/v1',
  apiKey: 'k',
  signal: new AbortController().signal
})

function mockFetch(body: string): ReturnType<typeof vi.fn> {
  const spy = vi.fn(async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(body))
        controller.close()
      }
    })
    return new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' }
    })
  })
  vi.stubGlobal('fetch', spy)
  return spy
}

async function collect(gen: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of gen) chunks.push(chunk)
  return chunks
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('openai tool_calls 流式拼接', () => {
  const baseRequest: CompletionRequest = {
    model: 'deepseek-chat',
    messages: [{ role: 'user', blocks: [{ type: 'text', text: 'hi' }] }],
    tools: [{ name: 'press_key', description: '按键', parameters: { type: 'object' } }]
  }

  it('单字符分片下发 press_key 不吞双字母（=== 而非 endsWith）', async () => {
    // 旧 endsWith 逻辑：acc='pres' 遇到增量 's' 时误判为重发，直接吞掉第二个 s
    const name = 'press_key'
    const events: unknown[] = name.split('').map((ch, i) => ({
      choices: [
        {
          delta: {
            tool_calls: [{ index: 0, id: i === 0 ? 'call_1' : undefined, function: { name: ch } }]
          }
        }
      ]
    }))
    events.push(
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] },
      { usage: { prompt_tokens: 10, completion_tokens: 5 } }
    )
    mockFetch(sse(events))
    const chunks = await collect(openAiCompatibleAdapter.stream(baseRequest, streamCtx()))
    const toolUse = chunks.find((c) => c.type === 'tool_use')
    expect(toolUse).toMatchObject({ id: 'call_1', name: 'press_key' })
  })

  it('网关整名重发时仍去重（=== 命中即跳过）', async () => {
    const events: unknown[] = [
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_2', function: { name: 'run_command' } }] } }] },
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'run_command' } }] } }] },
      { choices: [{ delta: {}, finish_reason: 'tool_calls' }] }
    ]
    mockFetch(sse(events))
    const chunks = await collect(openAiCompatibleAdapter.stream(baseRequest, streamCtx()))
    const toolUse = chunks.find((c) => c.type === 'tool_use')
    expect(toolUse).toMatchObject({ id: 'call_2', name: 'run_command' })
  })

  it('o1/o3/gpt-5 系列下发顶层 reasoning_effort（已验证的 OpenAI 公开参数）', async () => {
    const fetchSpy = mockFetch(
      sse([{ choices: [{ delta: {}, finish_reason: 'stop' }] }, { usage: { prompt_tokens: 1 } }])
    )
    await collect(
      openAiCompatibleAdapter.stream(
        { ...baseRequest, model: 'o3-mini', reasoningEffort: 'medium' },
        { ...streamCtx(), baseUrl: 'https://api.openai.com/v1' }
      )
    )
    const body = JSON.parse(String(fetchSpy.mock.calls[0][1].body))
    expect(body.reasoning_effort).toBe('medium')
  })

  it('deepseek/sensenova 保持下发 reasoning_effort（既有行为锁定）', async () => {
    const fetchSpy = mockFetch(sse([{ choices: [{ delta: {}, finish_reason: 'stop' }] }]))
    await collect(
      openAiCompatibleAdapter.stream(
        { ...baseRequest, model: 'deepseek-reasoner', reasoningEffort: 'high' },
        streamCtx()
      )
    )
    const body = JSON.parse(String(fetchSpy.mock.calls[0][1].body))
    expect(body.reasoning_effort).toBe('high')
  })

  it('非推理模型不发送 reasoning_effort（严格网关会 400）', async () => {
    const fetchSpy = mockFetch(sse([{ choices: [{ delta: {}, finish_reason: 'stop' }] }]))
    await collect(
      openAiCompatibleAdapter.stream(
        { ...baseRequest, model: 'qwen-plus', reasoningEffort: 'high' },
        streamCtx()
      )
    )
    const body = JSON.parse(String(fetchSpy.mock.calls[0][1].body))
    expect(body).not.toHaveProperty('reasoning_effort')
  })

  it('词边界匹配：pro3/turbo4/audio1 不触发 reasoning_effort 下发', async () => {
    for (const model of ['pro3-turbo', 'turbo4', 'audio1-preview']) {
      const fetchSpy = mockFetch(sse([{ choices: [{ delta: {}, finish_reason: 'stop' }] }]))
      await collect(
        openAiCompatibleAdapter.stream(
          { ...baseRequest, model, reasoningEffort: 'high' },
          streamCtx()
        )
      )
      const body = JSON.parse(String(fetchSpy.mock.calls[0][1].body))
      expect(body, model).not.toHaveProperty('reasoning_effort')
    }
  })
})
