import { describe, expect, it } from 'vitest'
import { ProviderHttpError, readSse, type SseEvent } from './sse'

/** 把字符串编码成 UTF-8 分片，模拟网络 chunk（可按 size 切分测试跨 chunk 边界）。 */
function chunksOf(text: string, size?: number): Uint8Array[] {
  const bytes = new TextEncoder().encode(text)
  if (!size) return [bytes]
  const out: Uint8Array[] = []
  for (let i = 0; i < bytes.length; i += size) {
    out.push(bytes.subarray(i, i + size))
  }
  return out
}

function streamFrom(chunks: Uint8Array[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    }
  })
}

async function collect(body: ReadableStream<Uint8Array>): Promise<SseEvent[]> {
  const events: SseEvent[] = []
  for await (const event of readSse(body)) events.push(event)
  return events
}

describe('readSse', () => {
  it('解析单个标准事件', async () => {
    const events = await collect(
      streamFrom(chunksOf('event: message\ndata: {"a":1}\n\n'))
    )
    expect(events).toEqual([{ event: 'message', data: '{"a":1}' }])
  })

  it('多行 data 用换行拼接', async () => {
    const events = await collect(streamFrom(chunksOf('data: line1\ndata: line2\n\n')))
    expect(events).toEqual([{ event: null, data: 'line1\nline2' }])
  })

  it('\\r\\n\\r\\n 分隔与 \\n\\n 等价', async () => {
    const events = await collect(streamFrom(chunksOf('data: a\r\n\r\ndata: b\r\n\r\n')))
    expect(events.map((e) => e.data)).toEqual(['a', 'b'])
  })

  it('CRLF 边界被切到两个 chunk 时仍能正确解析', async () => {
    // "\r" 在上一个 chunk 末尾，"\n\r\n" 在下一个 chunk 开头
    const events = await collect(streamFrom(chunksOf('data: a\r', 1).concat(chunksOf('\n\r\ndata: b\n\n'))))
    expect(events.map((e) => e.data)).toEqual(['a', 'b'])
  })

  it('事件跨多个 chunk 到达', async () => {
    const events = await collect(
      streamFrom(chunksOf('event: delta\ndata: {"text":"你"}\n\n', 3))
    )
    expect(events).toEqual([{ event: 'delta', data: '{"text":"你"}' }])
  })

  it('注释行（: 开头）被忽略', async () => {
    const events = await collect(streamFrom(chunksOf(': keep-alive\ndata: x\n\n')))
    expect(events).toEqual([{ event: null, data: 'x' }])
  })

  it('流结束时残留的未完成事件被冲刷出来', async () => {
    const events = await collect(streamFrom(chunksOf('data: tail', 2)))
    expect(events).toEqual([{ event: null, data: 'tail' }])
  })

  it('没有 data 行的事件不产出', async () => {
    const events = await collect(streamFrom(chunksOf('event: ping\n\n')))
    expect(events).toEqual([])
  })

  it('[DONE] 与普通事件一样原样交由上层判断', async () => {
    const events = await collect(streamFrom(chunksOf('data: [DONE]\n\n')))
    expect(events).toEqual([{ event: null, data: '[DONE]' }])
  })
})

describe('ProviderHttpError', () => {
  it('408 / 429 / 5xx 可重试', () => {
    for (const status of [408, 429, 500, 502, 503]) {
      expect(new ProviderHttpError(status, '', 'x').retryable).toBe(true)
    }
  })

  it('401 / 400 / 404 不可重试', () => {
    for (const status of [400, 401, 403, 404]) {
      expect(new ProviderHttpError(status, '', 'x').retryable).toBe(false)
    }
  })

  it('错误信息包含状态码与截断后的响应体', () => {
    const error = new ProviderHttpError(429, 'b'.repeat(500), '某供应商')
    expect(error.message).toContain('429')
    expect(error.message).toContain('某供应商')
    expect(error.message.length).toBeLessThan(400)
  })
})
