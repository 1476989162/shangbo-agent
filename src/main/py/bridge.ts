import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { app } from 'electron'
import log from 'electron-log/main'

/**
 * Python 边车进程管理器（预留通道）。
 *
 * 当前主流程完全由 TypeScript 承担，这里只把通道打通并验证连通性。
 * 将来需要复杂文档解析、本地向量化或本地模型推理时，只需在 python/sidecar.py
 * 中新增 method，主进程侧直接 bridge.call('新方法', {...}) 即可，
 * 无需改动协议、也无需把 Python 逻辑塞进主进程。
 */

interface PendingCall {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

const DEFAULT_TIMEOUT_MS = 30_000

export class PythonBridge {
  private child: ChildProcessWithoutNullStreams | null = null
  private stdoutBuffer = ''
  private sequence = 0
  private pending = new Map<number, PendingCall>()

  private scriptPath(): string {
    return app.isPackaged
      ? join(process.resourcesPath, 'python', 'sidecar.py')
      : join(app.getAppPath(), 'python', 'sidecar.py')
  }

  private executable(): string {
    if (process.env.SHANGBO_PYTHON) return process.env.SHANGBO_PYTHON
    return process.platform === 'win32' ? 'python' : 'python3'
  }

  isRunning(): boolean {
    return this.child !== null && !this.child.killed
  }

  start(): boolean {
    if (this.isRunning()) return true

    const script = this.scriptPath()
    if (!existsSync(script)) {
      log.warn(`[python] 找不到边车脚本：${script}`)
      return false
    }

    try {
      this.child = spawn(this.executable(), ['-u', script], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      })
    } catch (error) {
      log.warn('[python] 边车启动失败', error)
      return false
    }

    this.child.stdout.setEncoding('utf8')
    this.child.stdout.on('data', (chunk: string) => this.consume(chunk))

    this.child.stderr.setEncoding('utf8')
    this.child.stderr.on('data', (chunk: string) => {
      log.warn(`[python] ${chunk.trim()}`)
    })

    this.child.on('exit', (code) => {
      log.info(`[python] 边车已退出，code=${code}`)
      this.failAllPending(new Error('Python 边车进程已退出'))
      this.child = null
    })

    this.child.on('error', (error) => {
      log.warn('[python] 边车进程错误', error)
      this.failAllPending(error instanceof Error ? error : new Error(String(error)))
      this.child = null
    })

    return true
  }

  call<T = unknown>(method: string, params: Record<string, unknown> = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<T> {
    if (!this.start() || !this.child?.stdin.writable) {
      return Promise.reject(new Error('Python 边车不可用，请确认本机已安装 Python 并加入 PATH'))
    }

    const id = ++this.sequence
    const payload = JSON.stringify({ id, method, params })

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Python 边车调用超时：${method}`))
      }, timeoutMs)

      this.pending.set(id, {
        resolve: (value) => resolve(value as T),
        reject,
        timer
      })

      this.child!.stdin.write(`${payload}\n`, 'utf8', (error) => {
        if (error) {
          clearTimeout(timer)
          this.pending.delete(id)
          reject(error)
        }
      })
    })
  }

  /** 连通性自检，供「设置 → 系统信息」展示。 */
  async ping(): Promise<{ ok: boolean; message: string }> {
    try {
      const result = await this.call<{ python: string }>('ping', {}, 8_000)
      return { ok: true, message: `Python ${result.python} 通道正常` }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) }
    }
  }

  dispose(): void {
    this.failAllPending(new Error('应用正在退出'))
    this.child?.kill()
    this.child = null
  }

  private consume(chunk: string): void {
    this.stdoutBuffer += chunk.replace(/\r\n/g, '\n')

    let boundary = this.stdoutBuffer.indexOf('\n')
    while (boundary !== -1) {
      const line = this.stdoutBuffer.slice(0, boundary).trim()
      this.stdoutBuffer = this.stdoutBuffer.slice(boundary + 1)
      if (line) this.dispatch(line)
      boundary = this.stdoutBuffer.indexOf('\n')
    }
  }

  private dispatch(line: string): void {
    let message: { id?: number; result?: unknown; error?: string }
    try {
      message = JSON.parse(line)
    } catch {
      log.warn(`[python] 无法解析边车输出：${line.slice(0, 200)}`)
      return
    }

    if (typeof message.id !== 'number') return
    const pending = this.pending.get(message.id)
    if (!pending) return

    this.pending.delete(message.id)
    clearTimeout(pending.timer)

    if (message.error) pending.reject(new Error(message.error))
    else pending.resolve(message.result)
  }

  private failAllPending(error: Error): void {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    this.pending.clear()
  }
}

export const pythonBridge = new PythonBridge()