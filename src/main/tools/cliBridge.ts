import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import {
  describeError,
  guardPrivatePath,
  resolveUserPath,
  truncate,
  type ToolDefinition
} from './core';

const CLI_NAMES = ['codex', 'claude', 'qoder', 'opencode'] as const
type CliName = (typeof CLI_NAMES)[number]

export interface ResolvedCli {
  /** 直接 execFile 的可执行体（node.exe 或真实 .exe） */
  file: string
  /** 真实 .exe 时不空：作为 argv[0] 前置的入口脚本 */
  entryArg: string | null
}

function nodeExeCandidates(npmDir: string): string[] {
  // 跨平台：Windows 找 node.exe，POSIX 找 node；npmDir 同目录优先
  const out = [join(npmDir, 'node.exe'), join(npmDir, 'node')]
  if (process.env.PATH) {
    const sep = process.platform === 'win32' ? ';' : ':'
    for (const dir of process.env.PATH.split(sep)) {
      const trimmed = dir.trim()
      if (trimmed) out.push(join(trimmed, 'node.exe'), join(trimmed, 'node'))
    }
  }
  return out
}

/** 从 .cmd shim 内容解析真实启动体（供测试与启动器复用）。
 *  - 真实 .exe（如 claude / opencode 的 npm shim）：直接返回 { file: exePath, entryArg: null }；
 *  - node 入口脚本（.js / .cjs / .mjs，如 codex / qoder dispatcher）：返回 { file: nodeExe, entryArg: entryPath }；
 *  - 找不到入口或 node 时返回 null，调用方走裸名兜底。
 *  路径统一按正斜杠归一后再 resolve，Windows / Linux 行为一致。 */
