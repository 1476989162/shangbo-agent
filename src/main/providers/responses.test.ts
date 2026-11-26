import { describe, expect, it } from 'vitest'
import {
  isResponsesModel,
  mapResponsesStopReason,
  normalizeSnapshotDelta,
  responsesUrl,
  toResponsesInput,
  openAiResponsesAdapter
} from './responses'
import type { LLMMessage, CompletionRequest } from './types'

describe('Responses API Adapter', () => {
  it('normalizes true deltas and cumulative snapshots', () => {
    expect(normalizeSnapshotDelta('你', '')).toEqual({ delta: '你', snapshot: '你' })
    expect(normalizeSnapshotDelta('好', '你')).toEqual({ delta: '好', snapshot: '你好' })
    expect(normalizeSnapshotDelta('你好世界', '你好')).toEqual({
      delta: '世界',
      snapshot: '你好世界'
    })
    expect(normalizeSnapshotDelta('你好世界', '你好世界')).toEqual({
      delta: '',
      snapshot: '你好世界'
    })
  })

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

  it('does not duplicate text when the same event is also tagged as reasoning', async () => {
    const sseLines = [
      'event: response.reasoning_text.delta\n',
      'data: {"type":"response.reasoning_text.delta","delta":"先想一下"}\n\n',
      'event: response.output_text.delta\n',
      'data: {"type":"response.output_text.delta","delta":"结论"}\n\n',
      'event: response.output_text.delta\n',
      'data: {"type":"response.output_text.delta","delta":"结论：可以"}\n\n',
      'data: [DONE]\n\n'
    ]
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      start(controller) {
        for (const line of sseLines) controller.enqueue(encoder.encode(line))
        controller.close()
      }
    })
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () =>
      new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
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
        { type: 'reasoning', text: '先想一下' },
        { type: 'text', text: '结论' },
        { type: 'text', text: '：可以' },
        { type: 'stop', reason: 'stop' }
      ])
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('normalizes cumulative text snapshots from compatible gateways', async () => {
    const sseLines = [
      'event: response.output_text.delta\n',
      'data: {"type":"response.output_text.delta","delta":"结论"}\n\n',
      'event: response.output_text.delta\n',
      'data: {"type":"response.output_text.delta","delta":"结论：是"}\n\n',
      'event: response.output_text.delta\n',
      'data: {"type":"response.output_text.delta","delta":"结论：是我的问题"}\n\n',
      'data: [DONE]\n\n'
    ]
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      start(controller) {
        for (const line of sseLines) controller.enqueue(encoder.encode(line))
        controller.close()
      }
    })
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () =>
      new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    try {
      const text: string[] = []
      const req: CompletionRequest = {
        model: 'muse-spark-1.3-contributor',
        messages: [{ role: 'user', blocks: [{ type: 'text', text: 'hi' }] }]
      }
      for await (const chunk of openAiResponsesAdapter.stream(req, {
        baseUrl: 'https://opencode.ai/zen/go/v1',
        apiKey: 'test-key',
        signal: new AbortController().signal
      })) {
        if (chunk.type === 'text') text.push(chunk.text)
      }
      expect(text.join('')).toBe('结论：是我的问题')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('does not append final output_item text after the same text already streamed', async () => {
    const sseLines = [
      'event: response.output_text.delta\n',
      'data: {"type":"response.output_text.delta","delta":"完整结论"}\n\n',
      'event: response.output_item.done\n',
      'data: {"type":"response.output_item.done","item":{"type":"message","content":[{"type":"output_text","text":"完整结论"}]}}\n\n',
      'data: [DONE]\n\n'
    ]
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      start(controller) {
        for (const line of sseLines) controller.enqueue(encoder.encode(line))
        controller.close()
      }
    })
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () =>
      new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    try {
      const text: string[] = []
      const req: CompletionRequest = {
        model: 'muse-spark-1.3-contributor',
        messages: [{ role: 'user', blocks: [{ type: 'text', text: 'hi' }] }]
      }
      for await (const chunk of openAiResponsesAdapter.stream(req, {
        baseUrl: 'https://opencode.ai/zen/go/v1',
        apiKey: 'test-key',
        signal: new AbortController().signal
      })) {
        if (chunk.type === 'text') text.push(chunk.text)
      }
      expect(text.join('')).toBe('完整结论')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('ignores replayed events with the same sequence number', async () => {
    const sseLines = [
      'event: response.output_text.delta\n',
      'data: {"type":"response.output_text.delta","sequence_number":1,"delta":"不"}\n\n',
      'event: response.output_text.delta\n',
      'data: {"type":"response.output_text.delta","sequence_number":1,"delta":"不"}\n\n',
      'event: response.output_text.delta\n',
      'data: {"type":"response.output_text.delta","sequence_number":2,"delta":"重复"}\n\n',
      'data: [DONE]\n\n'
    ]
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      start(controller) {
        for (const line of sseLines) controller.enqueue(encoder.encode(line))
        controller.close()
      }
    })
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () =>
      new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    try {
      const text: string[] = []
      const req: CompletionRequest = {
        model: 'muse-spark-1.3-contributor',
        messages: [{ role: 'user', blocks: [{ type: 'text', text: 'hi' }] }]
      }
      for await (const chunk of openAiResponsesAdapter.stream(req, {
        baseUrl: 'https://opencode.ai/zen/go/v1',
        apiKey: 'test-key',
        signal: new AbortController().signal
      })) {
        if (chunk.type === 'text') text.push(chunk.text)
      }
      expect(text.join('')).toBe('不重复')
    } finally {
      globalThis.fetch = originalFetch
    }
  })

  it('does not duplicate text when one frame carries both event aliases', async () => {    const sseLines = [
      'event: response.output_text.delta\n',
      'data: {"type":"response.text.delta","sequence_number":1,"delta":"同一帧"}\n\n',
      'event: response.output_text.delta\n',
      'data: {"type":"response.text.delta","sequence_number":2,"delta":"只加一次"}\n\n',
      'data: [DONE]\n\n'
    ]
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      start(controller) {
        for (const line of sseLines) controller.enqueue(encoder.encode(line))
        controller.close()
      }
    })
    const originalFetch = globalThis.fetch
    globalThis.fetch = async () =>
      new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
    try {
      const text: string[] = []
      const req: CompletionRequest = {
        model: 'muse-spark-1.3-contributor',
        messages: [{ role: 'user', blocks: [{ type: 'text', text: 'hi' }] }]
      }
      for await (const chunk of openAiResponsesAdapter.stream(req, {
        baseUrl: 'https://opencode.ai/zen/go/v1',
        apiKey: 'test-key',
        signal: new AbortController().signal
      })) {
        if (chunk.type === 'text') text.push(chunk.text)
      }
      expect(text.join('')).toBe('同一帧只加一次')
    } finally {
      globalThis.fetch = originalFetch
    }
  })
})

