import { describe, expect, it, vi } from 'vitest'
import { flattenContent, McpClient } from './client'

vi.mock('electron-log/main', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

/** 假 MCP 服务：只懂握手、列工具、回声调用，走换行 JSON。 */
const FAKE_SERVER = `
const rl = require('readline').createInterface({ input: process.stdin });
rl.on('line', (line) => {
  let m;
  try { m = JSON.parse(line); } catch { return; }
  const reply = (result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: m.id, result }) + '\\n');
  if (m.method === 'initialize') reply({ protocolVersion: '2024-11-05', capabilities: {}, serverInfo: { name: 'fake', version: '0' } });
  else if (m.method === 'tools/list') reply({ tools: [{ name: 'echo', description: '回声', inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] } }] });
  else if (m.method === 'tools/call') reply({ content: [{ type: 'text', text: 'echo:' + ((m.params.arguments || {}).text || '') }] });
});
`;

describe('MCP stdio 客户端', () => {
  it('握手 + 列工具 + 调工具全链路', async () => {
    const client = await McpClient.start({ command: process.execPath, args: ['-e', FAKE_SERVER] })
    try {
      const tools = await client.listTools()
      expect(tools).toHaveLength(1)
      expect(tools[0].name).toBe('echo')
      expect(tools[0].inputSchema).toMatchObject({ type: 'object' })

      const res = await client.callTool('echo', { text: 'hi' })
      expect(res).toEqual({ content: 'echo:hi', isError: false })
    } finally {
      await client.stop()
    }
  })

  it('连不上直接抛错，不 hang', async () => {
    await expect(McpClient.start({ command: 'definitely-not-a-real-binary-xyz', args: [] })).rejects.toThrow()
  })

  it('内容压平：文本拼接、图片占位、空内容判错', () => {
    expect(flattenContent([{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }], false)).toEqual({
      content: 'a\nb',
      isError: false
    })
    expect(flattenContent([{ type: 'image' }], false).content).toContain('省略')
    expect(flattenContent([], false).isError).toBe(true)
    expect(flattenContent([{ type: 'text', text: 'boom' }], true).isError).toBe(true)
  })
})