export function parseCmdShim(shimPath: string, npmDir: string): ResolvedCli | null {
  let text: string
  try {
    text = readFileSync(shimPath, 'utf8')
  } catch {
    return null
  }
  // npm shim 模板："%dp0%\node_modules\...\bin\entry.(exe|js|cjs|mjs)"
  const m = text.match(/node_modules[^"\r\n]+?\.(exe|js|cjs|mjs)/i)
  if (!m) return null
  const relEntry = m[0].replace(/\\/g, '/')
  const entryPath = resolve(npmDir, relEntry)
  if (!existsSync(entryPath)) return null
  if (m[1].toLowerCase() === 'exe') {
    return { file: entryPath, entryArg: null }
  }
  // 优先 shim 同目录 node，其次 PATH 中的 node
  for (const node of nodeExeCandidates(npmDir)) {
    if (existsSync(node)) return { file: node, entryArg: entryPath }
  }
  return null
}

export function resolveCliNoShell(name: CliName): ResolvedCli {
  if (process.platform !== 'win32') return { file: name, entryArg: null }
  const npmDir = process.env.APPDATA ? `${process.env.APPDATA}\\npm` : null
  if (npmDir) {
    // ① npm shim：解析出 node.exe + 入口 .js
    const shim = `${npmDir}\\${name}.cmd`
    if (existsSync(shim)) {
      const parsed = parseCmdShim(shim, npmDir)
      if (parsed) return parsed
    }
    // ② 真实 .exe（qoder 等独立安装位）
    if (name === 'qoder') {
      const qoderExe = 'C:\\Program Files\\Qoder IDE\\bin\\qoder.exe'
      if (existsSync(qoderExe)) return { file: qoderExe, entryArg: null }
    }
  }
  // ③ 兜底：系统 node（PATH 已含）直接当可执行体，名字当 argv 交给 OS PATH 解析；
  //    仍无 shell——找不到时如实报 ENOENT，不再借 cmd.exe 兜底
  return { file: name, entryArg: null }
}

interface CliExecOptions {
  cwd?: string | undefined
  timeout?: number
  maxBuffer?: number
  signal?: AbortSignal
  windowsHide?: boolean
}

/** execFile 的 CLI 专用包装：无 shell 直调真实启动体，prompt 永远只是 argv 元素。 */
export async function execCliFileAsync(name: CliName, args: string[], options: CliExecOptions) {
  const { execFile } = await import('node:child_process')
  const { promisify } = await import('node:util')
  const execFileAsync = promisify(execFile)
  const cli = resolveCliNoShell(name)
  const finalArgs = cli.entryArg ? [cli.entryArg, ...args] : args
  // shell: false 是默认值，这里显式声明以固化契约：任何路径都不借 shell
  return execFileAsync(cli.file, finalArgs, { ...options, shell: false })
}

/**
 * Qoder CLI 桥接（外部 Agent 调用 Qoder 干活的唯一正统通道）。
 * 已验证：npm i -g @qoder-ai/qodercli → qoder login → qoder -p/-o json 可用。
 * MCP 方向只能反向（Qoder 调尚搏），调不动 Qoder；9209 本地口路径全 404 不啃；
 * qoder-cn:// 协议只能唤起不能派活。走 CLI 非交互最稳。
 * 安全：prompt 经 argv 传，不拼 shell；cwd 强制走 resolveUserPath + 私有目录防护。
 */
async function runQoderCli(args: string[], cwd: string | undefined, signal: AbortSignal): Promise<string> {
  try {
    const { stdout, stderr } = await execCliFileAsync('qoder', args, {
      cwd,
      timeout: 300_000,
      maxBuffer: 8 * 1024 * 1024,
      signal,
      windowsHide: true
    })
    const out = `${stdout.trim()}${stderr.trim() ? `\n--- 标准错误 ---\n${stderr.trim()}` : ''}`
    return truncate(out.trim() || '（Qoder 无输出）')
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; code?: number; message?: string }
    const parts = ['--- Qoder 调用失败 ---']
    if (failure.stdout?.trim()) parts.push(failure.stdout.trim())
    if (failure.stderr?.trim()) parts.push(failure.stderr.trim())
    if (parts.length === 1) parts.push(failure.message ?? String(error))
    return truncate(parts.join('\n'))
  }
}

export const qoderAsk: ToolDefinition = {
  name: 'qoder_ask',
  description:
    '调用本机 Qoder CLI（qoder -p）让 Qoder 干活并回结果。适合代码问答、解释、改写建议等一次问答；要在指定工程目录下问就传 cwd。需要本机已装 CLI 且已 login。',
  parameters: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: '要发给 Qoder 的问题/任务' },
      cwd: { type: 'string', description: '工作目录，缺省为当前项目目录' },
      model: { type: 'string', description: '模型名，缺省用 Qoder 默认' }
    },
    required: ['prompt']
  },
  requiresApproval: true,
  approvalReason: '将调用本机 Qoder CLI 并消耗你的 Qoder 额度，结果会回传给尚搏。',
  async execute(input, context) {
    const { prompt, cwd, model } = z
      .object({
        prompt: z.string().min(1).max(8000),
        cwd: z.string().optional(),
        model: z.string().optional()
      })
      .parse(input)
    const dir = cwd ? resolveUserPath(context, cwd) : (context.workingDirectory ?? undefined)
    if (dir) guardPrivatePath(dir)
    const args = ['-p', prompt]
    if (model) args.push('-m', model)
    return runQoderCli(args, dir, context.signal)
  }
}

export const qoderStatus: ToolDefinition = {
  name: 'qoder_status',
  description: '查看本机 Qoder CLI 的版本与登录状态（qoder status）。不消耗额度，接线前先查这个。',
  parameters: { type: 'object', properties: {}, required: [] },
  requiresApproval: false,
  async execute(_input, context) {
    return runQoderCli(['status'], context.workingDirectory ?? undefined, context.signal)
  }
}

/**
 * Codex CLI 桥接（外部 Agent 调用 Codex 干活的正统通道）。
 * 已验证：codex exec --skip-git-repo-check "prompt" < NUL 可回结果。
 * 两个坑：stdin 必须关闭（否则卡在 Reading additional input from stdin），
 * 输出含头部元信息与多轮过程，用 -o 文件取最后一条消息最干净。
 * 安全：prompt 经 argv 传，不拼 shell；cwd 强制走 resolveUserPath + 私有目录防护。
 */
