import { afterEach, describe, expect, it, vi } from 'vitest'
import { anthropicAdapter } from './anthropic'
import type { CompletionRequest } from './types'
import type { StreamChunk } from './types'

/* Anthropic 提示词缓存：请求体结构 + cache_creation 用量解析。 */

const sse = (events: unknown[]): string =>
  events.map((event) => `event: ${(event as any).type}\ndata: ${JSON.stringify(event)}\n\n`).join('') +
  'data: [DONE]\n\n'

const ctx = (): { baseUrl: string; apiKey: string; signal: AbortSignal } => ({
  baseUrl: 'https://api.anthropic.com',
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

const baseRequest: CompletionRequest = {
  model: 'claude-sonnet-4',
  system: '你是助手',
  messages: [
    { role: 'user', blocks: [{ type: 'text', text: '第一问' }] },
    { role: 'assistant', blocks: [{ type: 'text', text: '第一答' }] },
    { role: 'user', blocks: [{ type: 'text', text: '第二问' }] },
    { role: 'assistant', blocks: [{ type: 'text', text: '第二答' }] },
    { role: 'user', blocks: [{ type: 'text', text: '第三问' }] }
  ],
  tools: [
    { name: 'read_file', description: '读文件', parameters: { type: 'object' } },
    { name: 'write_file', description: '写文件', parameters: { type: 'object' } }
  ]
}

async function collect(gen: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of gen) chunks.push(chunk)
  return chunks
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('Anthropic 提示词缓存', () => {
  it('默认给 system、工具末项与倒数第二条 user 消息加 cache_control', async () => {
    const fetchSpy = mockFetch(
      sse([
        { type: 'message_start', message: { usage: { input_tokens: 10, output_tokens: 0 } } },
        { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '你好' } },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 2 } }
      ])
    )

    await collect(anthropicAdapter.stream(baseRequest, ctx()))

    const body = JSON.parse(String((fetchSpy.mock.calls[0] as unknown[])[1] && (fetchSpy.mock.calls[0] as any)[1].body))
    expect(body.system).toEqual([
      { type: 'text', text: '你是助手', cache_control: { type: 'ephemeral' } }
    ])
    expect(body.tools[body.tools.length - 1].cache_control).toEqual({ type: 'ephemeral' })
    expect(body.tools[0].cache_control).toBeUndefined()

    // messages: user(1) assistant(2) user(3) assistant(4) user(5)
    // 倒数第二条 user 是第 3 条（index 2）
    expect(body.messages[2].role).toBe('user')
    expect(body.messages[2].content.at(-1).cache_control).toEqual({ type: 'ephemeral' })
    expect(body.messages.at(-1).content.at(-1).cache_control).toBeUndefined()
  })

  it('关闭缓存时不发送任何 cache_control', async () => {
    const fetchSpy = mockFetch(
      sse([{ type: 'message_start', message: { usage: { input_tokens: 1 } } }])
    )
    await collect(
      anthropicAdapter.stream(
        { ...baseRequest, promptCache: false },
        ctx()
      )
    )
    const body = JSON.parse((fetchSpy.mock.calls[0] as any)[1].body)
    expect(JSON.stringify(body)).not.toContain('cache_control')
    expect(body.system).toEqual([{ type: 'text', text: '你是助手' }])
  })

  it('解析 cache_creation_input_tokens 到 cacheWriteTokens', async () => {
    mockFetch(
      sse([
        {
          type: 'message_start',
          message: {
            usage: {
              input_tokens: 100,
              output_tokens: 0,
              cache_read_input_tokens: 40,
              cache_creation_input_tokens: 60
            }
          }
        },
        { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 5 } }
      ])
    )
    const chunks = await collect(
      anthropicAdapter.stream(baseRequest, ctx())
    )
    const usage = chunks.find((chunk) => chunk.type === 'usage')
    expect(usage).toEqual({
      type: 'usage',
      usage: {
        promptTokens: 100,
        completionTokens: 5,
        cacheReadTokens: 40,
        cacheWriteTokens: 60
      }
    })
  })
})
