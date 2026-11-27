import { beforeEach, describe, expect, it, vi } from 'vitest'

/* 9222 附着修饰 + 代际号（旧参数进程过期自杀，绝不复活进 live） */

const settingsState = vi.hoisted(() => ({
  servers: null as null | Array<{ id: string; name: string; command: string; args: string[]; enabled: boolean }>,
  whitelist: null as null | string[],
  attach: false
}))
vi.mock('../settings', () => ({
  getSetting: (key: string, fallback: unknown) => {
    if (key === 'agent.mcp.servers') return settingsState.servers ?? fallback
    if (key === 'agent.mcpServers') return settingsState.whitelist
    if (key === 'browser.chromeAttach9222') return settingsState.attach
    if (key === 'agent.mcp.projectLevel') return false
    return fallback
  },
  setSetting: () => {},
  getAllSettings: () => ({}),
  clearSettingsCache: () => {}
}))

const clientState = vi.hoisted(() => ({
  startCalls: 0,
  stopCalls: 0,
  gate: null as null | { resolve: (client: unknown) => void; reject: (error: unknown) => void }
}))
function makeFakeClient() {
  return {
    stop: vi.fn(async () => {
      clientState.stopCalls += 1
    }),
    stopSync: vi.fn(() => {}),
    listTools: vi.fn(async () => [{ name: 'probe', description: 'probe tool', inputSchema: {} }]),
    callTool: vi.fn(async () => ({ content: 'ok' }))
  }
}
vi.mock('./client', () => ({
  McpClient: {
    start: vi.fn(async () => {
      clientState.startCalls += 1
      if (clientState.gate) {
        return new Promise((resolve, reject) => {
          const gate = clientState.gate
          clientState.gate = null
          gate!.resolve = resolve as (client: unknown) => void
          gate!.reject = reject as (error: unknown) => void
        })
      }
      return makeFakeClient()
    })
  }
}))
vi.mock('./httpClient', () => ({
  HttpMcpClient: { start: vi.fn(async () => makeFakeClient()) }
}))

import { BUILTIN_MCP_SERVERS, McpManager, applyChromeAttachArgs } from './manager'
import type { McpServerConfig } from './manager'

function chromeConfig(args: string[] = ['-y', 'chrome-devtools-mcp']): McpServerConfig {
  const builtin = BUILTIN_MCP_SERVERS.find((s) => s.id === 'chrome-devtools')!
  return { ...builtin, args: [...args] }
}

function singleServerState(): void {
  settingsState.servers = [{ id: 'test-svc', name: 'Test', command: 'test-cmd', args: [], enabled: true }]
  settingsState.whitelist = null
  settingsState.attach = false
}

beforeEach(() => {
  settingsState.servers = null
  settingsState.whitelist = null
  settingsState.attach = false
  clientState.startCalls = 0
  clientState.stopCalls = 0
  clientState.gate = null
})

describe('applyChromeAttachArgs 9222 附着修饰', () => {
  it('开关开时注入 --browserUrl，不动原对象', () => {
    settingsState.attach = true
    const config = chromeConfig()
    const originalArgs = [...config.args]
    const result = applyChromeAttachArgs(config)
    expect(result.args.slice(-2)).toEqual(['--browserUrl', 'http://127.0.0.1:9222'])
    expect(config.args).toEqual(originalArgs)
    expect(result).not.toBe(config)
  })

  it('已有 --browserUrl（含等号形式）不重复注入', () => {
    settingsState.attach = true
    expect(applyChromeAttachArgs(chromeConfig(['-y', 'chrome-devtools-mcp', '--browserUrl', 'http://x'])).args).toHaveLength(4)
    expect(applyChromeAttachArgs(chromeConfig(['--browserUrl=http://127.0.0.1:9222'])).args).toEqual([
      '--browserUrl=http://127.0.0.1:9222'
    ])
    expect(applyChromeAttachArgs(chromeConfig(['--browser-url', 'http://127.0.0.1:9222'])).args).toHaveLength(2)
  })

  it('开关关时原样返回，不注入', () => {
    settingsState.attach = false
    const config = chromeConfig()
    expect(applyChromeAttachArgs(config)).toBe(config)
  })

  it('非 chrome-devtools 服务不受影响', () => {
    settingsState.attach = true
    const config: McpServerConfig = { id: 'playwright', name: 'Playwright', command: 'npx.cmd', args: ['-y'], enabled: true }
    expect(applyChromeAttachArgs(config)).toBe(config)
  })

  it('绝不篡改 BUILTIN_MCP_SERVERS 常量', () => {
    settingsState.attach = true
    const before = JSON.stringify(BUILTIN_MCP_SERVERS.find((s) => s.id === 'chrome-devtools')!.args)
    applyChromeAttachArgs(chromeConfig())
    expect(JSON.stringify(BUILTIN_MCP_SERVERS.find((s) => s.id === 'chrome-devtools')!.args)).toBe(before)
    expect(before).toBe('["-y","chrome-devtools-mcp"]')
  })
})

describe('stopServer 与代际号', () => {
  it('停掉活实例并清理，下次 status 冷启动', async () => {
    singleServerState()
    const manager = new McpManager()
    const first = await manager.status(true)
    expect(first.find((s) => s.id === 'test-svc')?.state).toBe('ready')
    const startsAfterFirst = clientState.startCalls
    expect(startsAfterFirst).toBeGreaterThan(0)

    await manager.stopServer('test-svc')
    expect(clientState.stopCalls).toBeGreaterThan(0)

    await manager.status(true)
    expect(clientState.startCalls).toBeGreaterThan(startsAfterFirst)
    await manager.shutdown()
  })

  it('启动中 stopServer：过期任务自杀，绝不复活旧进程', async () => {
    singleServerState()
    const manager = new McpManager()
    // 挂门：下一个 McpClient.start 悬挂，把 resolve 暂存到 gateHolder
    const gateHolder = {} as { resolve: (client: unknown) => void; reject: (error: unknown) => void }
    clientState.gate = gateHolder
    const pending = manager.status(true)
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(clientState.startCalls).toBeGreaterThan(0)
    // 启动悬挂期间停掉：代际号递增，starting 占位清理
    await manager.stopServer('test-svc')
    // 旧参数进程此时才 resolve：ensureStarted 必须认出代际过期，原地 stop 并返回 null
    gateHolder.resolve(makeFakeClient())
    const result = await pending
    expect(result.find((s) => s.id === 'test-svc')?.state).toBe('error')
    // live 里没有复活的旧进程：下一次 status 必须重新冷启动
    const callsBefore = clientState.startCalls
    const retry = await manager.status(true)
    expect(clientState.startCalls).toBeGreaterThan(callsBefore)
    expect(retry.find((s) => s.id === 'test-svc')?.state).toBe('ready')
    await manager.shutdown()
  })
})