async function runCodexCli(
  prompt: string,
  cwd: string | undefined,
  model: string | undefined,
  signal: AbortSignal
): Promise<string> {
  const { mkdtemp, readFile: readTmp, rm } = await import('node:fs/promises')
  const { tmpdir } = await import('node:os')
  const { join } = await import('node:path')
  const dir = await mkdtemp(join(tmpdir(), 'shangbo-codex-'))
  const outFile = join(dir, 'last.txt')
  const args = ['exec', '--skip-git-repo-check', '-o', outFile]
  if (cwd) args.push('-C', cwd)
  if (model) args.push('-m', model)
  args.push(prompt)
  try {
    await execCliFileAsync('codex', args, {
      cwd,
      timeout: 300_000,
      maxBuffer: 8 * 1024 * 1024,
      signal,
      windowsHide: true
      // 注意：execFile 默认 stdin 就是 ignore（父子进程不连管道），
      // 之前实测卡在 Reading additional input 是因为 run_command 经 shell 给了继承的 stdin。
      // 这里经 execFile 直调不配 stdio 即可，勿加 stdio 字段（其类型无此属性）。
    })
    const result = (await readTmp(outFile, 'utf8')).trim()
    return truncate(result || '（Codex 无输出）')
  } catch (error) {
    // 失败也尝试读 -o 文件：Codex 可能已产出部分答案
    try {
      const partial = (await readTmp(outFile, 'utf8')).trim()
      if (partial) return truncate(`${partial}\n\n--- Codex 退出异常 ---\n${describeError(error)}`)
    } catch {
      // 无文件则走常规错误通道
    }
    const failure = error as { stdout?: string; stderr?: string; message?: string }
    const parts = ['--- Codex 调用失败 ---']
    if (failure.stdout?.trim()) parts.push(failure.stdout.trim())
    if (failure.stderr?.trim()) parts.push(failure.stderr.trim())
    if (parts.length === 1) parts.push(failure.message ?? String(error))
    return truncate(parts.join('\n'))
  } finally {
    try {
      await rm(dir, { recursive: true, force: true })
    } catch {
      // 忽略清理失败
    }
  }
}

export const codexAsk: ToolDefinition = {
  name: 'codex_ask',
  description:
    '调用本机 Codex CLI（codex exec）让 Codex 干活并回结果。适合代码问答、改写、审查等一次任务；要在指定工程目录下问就传 cwd。需要本机已装 CLI 且已 login。',
  parameters: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: '要发给 Codex 的问题/任务' },
      cwd: { type: 'string', description: '工作目录，缺省为当前项目目录' },
      model: { type: 'string', description: '模型名，缺省用 Codex 默认' }
    },
    required: ['prompt']
  },
  requiresApproval: true,
  approvalReason: '将调用本机 Codex CLI 并消耗你的 Codex 额度，结果会回传给尚搏。',
  async execute(input, context) {
    const { prompt, cwd, model } = z
      .object({
        prompt: z.string().min(1).max(8000),
        cwd: z.string().optional(),
        model: z.string().optional()
      })
      .parse(input)
    const dir = cwd ? resolveUserPath(context, cwd) : (context.workingDirectory ?? undefined)
    if (dir) guardPrivatePath(dir)
    return runCodexCli(prompt, dir, model, context.signal)
  }
}

export const codexStatus: ToolDefinition = {
  name: 'codex_status',
  description: '查看本机 Codex CLI 的版本与登录状态（codex login status）。不消耗额度，接线前先查这个。',
  parameters: { type: 'object', properties: {}, required: [] },
  requiresApproval: false,
  async execute(_input, context) {
    try {
      const [{ stdout: v }, { stdout: s }] = await Promise.all([
        execCliFileAsync('codex', ['--version'], { windowsHide: true, signal: context.signal }),
        execCliFileAsync('codex', ['login', 'status'], { windowsHide: true, signal: context.signal })
      ])
      return truncate(`${v.trim()}\n${s.trim()}`.trim() || '（Codex 无输出）')
    } catch (error) {
      return truncate(`--- Codex 调用失败 ---\n${describeError(error)}`)
    }
  }
}

