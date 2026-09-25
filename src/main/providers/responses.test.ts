import { describe, expect, it } from 'vitest'
import { isResponsesModel, responsesUrl, toResponsesInput, openAiResponsesAdapter } from './responses'
import type { LLMMessage, CompletionRequest } from './types'

describe('Responses API Adapter', () => {
  it('correctly determines whether a model is a Responses model', () => {
    expect(isResponsesModel('muse-spark-1.3-contributor')).toBe(true)
    expect(isResponsesModel('muse-spark-1.2-contributor')).toBe(true)
    expect(isResponsesModel('grok-4.6', 'https://opencode.ai/zen/go/v1')).toBe(true)
    expect(isResponsesModel('gpt-5.6-luna', 'https://opencode.ai/zen/go/v1')).toBe(true)
    expect(isResponsesModel('deepseek-flash', 'https://opencode.ai/zen/go/v1')).toBe(false)
    expect(isResponsesModel('deepseek-chat', 'https://api.deepseek.com/v1')).toBe(false)
    expect(isResponsesModel('any-model', 'https://custom-gateway.com/v1/responses')).toBe(true)
  })

  it('normalizes responses url properly', () => {
    expect(responsesUrl('https://opencode.ai/zen/go/v1')).toBe(
      'https://opencode.ai/zen/go/v1/responses'
    )
    expect(responsesUrl('https://opencode.ai/zen/go/v1/')).toBe(
      'https://opencode.ai/zen/go/v1/responses'
    )
    expect(responsesUrl('https://opencode.ai/zen/go/v1/responses/')).toBe(
      'https://opencode.ai/zen/go/v1/responses'
    )
  })

  it('transforms messages to responses input format', () => {
    const messages: LLMMessage[] = [
      {
        role: 'user',
        blocks: [{ type: 'text', text: 'Hello' }]
      },
      {
        role: 'assistant',
        blocks: [
          { type: 'text', text: 'Let me run a tool' },
          { type: 'tool_use', id: 'call_1', name: 'calculator', input: { a: 1, b: 2 } }
        ]
      },
      {
        role: 'tool',
        blocks: [{ type: 'tool_result', toolUseId: 'call_1', content: '3', isError: false }]
      }
    ]

    const input = toResponsesInput(messages)
    expect(input).toEqual([
      {
        role: 'user',
        content: [{ type: 'input_text', text: 'Hello' }]
      },
      {
        role: 'assistant',
        content: [{ type: 'output_text', text: 'Let me run a tool' }]
      },
      {
        type: 'function_call',
        call_id: 'call_1',
        name: 'calculator',
        arguments: JSON.stringify({ a: 1, b: 2 })
      },
      {
        type: 'function_call_output',
        call_id: 'call_1',
        output: '3'
      }
    ])
  })

  it('streams responses SSE events correctly', async () => {
    const sseLines = [
      'event: response.output_text.delta\n',
      'data: {"type":"response.output_text.delta","delta":"Hello "}\n\n',
      'event: response.output_text.delta\n',
      'data: {"type":"response.output_text.delta","delta":"world!"}\n\n',
      'event: response.completed\n',
      'data: {"type":"response.completed","response":{"status":"completed","usage":{"input_tokens":10,"output_tokens":5}}}\n\n',
      'data: [DONE]\n\n'
    ]

    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      start(controller) {
        for (const line of sseLines) {
          controller.enqueue(encoder.encode(line))
        }
        controller.close()
      }
    })

    const mockResponse = new Response(stream, {
      status: 200,
      headers: { 'content-type': 'text/event-stream' }
    })

    const originalFetch = globalThis.fetch
    globalThis.fetch = async () => mockResponse

    try {
      const chunks: any[] = []
      const req: CompletionRequest = {
        model: 'muse-spark-1.3-contributor',
        messages: [{ role: 'user', blocks: [{ type: 'text', text: 'hi' }] }]
      }
      for await (const chunk of openAiResponsesAdapter.stream(req, {
        baseUrl: 'https://opencode.ai/zen/go/v1',
        apiKey: 'test-key',
        signal: new AbortController().signal
      })) {
        chunks.push(chunk)
      }

      expect(chunks).toEqual([
        { type: 'text', text: 'Hello ' },
        { type: 'text', text: 'world!' },
        { type: 'usage', usage: { promptTokens: 10, completionTokens: 5, cacheReadTokens: undefined, cacheWriteTokens: undefined } },
        { type: 'stop', reason: 'stop' }
      ])
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})
