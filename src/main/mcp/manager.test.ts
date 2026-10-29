import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpServerConfig } from './manager'
import { loadServerConfigs, mergeBuiltinServers, mcpToolName, McpManager, parseMcpToolName, BUILTIN_MCP_SERVERS, resolveEnv } from './manager'

vi.mock('electron-log/main', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

const settingsStub = vi.hoisted(() => ({
  servers: null as McpServerConfig[] | null,
  legacy: null as string[] | null
}))

vi.mock('../settings', () => ({
  getSetting: (key: string, fallback: unknown) => {
    if (key === 'agent.mcp.servers') return settingsStub.servers ?? fallback
    if (key === 'agent.mcpServers') return settingsStub.legacy ?? fallback
    return fallback
  }
}))

/** 假 MCP 服务：只懂握手、列工具、回固定文本，走换行 JSON。 */
const FAKE_SERVER = `
const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
  if (m.method === 'initialize') reply({ protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake', version: '0' } });
  else if (m.method === 'tools/list') reply({ tools: [{ name: 'echo', description: '回声', inputSchema: { type: 'object' } }] });
  else if (m.method === 'tools/call') reply({ content: [{ type: 'text', text: 'ok' }] });
});
`;

function fakeConfig(id: string, command: string = process.execPath): McpServerConfig {
  return { id, name: id, command, args: ['-e', FAKE_SERVER], enabled: true }
}

describe('MCP 服务管理器', () => {
  beforeEach(() => {
    settingsStub.servers = null
    settingsStub.legacy = null
  })

  it('内置服务清单：已实测的都在且默认启用', () => {
    const ids = BUILTIN_MCP_SERVERS.map((s) => s.id)
    expect(ids).toEqual(expect.arrayContaining(['memory', 'fetch', 'playwright', 'github', 'chrome-devtools', 'context7', 'duckduckgo', 'docker']))
    for (const s of BUILTIN_MCP_SERVERS) {
      // stdio 要求 command，Streamable HTTP（magpie-vision/image）要求 url
      expect(s.url || s.command).toBeTruthy()
      // Magpie 识图/生图默认关闭：网关不一定开着，用户手动启用
      if (s.id === 'magpie-vision' || s.id === 'magpie-image') {
        expect(s.enabled).toBe(false)
        continue
      }
      expect(s.enabled).toBe(true)
    }
  })

  it('空数组回落内置：0.8.1 开关残留不再清空列表', () => {
    settingsStub.servers = []
    // 白名单 legacy 为 null 时只看配置 enabled：Magpie 默认关会被过滤，
    // 这里锁定“列表不再是空的”，Magpie 的存在由上面那条覆盖。
    const ids = loadServerConfigs().map((s) => s.id)
    expect(ids).toEqual(expect.arrayContaining(['memory', 'fetch', 'playwright', 'docker']))
    expect(ids.length).toBeGreaterThan(0)
  })

  it('旧版快照自动补齐新增内置项，用户改过的保留', () => {
    const old = BUILTIN_MCP_SERVERS.filter((s) => s.id !== 'magpie-vision' && s.id !== 'magpie-image').map((s) => ({
      ...s,
      enabled: s.id === 'memory' ? false : s.enabled
    }))
    const merged = mergeBuiltinServers(old)
    expect(merged.find((s) => s.id === 'magpie-vision')).toBeTruthy()
    expect(merged.find((s) => s.id === 'magpie-image')).toBeTruthy()
    // 用户关掉的 memory 保持关闭，不被内置覆盖
    expect(merged.find((s) => s.id === 'memory')?.enabled).toBe(false)
  })

  it('Magpie 识图/生图走 HTTP，默认关闭', () => {
    const vision = BUILTIN_MCP_SERVERS.find((s) => s.id === 'magpie-vision')
    const image = BUILTIN_MCP_SERVERS.find((s) => s.id === 'magpie-image')
    expect(vision?.url).toBe('http://127.0.0.1:34254/mcp/magpie/vision')
    expect(image?.url).toBe('http://127.0.0.1:34254/mcp/magpie/image')
    expect(vision?.enabled).toBe(false)
    expect(image?.enabled).toBe(false)
    expect(mcpToolName('magpie-image', 'generate_image')).toBe('mcp__magpie-image__generate_image')
    expect(parseMcpToolName('mcp__magpie-image__generate_image')).toEqual({
      serverId: 'magpie-image',
      toolName: 'generate_image'
    })
  })

  it('环境变量展开：缺失的变量点名报告', () => {
    process.env.SHGB_TEST_TOKEN = 'abc123'
    expect(resolveEnv({ A: '${SHGB_TEST_TOKEN}', B: 'plain' })).toEqual({
      env: { A: 'abc123', B: 'plain' },
      missing: []
    })
    delete process.env.SHGB_TEST_TOKEN
    expect(resolveEnv({ A: '${SHGB_TEST_TOKEN}' })).toEqual({ env: { A: '' }, missing: ['A'] })
  })

  it('命名与解析互逆', () => {    expect(mcpToolName('fetch', 'fetch')).toBe('mcp__fetch__fetch')
    expect(parseMcpToolName('mcp__fetch__fetch')).toEqual({ serverId: 'fetch', toolName: 'fetch' })
    expect(parseMcpToolName('read_file')).toBeNull()
    expect(parseMcpToolName('mcp__broken')).toBeNull()
  })

  it('聚合工具并转发调用', async () => {
    settingsStub.servers = [fakeConfig('fake1')]
    settingsStub.legacy = ['fake1']
    const manager = new McpManager()
    try {
      const schemas = await manager.toolSchemas()
      expect(schemas.map((s) => s.name)).toEqual(['mcp__fake1__echo'])
      expect(schemas[0].description).toContain('fake1')
      await expect(manager.callTool('fake1', 'echo', {})).resolves.toEqual({
        content: 'ok',
        isError: false
      })
    } finally {
      await manager.shutdown()
    }
  })

  it('起不来的服务只跳过不炸', async () => {
    settingsStub.servers = [fakeConfig('bad', 'no-such-binary-xyz')]
    settingsStub.legacy = ['bad']
    const manager = new McpManager()
    try {
      await expect(manager.toolSchemas()).resolves.toEqual([])
      const res = await manager.callTool('bad', 'echo', {})
      expect(res.isError).toBe(true)
    } finally {
      await manager.shutdown()
    }
  })

  /*
   * 退出清理回归：before-quit 是同步回调，必须能同步收尾。
   * 线上症状是应用退出后残留 node 进程（npx 的 cmd → npx → node 三层，
   * 只杀直接子进程等于没杀）。
   */
  it('shutdownSync 能同步清空登记表，不抛错', async () => {
    settingsStub.servers = [fakeConfig('fake1')]
    settingsStub.legacy = ['fake1']
    const manager = new McpManager()
    // 先真正拉起一个服务，让 live 里有一条记录
    const schemas = await manager.toolSchemas()
    expect(schemas).toHaveLength(1)

    // 同步调用必须不抛错且立即返回（不能返回 Promise 被 await 掉）
    expect(() => manager.shutdownSync()).not.toThrow()

    // 清空后再次聚合会重新拉起，说明登记表确实被清了
    const again = await manager.toolSchemas()
    expect(again).toHaveLength(1)
    await manager.shutdown()
  })

  it('shutdownSync 对空管理器是幂等的', () => {
    const manager = new McpManager()
    expect(() => manager.shutdownSync()).not.toThrow()
    expect(() => manager.shutdownSync()).not.toThrow()
  })
})