/**
 * Claude Code CLI 桥接（外部 Agent 调用 Claude 干活的正统通道）。
 * 已验证：claude -p --output-format json < NUL 可回结果，result 字段即答案。
 * 坑：Windows 下 stdin 不关会等 3 秒（Warning: no stdin data），管道喂中文 GBK 无碍但多等；
 * 用 execFile 直调默认 stdin ignore 即等价 < NUL。输出 text 干净、json 带用量。
 * 当前本机走 magpie 网关 trae-cn/deepseek-v4.1-flash-max，0.053 美元/次量级。
 * 安全：prompt 经 argv 传，不拼 shell；cwd 强制走 resolveUserPath + 私有目录防护。
 */
async function runClaudeCli(
  prompt: string,
  cwd: string | undefined,
  model: string | undefined,
  signal: AbortSignal
): Promise<string> {
  const args = ['-p', prompt, '--output-format', 'json']
  if (model) args.push('--model', model)
  try {
    const { stdout } = await execCliFileAsync('claude', args, {
      cwd,
      timeout: 300_000,
      maxBuffer: 8 * 1024 * 1024,
      signal,
      windowsHide: true
    })
    try {
      const parsed = JSON.parse(stdout) as { result?: string }
      if (typeof parsed.result === 'string' && parsed.result.trim()) {
        return truncate(parsed.result.trim())
      }
    } catch {
      // 非 JSON 直接回原文
    }
    return truncate(stdout.trim() || '（Claude 无输出）')
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message?: string }
    // claude 失败时 stdout 里可能已有 JSON 结果，先捞
    if (failure.stdout?.trim()) {
      try {
        const parsed = JSON.parse(failure.stdout) as { result?: string }
        if (typeof parsed.result === 'string' && parsed.result.trim()) {
          return truncate(`${parsed.result.trim()}\n\n--- Claude 退出异常 ---\n${describeError(error)}`)
        }
      } catch {
        // 不是 JSON 则走常规错误通道
      }
    }
    const parts = ['--- Claude 调用失败 ---']
    if (failure.stdout?.trim()) parts.push(failure.stdout.trim())
    if (failure.stderr?.trim()) parts.push(failure.stderr.trim())
    if (parts.length === 1) parts.push(failure.message ?? String(error))
    return truncate(parts.join('\n'))
  }
}

export const claudeAsk: ToolDefinition = {
  name: 'claude_ask',
  description:
    '调用本机 Claude Code CLI（claude -p）让 Claude 干活并回结果。适合代码问答、改写、审查等一次任务；要在指定工程目录下问就传 cwd。需要本机已装 CLI 且已登录。',
  parameters: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: '要发给 Claude 的问题/任务' },
      cwd: { type: 'string', description: '工作目录，缺省为当前项目目录' },
      model: { type: 'string', description: '模型名，缺省用 Claude 默认' }
    },
    required: ['prompt']
  },
  requiresApproval: true,
  approvalReason: '将调用本机 Claude CLI 并消耗你的 Claude 额度，结果会回传给尚搏。',
  async execute(input, context) {
    const { prompt, cwd, model } = z
      .object({
        prompt: z.string().min(1).max(8000),
        cwd: z.string().optional(),
        model: z.string().optional()
      })
      .parse(input)
    const dir = cwd ? resolveUserPath(context, cwd) : (context.workingDirectory ?? undefined)
    if (dir) guardPrivatePath(dir)
    return runClaudeCli(prompt, dir, model, context.signal)
  }
}

export const claudeStatus: ToolDefinition = {
  name: 'claude_status',
  description: '查看本机 Claude CLI 的版本（claude --version）。不消耗额度，接线前先查这个。',
  parameters: { type: 'object', properties: {}, required: [] },
  requiresApproval: false,
  async execute(_input, context) {
    try {
      const { stdout } = await execCliFileAsync('claude', ['--version'], {
        windowsHide: true,
        signal: context.signal
      })
      return truncate(stdout.trim() || '（Claude 无输出）')
    } catch (error) {
      return truncate(`--- Claude 调用失败 ---\n${describeError(error)}`)
    }
  }
}

