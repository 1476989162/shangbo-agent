import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { McpServerConfig } from './manager'
import { mcpToolName, McpManager, parseMcpToolName, BUILTIN_MCP_SERVERS, resolveEnv } from './manager'

vi.mock('electron-log/main', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

const settingsStub = vi.hoisted(() => ({ servers: null as McpServerConfig[] | null }))

vi.mock('../settings', () => ({
  getSetting: (key: string, fallback: unknown) =>
    key === 'agent.mcp.servers' ? (settingsStub.servers ?? fallback) : fallback
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
  })

  it('内置服务清单：已实测的都在且默认启用', () => {
    const ids = BUILTIN_MCP_SERVERS.map((s) => s.id)
    expect(ids).toEqual(expect.arrayContaining(['memory', 'fetch', 'playwright', 'github', 'chrome-devtools', 'context7', 'duckduckgo', 'docker']))
    for (const s of BUILTIN_MCP_SERVERS) {
      expect(s.command.length).toBeGreaterThan(0)
      expect(s.args.length).toBeGreaterThan(0)
      expect(s.enabled).toBe(true)
    }
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
    const manager = new McpManager()
    try {
      await expect(manager.toolSchemas()).resolves.toEqual([])
      const res = await manager.callTool('bad', 'echo', {})
      expect(res.isError).toBe(true)
    } finally {
      await manager.shutdown()
    }
  })
})