describe('Responses 结束状态映射与序列号窗口 (Ticket 4)', () => {
  it('mapResponsesStopReason：completed→stop，incomplete+max_output_tokens→max_tokens', () => {
    expect(mapResponsesStopReason('completed', undefined)).toBe('stop');
    expect(mapResponsesStopReason('incomplete', 'max_output_tokens')).toBe('max_tokens');
    // 其他 incomplete 原因保持原样透传（不断言为 stop，避免误判）
    expect(mapResponsesStopReason('incomplete', 'content_filter')).toBe('incomplete');
    expect(mapResponsesStopReason('failed', undefined)).toBe('failed');
    expect(mapResponsesStopReason(undefined, undefined)).toBe('stop');
  });

  it('流式 incomplete + max_output_tokens 产出 stop=max_tokens（打通自动续写）', async () => {
    const sseLines = [
      'event: response.output_text.delta\n',
      'data: {"type":"response.output_text.delta","delta":"半截"}\n\n',
      'event: response.completed\n',
      'data: {"type":"response.completed","response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"usage":{"input_tokens":10,"output_tokens":5}}}\n\n',
      'data: [DONE]\n\n'
    ];
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        for (const line of sseLines) controller.enqueue(encoder.encode(line));
        controller.close();
      }
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    try {
      const chunks: any[] = [];
      const req: CompletionRequest = {
        model: 'muse-spark-1.3-contributor',
        messages: [{ role: 'user', blocks: [{ type: 'text', text: 'hi' }] }]
      };
      for await (const chunk of openAiResponsesAdapter.stream(req, {
        baseUrl: 'https://opencode.ai/zen/go/v1',
        apiKey: 'test-key',
        signal: new AbortController().signal
      })) {
        chunks.push(chunk);
      }
      expect(chunks.filter((c) => c.type === 'text').map((c) => c.text).join('')).toBe('半截');
      expect(chunks[chunks.length - 1]).toEqual({ type: 'stop', reason: 'max_tokens' });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('非流式 incomplete 同样映射为 max_tokens（与流式对齐）', async () => {
    const payload = {
      status: 'incomplete',
      incomplete_details: { reason: 'max_output_tokens' },
      output: [
        { type: 'message', content: [{ type: 'output_text', text: '半截正文' }] }
      ],
      usage: { input_tokens: 8, output_tokens: 4 }
    };
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
    try {
      const chunks: any[] = [];
      const req: CompletionRequest = {
        model: 'muse-spark-1.3-contributor',
        messages: [{ role: 'user', blocks: [{ type: 'text', text: 'hi' }] }]
      };
      for await (const chunk of openAiResponsesAdapter.stream(req, {
        baseUrl: 'https://opencode.ai/zen/go/v1',
        apiKey: 'test-key',
        signal: new AbortController().signal
      })) {
        chunks.push(chunk);
      }
      expect(chunks.filter((c) => c.type === 'text').map((c) => c.text).join('')).toBe('半截正文');
      expect(chunks[chunks.length - 1]).toEqual({ type: 'stop', reason: 'max_tokens' });
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('单调递增 600 个序号全部通过；旧序号被逐出窗口后重放不再去重，最新仍去重', async () => {
    const sseLines: string[] = [];
    for (let i = 1; i <= 600; i++) {
      sseLines.push('event: response.output_text.delta\n');
      sseLines.push(
        'data: {"type":"response.output_text.delta","sequence_number":' + i + ',"delta":"k' + i + ' "}\n\n'
      );
    }
    // 窗口只保留最近 256 个：#1 早已被逐出，重放会再次产出；#600 仍在窗口内，重放被吞掉
    sseLines.push('event: response.output_text.delta\n');
    sseLines.push('data: {"type":"response.output_text.delta","sequence_number":1,"delta":"OLD"}\n\n');
    sseLines.push('event: response.output_text.delta\n');
    sseLines.push('data: {"type":"response.output_text.delta","sequence_number":600,"delta":"NEW"}\n\n');
    sseLines.push('data: [DONE]\n\n');
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        for (const line of sseLines) controller.enqueue(encoder.encode(line));
        controller.close();
      }
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () =>
      new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    try {
      const text: string[] = [];
      const req: CompletionRequest = {
        model: 'muse-spark-1.3-contributor',
        messages: [{ role: 'user', blocks: [{ type: 'text', text: 'hi' }] }]
      };
      for await (const chunk of openAiResponsesAdapter.stream(req, {
        baseUrl: 'https://opencode.ai/zen/go/v1',
        apiKey: 'test-key',
        signal: new AbortController().signal
      })) {
        if (chunk.type === 'text') text.push(chunk.text);
      }
      // 600 个单调序号全部通过（无丢字）+ 旧序号重放再次产出 + 最新序号重放被去重
      const kTexts = text.filter((t) => /^k\d+ $/.test(t))
      expect(kTexts.length).toBe(600);
      expect(text).toContain('OLD');
      expect(text).not.toContain('NEW');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
