import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { existsSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import log from 'electron-log/main'
import type { AutonomyLevel, CCoreEngineStatus } from '../../shared/types'
import type { SafetyCategory, SafetyContext, SafetyTier, SafetyVerdict } from './safety'
import type { InjectionFinding, InjectionLevel } from './injectionDetector'
import type { ToolRecord } from './loopGuard'

export type { CCoreEngineStatus }

interface PendingRpc {
  resolve: (value: unknown) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
  startTime: number
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
  private syncCache = new Map<string, { val: unknown; expires: number }>()

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

  public ensureDaemon(): boolean {
    if (this.isDaemonRunning()) return true
    const exe = this.resolveExecutablePath()
    if (!exe) return false

    this.stdoutBuffer = ''
    try {
      this.child = spawn(exe, ['rpc'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
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
    timeoutMs = DEFAULT_TIMEOUT_MS
  ): Promise<T> {
    this.totalCalls++
    if (!this.ensureDaemon() || !this.child?.stdin.writable) {
      this.failedCalls++
      return Promise.reject(new Error('C-Core engine daemon is unavailable'))
    }

    const id = ++this.sequence
    const payload = JSON.stringify({ id, action, ...params }) + '\n'

    return new Promise<T>((resolve, reject) => {
      const startTime = Date.now()
      const timer = setTimeout(() => {
        this.pending.delete(id)
        this.failedCalls++
        reject(new Error(`C-Core RPC call timeout (${action})`))
      }, timeoutMs)

      this.pending.set(id, {
        resolve: resolve as (val: unknown) => void,
        reject,
        timer,
        startTime
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

  /**
   * Fast synchronous CLI execution helper for pure synchronous call sites.
   */
  private static readonly MAX_CACHE_ENTRIES = 500

  public callCliSync<T = unknown>(subcommand: string, args: string[]): T | null {
    const exe = this.resolveExecutablePath()
    if (!exe) return null

    const cacheKey = `${subcommand}:${args.join(';;')}`
    const cached = this.syncCache.get(cacheKey)
    if (cached && cached.expires > Date.now()) {
      return cached.val as T
    }

    const startTime = Date.now()
    try {
      this.totalCalls++
      const stdout = execFileSync(exe, ['--json', subcommand, ...args], {
        encoding: 'utf-8',
        windowsHide: true,
        timeout: 5000
      })
      const latency = Date.now() - startTime
      this.totalLatencyMs += latency
      const parsed = JSON.parse(stdout.trim()) as T
      this.successCalls++

      if (this.syncCache.size >= CCoreBridge.MAX_CACHE_ENTRIES) {
        const now = Date.now()
        for (const [k, v] of this.syncCache.entries()) {
          if (v.expires <= now) {
            this.syncCache.delete(k)
          }
        }
        if (this.syncCache.size >= CCoreBridge.MAX_CACHE_ENTRIES) {
          const iter = this.syncCache.keys()
          for (let i = 0; i < 50; i++) {
            const next = iter.next()
            if (next.done) break
            this.syncCache.delete(next.value)
          }
        }
      }

      this.syncCache.set(cacheKey, { val: parsed, expires: Date.now() + 10_000 })
      return parsed
    } catch (err) {
      this.failedCalls++
      log.warn(`[c-core cli] sync call failed (${subcommand}):`, err)
      return null
    }
  }

  /* ------------------------------------------------------------- */
  /* High-Level Typed APIs Delegating to C-Core                     */
  /* ------------------------------------------------------------- */

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
    } catch {
      return this.auditHardLinesSync(command)
    }
  }

  /**
   * Audit command against hard lines (synchronous fallback).
   */
  public auditHardLinesSync(command: string): SafetyVerdict | null {
    if (!command.trim()) return null
    const res = this.callCliSync<{
      hit: boolean
      tier: SafetyTier
      category: SafetyCategory
      reason: string
      autoApprovable: boolean
    }>('audit', [command])

    if (!res || !res.hit) return null
    return {
      tier: res.tier,
      category: res.category,
      reason: res.reason,
      autoApprovable: res.autoApprovable
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
    const path = typeof record.path === 'string' ? record.path : ''
    const command = typeof record.command === 'string' ? record.command : ''

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
        workspace: ctx.workingDirectory ?? '.'
      })
      return {
        tier: res.tier,
        category: res.category,
        reason: res.reason,
        autoApprovable: res.autoApprovable
      }
    } catch {
      return this.classifyToolCallSync(toolName, input, ctx)
    }
  }

  /**
   * Classify tool call via C-Core (synchronous).
   */
  public classifyToolCallSync(
    toolName: string,
    input: unknown,
    ctx: SafetyContext
  ): SafetyVerdict | null {
    const record = (input ?? {}) as Record<string, unknown>
    const path = typeof record.path === 'string' ? record.path : ''
    const command = typeof record.command === 'string' ? record.command : ''

    const res = this.callCliSync<{
      tier: SafetyTier
      category: SafetyCategory
      reason: string
      autoApprovable: boolean
    }>('classify-tool', [
      toolName,
      path,
      command,
      ctx.autonomy ?? 'balanced',
      ctx.workingDirectory ?? '.'
    ])

    if (!res) return null
    return {
      tier: res.tier,
      category: res.category,
      reason: res.reason,
      autoApprovable: res.autoApprovable
    }
  }

  /**
   * Check if command is safe for auto approval (asynchronous).
   */
  public async isCommandSafe(command: string, workspace = '.'): Promise<boolean | null> {
    try {
      const res = await this.callRpc<{ safe: boolean }>('is_command_safe', { command, workspace })
      return res.safe
    } catch {
      return this.isCommandSafeSync(command, workspace)
    }
  }

  /**
   * Check if command is safe for auto approval (synchronous).
   */
  public isCommandSafeSync(command: string, workspace = '.'): boolean | null {
    const res = this.callCliSync<{ safe: boolean }>('is-safe', [command, workspace])
    return res ? res.safe : null
  }

  /**
   * Scan prompt injection rules (asynchronous).
   */
  public async scanInjectionRules(text: string): Promise<InjectionFinding | null> {
    if (!text.trim()) return null
    try {
      interface InjResponse {
        level: InjectionLevel
        reason: string
        via: 'rule'
      }
      const res = await this.callRpc<InjResponse>('inject_check', { text })
      return { level: res.level, reason: res.reason, via: res.via ?? 'rule' }
    } catch {
      return this.scanInjectionRulesSync(text)
    }
  }

  /**
   * Scan prompt injection rules (synchronous).
   */
  public scanInjectionRulesSync(text: string): InjectionFinding | null {
    if (!text.trim()) return null
    const res = this.callCliSync<{
      level: InjectionLevel
      reason: string
      via: 'rule'
    }>('inject-check', [text])

    if (!res) return null
    return { level: res.level, reason: res.reason, via: res.via ?? 'rule' }
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
    } catch {
      return this.detectStuckSync(history, limit)
    }
  }

  /**
   * Detect repetitive loop or stuck condition (synchronous).
   */
  public detectStuckSync(history: ToolRecord[], limit = 3): string | null {
    if (limit <= 0 || history.length < limit) return null
    try {
      const res = this.callCliSync<{ stuck: boolean; reason: string }>('detect-stuck', [
        String(limit),
        JSON.stringify(history.slice(-limit))
      ])
      if (res && res.stuck && res.reason) {
        return res.reason
      }
      if (res && !res.stuck) {
        return null
      }
    } catch {
      // Fallback to TS
    }

    const recent = history.slice(-limit)
    if (recent.every((r) => r.isError)) {
      return `工具已连续失败 ${limit} 次（${recent[recent.length - 1].sig}），先停下来请人看一眼，不要继续烧 Token。`
    }
    const first = recent[0].sig
    if (recent.every((r) => r.sig === first)) {
      return `同一个工具调用已重复 ${limit} 次（${first}），疑似原地打转，先停下来。`
    }
    return null
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
    context: { workingDirectory?: string; signal?: AbortSignal }
  ): Promise<{ content: string; isError: boolean } | null> {
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

    const params: Record<string, unknown> = {
      tool: toolName,
      workspace
    }

    if (toolName === 'read_file') {
      const rawPath = typeof rec.path === 'string' ? rec.path : ''
      const target = isAbsolute(rawPath) ? rawPath : resolve(workspace, rawPath)
      params.path = target
      if (typeof rec.startLine === 'number') params.start_line = rec.startLine
      if (typeof rec.endLine === 'number') params.end_line = rec.endLine
    } else if (toolName === 'write_file') {
      const rawPath = typeof rec.path === 'string' ? rec.path : ''
      const target = isAbsolute(rawPath) ? rawPath : resolve(workspace, rawPath)
      params.path = target
      params.content = typeof rec.content === 'string' ? rec.content : ''
      params.overwrite = true
    } else if (toolName === 'patch_file') {
      const rawPath = typeof rec.path === 'string' ? rec.path : ''
      const targetPath = isAbsolute(rawPath) ? rawPath : resolve(workspace, rawPath)
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
      params.target =
        typeof rec.content === 'string' && rec.content.trim()
          ? rec.content
          : typeof rec.filename === 'string' && rec.filename.trim()
            ? rec.filename
            : typeof rec.query === 'string'
              ? rec.query
              : ''
    } else if (toolName === 'run_command') {
      params.command = typeof rec.command === 'string' ? rec.command : ''
      const rawCwd = typeof rec.cwd === 'string' && rec.cwd.trim() ? rec.cwd : ''
      params.workspace = rawCwd
        ? isAbsolute(rawCwd)
          ? rawCwd
          : resolve(workspace, rawCwd)
        : workspace
    }

    try {
      interface ToolResp {
        toolSuccess: boolean
        output: string
        error: string
      }
      const res = await this.callRpc<ToolResp>('run_tool', params)
      if (!res.toolSuccess) {
        return {
          content: res.error || 'Native tool execution failed',
          isError: true
        }
      }
      return {
        content: res.output || (toolName === 'write_file' ? `已写入 ${params.path}` : '（执行成功）'),
        isError: false
      }
    } catch (err) {
      log.warn(`[c-core bridge] executeTool fallback on ${toolName}:`, err)
      return null
    }
  }
}

export const cCoreBridge = new CCoreBridge()

if (typeof process !== 'undefined') {
  process.once('exit', () => {
    cCoreBridge.stopDaemon()
  })
}
