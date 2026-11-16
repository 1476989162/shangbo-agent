import http from 'node:http'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { probeChromeDebugging } from './browserProbe'

const originalGet = http.get
afterEach(() => {
  vi.restoreAllMocks()
})

function mockResponse(statusCode: number, body: string): void {
  vi.spyOn(http, 'get').mockImplementation((_url, _options, callback) => {
    const handlers = new Map<string, (value?: unknown) => void>()
    const response = {
      statusCode,
      setEncoding: () => {},
      resume: () => {},
      on: (event: string, handler: (value?: unknown) => void) => {
        handlers.set(event, handler)
        return response
      }
    }
    callback?.(response as unknown as http.IncomingMessage)
    queueMicrotask(() => {
      if (statusCode === 200) {
        handlers.get('data')?.(body)
        handlers.get('end')?.()
      }
    })
    return {
      on: () => {},
      destroy: () => {}
    } as unknown as http.ClientRequest
  })
}

describe('本机 Chrome 调试端口探测', () => {
  it('有效 CDP 版本响应才认为已连接', async () => {
    mockResponse(200, '{"Browser":"Chrome/145.0"}')
    await expect(probeChromeDebugging()).resolves.toBe(true)
  })
  it('普通 200 页面不误报为浏览器', async () => {
    mockResponse(200, '<html>not a CDP endpoint</html>')
    await expect(probeChromeDebugging()).resolves.toBe(false)
  })
  it('非 200 状态不误报', async () => {
    mockResponse(503, '{}')
    await expect(probeChromeDebugging()).resolves.toBe(false)
  })
})

void originalGet
