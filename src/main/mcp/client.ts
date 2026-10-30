import { execFile, spawn, type ChildProcess } from 'node:child_process'
import log from 'electron-log/main'

/**
 * 最小 MCP stdio 客户端（手写 JSON-RPC，不引 SDK）。
 * 只实现 Agent 需要的三个动作：initialize 握手、tools/list、tools/call。
 * 传输是换行分隔的 JSON；服务端发来的通知直接忽略，对我们的请求一律回
 * MethodNotFound（参考服务不会发请求，不让它 hang 住即可）。
 */

const PROTOCOL_VERSION = '2024-11-05'
const HANDSHAKE_TIMEOUT_MS = 20_000
const LIST_TIMEOUT_MS = 20_000
const CALL_TIMEOUT_MS = 120_000

interface Pending {
  resolve: (value: Record<string, unknown>) => void
  reject: (error: Error) => void
  timer: ReturnType<typeof setTimeout>
}

export interface McpToolDef {
  name: string
  description?: string
  inputSchema: Record<string, unknown>
}

export interface McpCallResult {
  content: string
  isError: boolean
  /** MCP 返回的首张图片（生图/截图类工具）：透传给 tool_result 做主动展示与回传模型。 */
  image?: { mimeType: string; dataUrl: string }
}

/** MCP 图片块 base64 上限：约 6MB 原图，超出则只留占位，避免 DB 与上下文被单张图打爆。 */
const MCP_IMAGE_MAX_DATA_CHARS = 8_000_000
export interface SpawnOptions {
  command: string
  args: string[]
  env?: Record<string, string>
}

function needsShell(command: string): boolean {
  return /\.cmd$|\.bat$/i.test(command)
}

/**
 * 终止整棵进程树（Windows）。
 *
 * 为什么不用 proc.kill()：npx 启动的 MCP 服务实际是
 * `cmd.exe → npx-cli.js → 真正的服务`，proc.kill() 只能杀掉直接子进程，
 * 剩下的孙进程会变成孤儿常驻内存——这正是「node 调用完不释放」的成因。
 *
 * 用 execFile 而不是 spawn：同步语义更可控，且不需要保存子句柄；
 * 失败（进程已退出、pid 不存在）一律吞掉，清理路径不该因为杀不到而抛错。
 */
function killProcessTree(pid: number): void {
  try {
    execFile('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true }, () => {
      // 忽略回调错误：目标可能已经自行退出
    })
  } catch {
    // execFile 同步抛错（如参数非法）时兜底回落到 proc.kill()
  }
}
/** MCP content 块压平成纯文本（图片只留一句话占位，不污染上下文；首张图经 dataUrl 透传展示）。 */
export function flattenContent(content: unknown, isError: unknown): McpCallResult {
  if (!Array.isArray(content)) return { content: '[MCP 返回了空内容]', isError: true }
  const parts: string[] = []
  let image: { mimeType: string; dataUrl: string } | undefined
  for (const block of content) {
    if (typeof block !== 'object' || block === null) continue
    const b = block as Record<string, unknown>
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
    else if (b.type === 'image') {
      parts.push('[MCP 返回了一张图片，见附图]')
      if (!image && typeof b.data === 'string' && typeof b.mimeType === 'string') {
        const data = b.data.trim()
        const mime = b.mimeType.trim().toLowerCase()
        if (data && /^image\/(png|jpe?g|webp|gif|bmp)$/.test(mime) && data.length <= MCP_IMAGE_MAX_DATA_CHARS) {
          image = { mimeType: mime, dataUrl: `data:${mime};base64,${data}` }
        }
      }
    } else if (b.type === 'resource') parts.push('[MCP 返回了一个资源引用，已省略]')
  }
  const text = parts.join('\n').trim()
  if (!text) return { content: '[MCP 返回了空内容]', isError: true }
  return { content: text, isError: isError === true, ...(image ? { image } : {}) }
}
export class McpClient {
  private proc: ChildProcess
  private nextId = 1
  private pending = new Map<number, Pending>()
  private buffer = ''
  private killed = false

  private constructor(proc: ChildProcess) {
    this.proc = proc
  }

