import http from 'node:http'
import { EventEmitter } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'

const { spawnMock, fsState } = vi.hoisted(() => ({
  spawnMock: vi.fn(),
  fsState: { chromePresent: false }
}))
vi.mock('node:child_process', () => ({ spawn: spawnMock }))
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    existsSync: () => fsState.chromePresent,
    statSync: () => {
      if (!fsState.chromePresent) throw new Error('no such file')
      return { isFile: () => true } as unknown as ReturnType<typeof actual.statSync>
    }
  }
})

import { launchChromeForDebugging, probeChromeDebugging, probeChromeDetails } from './browserProbe'

const originalGet = http.get
afterEach(() => {
  vi.restoreAllMocks()
  spawnMock.mockReset()
  fsState.chromePresent = false
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

describe('CDP 详情探测 probeChromeDetails', () => {
  it('返回浏览器名与调试地址', async () => {
    mockResponse(200, '{"Browser":"Chrome/145.0","webSocketDebuggerUrl":"ws://127.0.0.1:9222/devtools/browser/abc"}')
    await expect(probeChromeDetails()).resolves.toEqual({
      connected: true,
      browser: 'Chrome/145.0',
      webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/abc'
    })
  })
  it('缺 Browser 字段视为未连接且不抛错', async () => {
    mockResponse(200, '{"id":"x"}')
    await expect(probeChromeDetails()).resolves.toEqual({ connected: false })
  })
  it('非 200 状态视为未连接', async () => {
    mockResponse(503, '{}')
    await expect(probeChromeDetails()).resolves.toEqual({ connected: false })
  })
})

describe('一键启动调试版 Chrome', () => {
  it('9222 已运行直接幂等返回，不拉起新进程', async () => {
    mockResponse(200, '{"Browser":"Chrome/145.0"}')
    const result = await launchChromeForDebugging('/tmp/shangbo-test')
    expect(result).toEqual({
      ok: true,
      alreadyRunning: true,
      browser: 'Chrome/145.0',
      message: 'Chrome 9222 调试端口已在运行'
    })
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('找不到 Chrome 返回真实错误，不伪装启动', async () => {
    mockResponse(503, '{}')
    const result = await launchChromeForDebugging('/tmp/shangbo-test')
    expect(result).toEqual({
      ok: false,
      error: '未在本机找到 Google Chrome 可执行文件，请先安装 Chrome。'
    })
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('spawn 异步启动失败如实返回，不炸主进程', async () => {
    fsState.chromePresent = true
    mockResponse(503, '{}')
    const child = new EventEmitter() as EventEmitter & { unref: () => void }
    child.unref = () => {}
    spawnMock.mockImplementation(() => {
      queueMicrotask(() => child.emit('error', new Error('spawn ENOENT')))
      return child
    })
    const result = await launchChromeForDebugging('/tmp/shangbo-test')
    expect(spawnMock).toHaveBeenCalledTimes(1)
    expect(spawnMock.mock.calls[0][0] as string).toMatch(/chrome/i)
    expect((spawnMock.mock.calls[0][2] as { shell?: unknown }).shell).toBeUndefined()
    expect(result).toEqual({ ok: false, error: '启动 Chrome 失败：spawn ENOENT' })
  })
})

void originalGet