/**
 * Opencode CLI 桥接（外部 Agent 调用 Opencode 干活的通道，2026-11-17 新增）。
 * 已验证：opencode run --dir <dir> "prompt" 可回结果（默认走 Glob/Grep 读文件）。
 * 输出是带 ANSI 的 formatted 文本，这里只做脱色 + 截断，不做语义解析。
 * 注意：opencode 没有 login status 概念，opencode_status 只查版本。
 * 安全：prompt 经 argv 传，不拼 shell；cwd 强制走 resolveUserPath + 私有目录防护。
 */
function stripAnsi(s: string): string {
  const ESC = String.fromCharCode(27)
  return s.replace(new RegExp(`${ESC}\\[[0-9;]*m`, 'g'), '')
}

async function runOpencodeCli(
  prompt: string,
  cwd: string | undefined,
  model: string | undefined,
  signal: AbortSignal
): Promise<string> {
  const args = ['run']
  if (cwd) args.push('--dir', cwd)
  if (model) args.push('-m', model)
  args.push(prompt)
  try {
    const { stdout, stderr } = await execCliFileAsync('opencode', args, {
      cwd,
      timeout: 300_000,
      maxBuffer: 8 * 1024 * 1024,
      signal,
      windowsHide: true
    })
    const out = stripAnsi(`${stdout.trim()}${stderr.trim() ? `\n--- 标准错误 ---\n${stderr.trim()}` : ''}`)
    return truncate(out.trim() || '（Opencode 无输出）')
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message?: string }
    const parts = ['--- Opencode 调用失败 ---']
    const so = failure.stdout?.trim() ? stripAnsi(failure.stdout.trim()) : ''
    if (so) parts.push(so)
    if (failure.stderr?.trim()) parts.push(failure.stderr.trim())
    if (parts.length === 1) parts.push(failure.message ?? String(error))
    return truncate(parts.join('\n'))
  }
}

export const opencodeAsk: ToolDefinition = {
  name: 'opencode_ask',
  description:
    '调用本机 Opencode CLI（opencode run）让 Opencode 干活并回结果。适合代码问答、改写、审查等一次任务；要在指定工程目录下问就传 cwd。需要本机已装 CLI 且配好模型鉴权。',
  parameters: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: '要发给 Opencode 的问题/任务' },
      cwd: { type: 'string', description: '工作目录，缺省为当前项目目录' },
      model: { type: 'string', description: '模型名（provider/model 格式），缺省用 Opencode 默认' }
    },
    required: ['prompt']
  },
  requiresApproval: true,
  approvalReason: '将调用本机 Opencode CLI 并消耗你的模型额度，结果会回传给尚搏。',
  async execute(input, context) {
    const { prompt, cwd, model } = z
      .object({
        prompt: z.string().min(1).max(8000),
        cwd: z.string().optional(),
        model: z.string().optional()
      })
      .parse(input)
    const dir = cwd ? resolveUserPath(context, cwd) : (context.workingDirectory ?? undefined)
    if (dir) guardPrivatePath(dir)
    return runOpencodeCli(prompt, dir, model, context.signal)
  }
}

export const opencodeStatus: ToolDefinition = {
  name: 'opencode_status',
  description: '查看本机 Opencode CLI 的版本（opencode --version）。不消耗额度，接线前先查这个。',
  parameters: { type: 'object', properties: {}, required: [] },
  requiresApproval: false,
  async execute(_input, context) {
    try {
      const { stdout } = await execCliFileAsync('opencode', ['--version'], {
        windowsHide: true,
        signal: context.signal
      })
      return truncate(stdout.trim() || '（Opencode 无输出）')
    } catch (error) {
      return truncate(`--- Opencode 调用失败 ---\n${describeError(error)}`)
    }
  }
}