  static async start(options: SpawnOptions): Promise<McpClient> {
    const proc = spawn(options.command, options.args, {
      env: { ...process.env, ...(options.env ?? {}) },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      shell: needsShell(options.command)
    })
    const client = new McpClient(proc)
    proc.stdout?.on('data', (chunk: Buffer) => client.onData(chunk.toString('utf8')))
    proc.stderr?.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8').trim()
      if (text) log.info(`[mcp] <${options.command}> ${text.slice(0, 500)}`)
    })
    proc.on('exit', (code) => {
      client.killed = true
      for (const [, p] of client.pending) {
        clearTimeout(p.timer)
        p.reject(new Error(`MCP 服务进程已退出（码 ${code ?? '未知'}）`))
      }
      client.pending.clear()
    })

    await new Promise<void>((resolve, reject) => {
      proc.on('error', reject)
      proc.on('spawn', () => {
        proc.removeListener('error', reject)
        resolve()
      })
    })

    try {
      await client.request(
        'initialize',
        {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'shangbo-agent', version: '0.1.0' }
        },
        HANDSHAKE_TIMEOUT_MS
      )
      client.notify('notifications/initialized', {})
    } catch (error) {
      await client.stop()
      throw error
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
    const params = { name, arguments: (args ?? {}) as Record<string, unknown> }
    const res = await this.request('tools/call', params, CALL_TIMEOUT_MS, signal)
    return flattenContent(res.content, res.isError)
  }

  async stop(): Promise<void> {
    this.killed = true
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new Error('MCP 客户端已关闭'))
    }
    this.pending.clear()
    const proc = this.proc
    if (proc.exitCode === null) {
      // Windows 上 proc.kill() 只杀直接子进程。npx 启动的 MCP 是
      // `cmd.exe → npx-cli.js → 真正的服务` 三层结构，只杀第一层会让后两层
      // 变成孤儿常驻内存。因此 Windows 一律用 taskkill /T 杀整棵进程树。
      if (process.platform === 'win32' && proc.pid) {
        killProcessTree(proc.pid)
      } else {
        proc.kill()
      }
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 3000)
        proc.once('exit', () => {
          clearTimeout(timer)
          resolve()
        })
      })
      if (proc.exitCode === null) {
        if (process.platform === 'win32' && proc.pid) killProcessTree(proc.pid)
        else proc.kill('SIGKILL')
      }
    }
  }
  /**
   * 同步终止：只给 `before-quit` 这类不能 await 的收尾路径用。
   * 不等待 exit 事件，杀完立即返回；进程可能稍后才真正消失。
   */
  stopSync(): void {
    this.killed = true
    for (const [, p] of this.pending) {
      clearTimeout(p.timer)
      p.reject(new Error('MCP 客户端已关闭'))
    }
    this.pending.clear()
    const proc = this.proc
    if (proc.exitCode !== null || !proc.pid) return
    if (process.platform === 'win32') killProcessTree(proc.pid)
    else proc.kill('SIGKILL')
  }

  private send(payload: Record<string, unknown>): void {
    if (this.killed) throw new Error('MCP 服务进程已退出')
    this.proc.stdin?.write(`${JSON.stringify(payload)}\n`)
  }

  private notify(method: string, params: Record<string, unknown>): void {
    this.send({ jsonrpc: '2.0', method, params })
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal
  ): Promise<Record<string, unknown>> {
    const id = this.nextId++
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      if (signal?.aborted) {
        reject(new Error('请求已被取消'))
        return
      }
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`MCP 请求超时：${method}（${timeoutMs}ms）`))
      }, timeoutMs)
      const onAbort = (): void => {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(new Error('请求已被取消'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      this.pending.set(id, {
        resolve: (value) => {
          signal?.removeEventListener('abort', onAbort)
          resolve(value)
        },
        reject: (error) => {
          signal?.removeEventListener('abort', onAbort)
          reject(error)
        },
        timer
      })
      try {
        this.send({ jsonrpc: '2.0', id, method, params })
      } catch (error) {
        this.pending.delete(id)
        clearTimeout(timer)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  private onData(chunk: string): void {
    this.buffer += chunk
    let index: number
    while ((index = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, index).trim()
      this.buffer = this.buffer.slice(index + 1)
      if (!line) continue
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(line) as Record<string, unknown>
      } catch {
        continue
      }
      this.onMessage(msg)
    }
  }

  private onMessage(msg: Record<string, unknown>): void {
    // 服务端 → 客户端的响应
    if ((typeof msg.id === 'number' || typeof msg.id === 'string') && ('result' in msg || 'error' in msg)) {
      const pending = this.pending.get(msg.id as number)
      if (!pending) return
      this.pending.delete(msg.id as number)
      clearTimeout(pending.timer)
      if ('error' in msg && msg.error !== null && msg.error !== undefined) {
        const err = msg.error as Record<string, unknown>
        pending.reject(new Error(typeof err.message === 'string' ? err.message : JSON.stringify(err)))
      } else {
        pending.resolve((msg.result ?? {}) as Record<string, unknown>)
      }
      return
    }
    // 服务端 → 客户端的请求：我们实现不了，直接回绝，避免对方 hang 住。
    if (msg.id !== undefined && typeof msg.method === 'string') {
      this.send({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'Method not found' } })
    }
    // 通知（无 id）直接丢弃。
  }
}
