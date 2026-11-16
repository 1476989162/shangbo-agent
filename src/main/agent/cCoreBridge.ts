import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import log from 'electron-log/main'
import type { AutonomyLevel, CCoreEngineStatus } from '../../shared/types'
import type { SafetyCategory, SafetyContext, SafetyTier, SafetyVerdict } from './safety'
import type { InjectionFinding, InjectionLevel } from './injectionDetector'
import type { ToolRecord } from './loopGuard'

export type { CCoreEngineStatus }

export class CCoreCancelledError extends Error {
  public constructor(action: string, reason: 'cancelled' | 'timeout') {
    super(`C-Core RPC call ${reason} (${action})`)
    this.name = 'CCoreCancelledError'
  }
}

interface PendingRpc {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
  startTime: number
  cleanup?: () => void
}

const DEFAULT_TIMEOUT_MS = 15_000

export class CCoreBridge {
  private child: ChildProcessWithoutNullStreams | null = null
  private stdoutBuffer = ''
  private sequence = 0
  private pending = new Map<number, PendingRpc>()
  private cachedExePath: string | null = null
  private totalCalls = 0
  private successCalls = 0
  private failedCalls = 0
  private totalLatencyMs = 0

  public resolveExecutablePath(): string | null {
    if (this.cachedExePath && existsSync(this.cachedExePath)) {
      return this.cachedExePath
    }

    if (process.env.SHANGBO_CCORE_PATH && existsSync(process.env.SHANGBO_CCORE_PATH)) {
      this.cachedExePath = process.env.SHANGBO_CCORE_PATH
      return this.cachedExePath
    }

    const exeName = process.platform === 'win32' ? 'shangbo_agent.exe' : 'shangbo_agent'

    // 1. Packaged Electron application: resources/c-core/bin/shangbo_agent.exe
    if (process.resourcesPath) {
      const packaged = join(process.resourcesPath, 'c-core', 'bin', exeName)
      if (existsSync(packaged)) {
        this.cachedExePath = packaged
        return packaged
      }
    }

    // 2. Electron app path
    try {
      // Dynamic import / require guard for electron app
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { app } = require('electron')
      if (app && typeof app.getAppPath === 'function') {
        const appCandidate = join(app.getAppPath(), 'c-core', 'bin', exeName)
        if (existsSync(appCandidate)) {
          this.cachedExePath = appCandidate
          return appCandidate
        }
      }
    } catch {
      // Not running in Electron process
    }

    // 3. Project working directory
    const cwdCandidate = join(process.cwd(), 'c-core', 'bin', exeName)
    if (existsSync(cwdCandidate)) {
      this.cachedExePath = cwdCandidate
      return cwdCandidate
    }

    // 4. Relative to current file (__dirname)
    const relCandidate = resolve(__dirname, '../../../c-core/bin', exeName)
    if (existsSync(relCandidate)) {
      this.cachedExePath = relCandidate
      return relCandidate
    }

    return null
  }

  public isAvailable(): boolean {
    return this.resolveExecutablePath() !== null
  }

  public isDaemonRunning(): boolean {
    return this.child !== null && !this.child.killed
  }

  public getStatus(): CCoreEngineStatus {
    const exe = this.resolveExecutablePath()
    return {
      available: exe !== null,
      daemonRunning: this.isDaemonRunning(),
      executablePath: exe,
      version: '0.9.4',
      engine: 'C-Core Native Engine (Shangbo Architecture)',
      metrics: {
        totalCalls: this.totalCalls,
        successCalls: this.successCalls,
        failedCalls: this.failedCalls,
        averageLatencyMs:
          this.successCalls > 0 ? Math.round(this.totalLatencyMs / this.successCalls) : 0
      }
    }
  }

