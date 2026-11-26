import { afterEach, describe, expect, it, vi } from 'vitest'
import { HttpMcpClient } from './httpClient'

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' }
  })
}

function mockFetchSequence(payloads: unknown[]): void {
  const fetchMock = vi.fn(async () => jsonResponse(payloads.shift() ?? {}))
  vi.stubGlobal('fetch', fetchMock)
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

/** 取 signal 上 add/remove('abort', fn) 的调用记录，用于断言监听成对摘除。 */
function trackAbort(signal: AbortSignal): {
  added: unknown[]
  removed: unknown[]
} {
  const addSpy = vi.spyOn(signal, 'addEventListener')
  const removeSpy = vi.spyOn(signal, 'removeEventListener')
  return {
    get added(): unknown[] {
      return addSpy.mock.calls.filter((call) => call[0] === 'abort').map((call) => call[1])
    },
    get removed(): unknown[] {
      return removeSpy.mock.calls.filter((call) => call[0] === 'abort').map((call) => call[1])
    }
  }
}

describe('HttpMcpClient abort 监听清理', () => {
  it('请求成功后摘掉外部 signal 上的监听', async () => {
    // initialize + notifications/initialized + tools/call
    mockFetchSequence([
      { jsonrpc: '2.0', id: 1, result: {} },
      {},
      { jsonrpc: '2.0', id: 3, result: { content: [{ type: 'text', text: 'ok' }] } }
    ])
    const client = await HttpMcpClient.start({ url: 'http://127.0.0.1:9/mcp', timeoutMs: 5000 })
    const controller = new AbortController()
    const tracked = trackAbort(controller.signal)

    const result = await client.callTool('ping', {}, controller.signal)
    expect(result.content).toBe('ok')
    expect(tracked.added).toHaveLength(1)
    // finally 必摘：添加的监听必须被同引用移除
    expect(tracked.removed).toContain(tracked.added[0])
  })

  it('请求失败时同样摘掉监听', async () => {
    mockFetchSequence([
      { jsonrpc: '2.0', id: 1, result: {} },
      {}
    ])
    const client = await HttpMcpClient.start({ url: 'http://127.0.0.1:9/mcp', timeoutMs: 5000 })
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('网络中断')
      })
    )
    const controller = new AbortController()
    const tracked = trackAbort(controller.signal)

    await expect(client.callTool('ping', {}, controller.signal)).rejects.toThrow()
    expect(tracked.added).toHaveLength(1)
    expect(tracked.removed).toContain(tracked.added[0])
  })
})
