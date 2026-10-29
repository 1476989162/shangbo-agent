/**
 * 最小 Streamable HTTP MCP 客户端（Magpie 识图 / 生图即此类）。
 *
 * stdio 版走子进程 JSON-RPC；这里走 HTTP POST，同一套方法名：
 * initialize → tools/list → tools/call。响应可能是纯 JSON，
 * 也可能是 SSE（text/event-stream），两种都解析，只取首个 result。
 *
 * 密钥：网关信任本机回环，任意值都行，缺省用 `magpie`，
 * 与网关接入页示例一致，不再让用户另填一份。
 */

import { flattenContent, type McpCallResult, type McpToolDef } from './client'

const PROTOCOL_VERSION = '2024-11-05'
const HANDSHAKE_TIMEOUT_MS = 20_000
const LIST_TIMEOUT_MS = 20_000
/** 生图慢：与网关默认 5 分钟超时对齐，取 10 分钟上限。 */
const CALL_TIMEOUT_MS = 600_000

export interface HttpMcpOptions {
  url: string
  bearerKey?: string
  timeoutMs?: number
}

export class HttpMcpClient {
  private nextId = 1
  private sessionId: string | null = null

  private constructor(private readonly options: HttpMcpOptions) {}

  static async start(options: HttpMcpOptions): Promise<HttpMcpClient> {
    const client = new HttpMcpClient(options)
    await client.request(
      'initialize',
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'shangbo-agent', version: '0.1.0' }
      },
      HANDSHAKE_TIMEOUT_MS
    )
    // 无状态服务端可能不认这条通知：失败就吞掉，不影响后续调用。
    try {
      await client.post({ jsonrpc: '2.0', method: 'notifications/initialized', params: {} }, HANDSHAKE_TIMEOUT_MS)
    } catch {
      // 忽略：initialized 只是礼貌通知
    }
    return client
  }

  async listTools(): Promise<McpToolDef[]> {
    const res = await this.request('tools/list', {}, LIST_TIMEOUT_MS)
    const tools = Array.isArray(res.tools) ? res.tools : []
    return tools
      .filter((t): t is Record<string, unknown> => typeof t === 'object' && t !== null && typeof t.name === 'string')
      .map((t) => ({
        name: t.name as string,
        description: typeof t.description === 'string' ? t.description : undefined,
        inputSchema:
          typeof t.inputSchema === 'object' && t.inputSchema !== null
            ? (t.inputSchema as Record<string, unknown>)
            : { type: 'object' }
      }))
  }

  async callTool(name: string, args: unknown, signal?: AbortSignal): Promise<McpCallResult> {
    const res = await this.request(
      'tools/call',
      { name, arguments: (args ?? {}) as Record<string, unknown> },
      this.options.timeoutMs ?? CALL_TIMEOUT_MS,
      signal
    )
    return flattenContent(res.content, res.isError)
  }

  /** HTTP 无常驻进程：与 stdio 同接口，空实现。 */
  async stop(): Promise<void> {}
  stopSync(): void {}

  private async request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    const id = this.nextId++
    const body = await this.post({ jsonrpc: '2.0', id, method, params }, timeoutMs, signal)
    if (body && typeof body === 'object' && 'error' in body && body.error !== null && body.error !== undefined) {
      const err = body.error as Record<string, unknown>
      throw new Error(typeof err.message === 'string' ? err.message : JSON.stringify(err))
    }
    return ((body as Record<string, unknown>).result ?? {}) as Record<string, unknown>
  }

  private async post(payload: Record<string, unknown>, timeoutMs: number, signal?: AbortSignal): Promise<unknown> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs)
    signal?.addEventListener('abort', () => controller.abort(), { once: true })
    try {
      const headers: Record<string, string> = {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        authorization: `Bearer ${this.options.bearerKey?.trim() || 'magpie'}`
      }
      if (this.sessionId) headers['mcp-session-id'] = this.sessionId
      const res = await fetch(this.options.url, { method: 'POST', headers, body: JSON.stringify(payload), signal: controller.signal })
      const session = res.headers.get('mcp-session-id')
      if (session) this.sessionId = session
      if (!res.ok) throw new Error(`MCP HTTP 请求失败（${res.status}）：${this.options.url}`)
      const contentType = res.headers.get('content-type') ?? ''
      if (contentType.includes('text/event-stream')) return parseSse(await res.text())
      const text = (await res.text()).trim()
      if (!text) return {}
      // 有些实现直接回 JSON-RPC，有些包一层 SSE：都兼容。
      if (contentType.includes('application/json')) {
        try {
          return JSON.parse(text)
        } catch {
          return parseSse(text)
        }
      }
      try {
        return JSON.parse(text)
      } catch {
        return parseSse(text)
      }
    } finally {
      clearTimeout(timer)
    }
  }
}

/** 取 SSE 流里首个 `data:` JSON 块；没有就抛错，不静默编造。 */
function parseSse(text: string): unknown {
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('data:')) continue
    const data = trimmed.slice('data:'.length).trim()
    if (!data || data === '[DONE]') continue
    try {
      return JSON.parse(data)
    } catch {
      continue
    }
  }
  throw new Error('MCP HTTP 返回了空的 SSE 流')
}