  private resolveUserDataDir(): string {
    if (process.env.SHANGBO_USER_DATA) {
      return process.env.SHANGBO_USER_DATA
    }
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { app } = require('electron')
      if (app && typeof app.getPath === 'function') {
        return app.getPath('userData') || ''
      }
    } catch {
      // Not running in Electron process
    }
    return ''
  }

  public ensureDaemon(): boolean {
    if (this.isDaemonRunning()) return true
    const exe = this.resolveExecutablePath()
    if (!exe) return false

    this.stdoutBuffer = ''
    try {
      const userDataDir = this.resolveUserDataDir()
      this.child = spawn(exe, ['rpc'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: userDataDir ? { ...process.env, SHANGBO_USER_DATA: userDataDir } : process.env
      })

      this.child.stdout.setEncoding('utf8')
      this.child.stdout.on('data', (chunk: string) => this.onStdoutChunk(chunk))

      this.child.stderr.setEncoding('utf8')
      this.child.stderr.on('data', (chunk: string) => {
        log.warn(`[c-core daemon stderr] ${chunk.trim()}`)
      })

      this.child.on('exit', (code) => {
        log.info(`[c-core daemon] exited with code ${code}`)
        this.failAllPending(new Error(`C-Core daemon exited (code ${code})`))
        this.child = null
      })

      this.child.on('error', (err) => {
        log.error('[c-core daemon] process error:', err)
        this.failAllPending(err instanceof Error ? err : new Error(String(err)))
        this.child = null
      })

      return true
    } catch (err) {
      log.error('[c-core daemon] failed to start daemon:', err)
      this.child = null
      return false
    }
  }

  public stopDaemon(): void {
    this.stdoutBuffer = ''
    if (this.child) {
      try {
        this.child.stdin.write('exit\n')
        this.child.kill()
      } catch {
        // ignore
      }
      this.child = null
    }
    this.failAllPending(new Error('C-Core daemon stopped'))
  }

  private failAllPending(err: Error): void {
    for (const [id, req] of this.pending.entries()) {
      clearTimeout(req.timer)
      req.cleanup?.()
      this.failedCalls++
      req.reject(err)
      this.pending.delete(id)
    }
  }

  private onStdoutChunk(chunk: string): void {
    this.stdoutBuffer += chunk
    let newlineIdx: number
    while ((newlineIdx = this.stdoutBuffer.indexOf('\n')) !== -1) {
      const line = this.stdoutBuffer.slice(0, newlineIdx).trim()
      this.stdoutBuffer = this.stdoutBuffer.slice(newlineIdx + 1)
      if (line) {
        this.processRpcLine(line)
      }
    }
  }

  private processRpcLine(line: string): void {
    try {
      const parsed = JSON.parse(line) as { id?: number; success?: boolean; error?: string }
      if (typeof parsed.id === 'number') {
        const req = this.pending.get(parsed.id)
        if (req) {
          clearTimeout(req.timer)
          req.cleanup?.()
          const latency = Date.now() - req.startTime
          this.totalLatencyMs += latency
          this.pending.delete(parsed.id)
          if (parsed.success) {
            this.successCalls++
            req.resolve(parsed)
          } else {
            this.failedCalls++
            req.reject(new Error(parsed.error ?? 'C-Core RPC returned failure'))
          }
        }
      }
    } catch (err) {
      log.warn('[c-core daemon] failed to parse response line:', line, err)
    }
  }

  public callRpc<T = unknown>(
    action: string,
    params: Record<string, unknown> = {},
    timeoutMs = DEFAULT_TIMEOUT_MS,
    signal?: AbortSignal
  ): Promise<T> {
    this.totalCalls++
    if (signal?.aborted) {
      this.failedCalls++
      return Promise.reject(new Error(`C-Core RPC call cancelled (${action})`))
    }
    if (!this.ensureDaemon() || !this.child?.stdin.writable) {
      this.failedCalls++
      return Promise.reject(new Error('C-Core engine daemon is unavailable'))
    }

    const id = ++this.sequence
    const payload = JSON.stringify({ id, action, ...params }) + '\n'

    return new Promise<T>((resolve, reject) => {
      const startTime = Date.now()
      let settled = false
      const cancel = (reason: 'cancelled' | 'timeout') => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.pending.delete(id)
        this.failedCalls++
        signal?.removeEventListener('abort', onAbort)
        // Only native tool execution can own a cancellable worker. Read-only RPC
        // timeouts must not generate a second "cancel" result with the same id.
        if (action === 'run_tool') {
          try {
            if (this.child?.stdin.writable) {
              this.child.stdin.write(JSON.stringify({ id, action: 'cancel', cancel_id: id }) + '\n')
            }
          } catch { /* the running worker will still honor its native timeout */ }
        }
        reject(new CCoreCancelledError(action, reason))
      }
      const onAbort = () => cancel('cancelled')
      if (signal?.aborted) {
        cancel('cancelled')
        return
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      const timer = setTimeout(() => cancel('timeout'), timeoutMs)

      this.pending.set(id, {
        resolve: resolve as (val: unknown) => void,
        reject,
        timer,
        startTime,
        cleanup: () => {
          settled = true
          signal?.removeEventListener('abort', onAbort)
        }
      })

      try {
        this.child!.stdin.write(payload)
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(id)
        this.failedCalls++
        reject(err instanceof Error ? err : new Error(String(err)))
      }
    })
  }

  /* High-Level asynchronous APIs: all core rule checks use the resident C
   * process first; TypeScript is a failure fallback, never a synchronous CLI. */

  /**
   * Audit command against hard lines (asynchronous via C-Core daemon).
   */
  public async auditHardLines(command: string): Promise<SafetyVerdict | null> {
    if (!command.trim()) return null
    try {
      interface AuditResponse {
        hit: boolean
        tier: SafetyTier
        category: SafetyCategory
        reason: string
        autoApprovable: boolean
      }
      const res = await this.callRpc<AuditResponse>('audit_hard_lines', { command })
      if (!res.hit) return null
      return {
        tier: res.tier,
        category: res.category,
        reason: res.reason,
        autoApprovable: res.autoApprovable
      }
    } catch (error) {
      log.warn('[c-core bridge] auditHardLines RPC failed; using TypeScript rules', error)
      const { auditHardLines } = await import('./safety')
      return auditHardLines(command)
    }
  }

  /**
   * Classify tool call via C-Core (asynchronous).
   */
  public async classifyToolCall(
    toolName: string,
    input: unknown,
    ctx: SafetyContext
  ): Promise<SafetyVerdict | null> {
    const record = (input ?? {}) as Record<string, unknown>
    const baseWorkspace = ctx.workingDirectory ?? '.'
    const rawCwd = typeof record.cwd === 'string' && record.cwd.trim() ? record.cwd.trim() : ''
    const effectiveWorkspace = rawCwd
      ? isAbsolute(rawCwd)
        ? rawCwd
        : resolve(baseWorkspace, rawCwd)
      : baseWorkspace
    const path = typeof record.path === 'string' ? record.path : (rawCwd ? effectiveWorkspace : '')
    const command = typeof record.command === 'string' ? record.command : ''
    const userDataDir = this.resolveUserDataDir()

    try {
      interface ClassifyResponse {
        tier: SafetyTier
        category: SafetyCategory
        reason: string
        autoApprovable: boolean
      }
      const res = await this.callRpc<ClassifyResponse>('classify_tool_call', {
        tool: toolName,
        path,
        command,
        autonomy: ctx.autonomy,
        workspace: effectiveWorkspace,
        ...(userDataDir ? { user_data_dir: userDataDir } : {})
      })
      return {
        tier: res.tier,
        category: res.category,
        reason: res.reason,
        autoApprovable: res.autoApprovable
      }
    } catch (error) {
      log.warn('[c-core bridge] classifyToolCall RPC failed; using TypeScript rules', error)
      const { classifyToolCall } = await import('./safety')
      return classifyToolCall(toolName, input, ctx)
    }
  }

  /**
   * Check if command is safe for auto approval (asynchronous).
   */
  public async isCommandSafe(command: string, workspace = '.'): Promise<boolean | null> {
    try {
      const userDataDir = this.resolveUserDataDir()
      const res = await this.callRpc<{ safe: boolean }>('is_command_safe', {
        command,
        workspace,
        ...(userDataDir ? { user_data_dir: userDataDir } : {})
      })
      return res.safe
    } catch (error) {
      log.warn('[c-core bridge] isCommandSafe RPC failed; using TypeScript rules', error)
      const { commandStaysInsideWorkspace } = await import('./commandGuard')
      return commandStaysInsideWorkspace(command, workspace)
    }
  }

  /**
   * Scan prompt injection rules (asynchronous).
   */
  public async scanInjectionRules(text: string): Promise<InjectionFinding> {
    if (!text.trim()) return { level: 'none', reason: '空内容。', via: 'rule' }
    try {
      interface InjResponse {
        level: InjectionLevel
        reason: string
        via: 'rule'
      }
      const res = await this.callRpc<InjResponse>('inject_check', { text })
      return { level: res.level, reason: res.reason, via: res.via ?? 'rule' }
    } catch (error) {
      log.warn('[c-core bridge] scanInjectionRules RPC failed; using TypeScript rules', error)
      const { scanInjectionLocalRules } = await import('./injectionDetector')
      return scanInjectionLocalRules(text)
    }
  }

  /**
   * Detect repetitive loop or stuck condition (asynchronous).
   */
  public async detectStuck(history: ToolRecord[], limit = 3): Promise<string | null> {
    if (limit <= 0 || history.length < limit) return null
    try {
      interface StuckResponse {
        stuck: boolean
        reason: string
      }
      const res = await this.callRpc<StuckResponse>('detect_stuck', {
        limit,
        history: history.slice(-limit)
      })
      return res.stuck && res.reason ? res.reason : null
    } catch (error) {
      log.warn('[c-core bridge] detectStuck RPC failed; using TypeScript rules', error)
      const { detectStuckRules } = await import('./loopGuard')
      return detectStuckRules(history, limit)
    }
  }

  /**
   * Stream tag isolator chunk feed (asynchronous via C-Core).
   */
  public async processStreamChunk(
    chunk: string,
    options?: { flush?: boolean; reset?: boolean }
  ): Promise<{ text: string; reasoning: string } | null> {
    try {
      interface StreamResp {
        text: string
        reasoning: string
      }
      return await this.callRpc<StreamResp>('stream_chunk', {
        chunk,
        flush: options?.flush ?? false,
        reset: options?.reset ?? false
      })
    } catch {
      return null
    }
  }

  /**
   * Native C-Core Tool Execution.
   * Dispatches supported tools (read_file, write_file, patch_file, list_directory, search_files, run_command)
   * directly to the native C runtime.
   */
  public async executeTool(
    toolName: string,
    input: unknown,
    context: {
      workingDirectory?: string
      signal?: AbortSignal
      approved?: boolean
      autonomy?: AutonomyLevel
    }
  ): Promise<{ content: string; isError: boolean } | null> {
    // AbortSignal is forwarded through RPC cancellation below; never bypass it by
    // treating an in-flight native tool as complete on the JavaScript side.
    if (
      ![
        'read_file',
        'write_file',
        'patch_file',
        'list_directory',
        'search_files',
        'run_command'
      ].includes(toolName)
    ) {
      return null
    }

    const rec = (input ?? {}) as Record<string, unknown>
    const workspace = context.workingDirectory ?? '.'
    const userDataDir = this.resolveUserDataDir()

    const params: Record<string, unknown> = {
      tool: toolName,
      workspace,
      ...(userDataDir ? { user_data_dir: userDataDir } : {})
    }

    if (toolName === 'read_file') {
      const rawPath = typeof rec.path === 'string' ? rec.path.trim() : ''
      const target = !rawPath ? '' : isAbsolute(rawPath) ? rawPath : resolve(workspace, rawPath)
      params.path = target
      if (typeof rec.startLine === 'number') params.start_line = rec.startLine
      if (typeof rec.endLine === 'number') params.end_line = rec.endLine
      if (typeof rec.offsetBytes === 'number') params.offset_bytes = rec.offsetBytes
      if (typeof rec.maxBytes === 'number') params.max_bytes = rec.maxBytes
    } else if (toolName === 'write_file') {
      const rawPath = typeof rec.path === 'string' ? rec.path.trim() : ''
      const target = !rawPath ? '' : isAbsolute(rawPath) ? rawPath : resolve(workspace, rawPath)
      params.path = target
      params.content = typeof rec.content === 'string' ? rec.content : ''
      params.overwrite = true
    } else if (toolName === 'patch_file') {
      const rawPath = typeof rec.path === 'string' ? rec.path.trim() : ''
      const targetPath = !rawPath ? '' : isAbsolute(rawPath) ? rawPath : resolve(workspace, rawPath)
      params.path = targetPath
      params.target = typeof rec.targetContent === 'string' ? rec.targetContent : ''
      params.replacement = typeof rec.replacementContent === 'string' ? rec.replacementContent : ''
    } else if (toolName === 'list_directory') {
      const rawPath = typeof rec.path === 'string' ? rec.path : '.'
      params.path = isAbsolute(rawPath) ? rawPath : resolve(workspace, rawPath)
      params.max_depth = 2
    } else if (toolName === 'search_files') {
      const rawPath = typeof rec.path === 'string' ? rec.path : '.'
      params.path = isAbsolute(rawPath) ? rawPath : resolve(workspace, rawPath)
      params.filename = typeof rec.filename === 'string' ? rec.filename : ''
      params.content = typeof rec.content === 'string' ? rec.content : ''
      params.max_results = typeof rec.maxResults === 'number' ? rec.maxResults : 50
      params.target =
        typeof rec.content === 'string' && rec.content.trim()
          ? rec.content
          : typeof rec.query === 'string'
            ? rec.query
            : ''
    } else if (toolName === 'run_command') {
      params.command = typeof rec.command === 'string' ? rec.command : ''
      params.timeout_ms = typeof rec.timeoutMs === 'number' ? rec.timeoutMs : 60_000
      const rawCwd = typeof rec.cwd === 'string' && rec.cwd.trim() ? rec.cwd : ''
      params.workspace = rawCwd
        ? isAbsolute(rawCwd)
          ? rawCwd
          : resolve(workspace, rawCwd)
        : workspace
      if (context.approved !== undefined || typeof rec.approved === 'boolean') {
        params.approved = Boolean(context.approved ?? rec.approved)
      }
      if (context.autonomy) {
        params.autonomy = context.autonomy
      }
    }

    try {
      interface ToolResp {
        toolSuccess: boolean
        output: string
        error: string
      }
      const timeoutMs = toolName === 'run_command'
        ? Math.min(305_000, Math.max(5_000, Number(rec.timeoutMs ?? 60_000) + 5_000))
        : 120_000
      const res = await this.callRpc<ToolResp>('run_tool', params, timeoutMs, context.signal)
      if (!res.toolSuccess) {
        const content = res.output
          ? res.error && !res.output.includes(res.error)
            ? `${res.output}\n\n${res.error}`
            : res.output
          : res.error || 'Native tool execution failed'
        return {
          content,
          isError: true
        }
      }
      return {
        content: res.output || (toolName === 'write_file' ? `已写入 ${params.path}` : '（执行成功）'),
        isError: false
      }
    } catch (err) {
      if (err instanceof CCoreCancelledError || context.signal?.aborted) {
        log.info(`[c-core bridge] native tool cancelled on ${toolName}`)
        return { content: '操作已取消，未回退到其他执行器重试。', isError: true }
      }
      log.warn(`[c-core bridge] native tool failed on ${toolName}; not retrying on another executor:`, err)
      return {
        content: `C-Core 执行失败，未回退到其他执行器重试：${err instanceof Error ? err.message : String(err)}`,
        isError: true
      }
    }
  }
}

export const cCoreBridge = new CCoreBridge()

if (typeof process !== 'undefined') {
  process.once('exit', () => {
    cCoreBridge.stopDaemon()
  })
}
