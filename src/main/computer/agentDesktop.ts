import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'

/**
 * agent-desktop CLI 适配层：把 Vercel Labs 的 agent-desktop 包成可用能力。
 *
 * 定位：无障碍树优先的桌面操作通道，与现有 computer_*（截图 + 像素坐标）并存。
 * 优势在于 ref 稳定、不抢焦点、失败可判定（STALE_REF 等），适合"点控件"；
 * 截图仍负责"看外观"（颜色/布局/图表/自绘界面），两者互补而非替代。
 *
 * 关键约束（实测得出，改动前请先验证）：
 *  1. 出错时进程退出码仍是 0，成败只能看 JSON 里的 ok 字段，不能靠 exit code；
 *  2. ref 与快照绑定，裸 @e8 会被拒，必须用 @<snapshot_id>:eN 全限定形式；
 *  3. PowerShell 里 @ 是 splatting 操作符，必须加引号——这里走 execFile 传数组，不经 shell；
 *  4. 密集界面快照可达数万字符，必须先压缩再给模型，并引导用 --root 下钻。
 */

const execFileAsync = promisify(execFile)

/** 一条命令的超时：快照可能扫整棵无障碍树，给宽一点。 */
const DEFAULT_TIMEOUT_MS = 60_000

/**
 * 固定的快照命名空间。
 *
 * 实测结论（务必保留）：agent-desktop 的 ref 是「session 作用域」的。
 * snapshot 与 click 是两次独立进程，只有在同一个 --session 下，
 * 前一次产出的 ref 才在后一次可见；不带 session 会直接
 * SNAPSHOT_NOT_FOUND。这里统一注入同一个名字，让"先快照、后点 ref"
 * 这条跨进程链路成立。
 *
 * 用固定值而不是随机值：同一应用会话内多次快照可以互相复用 ref，
 * 也便于排障时用 CLI 手工复现同样的命名空间。
 */
const SESSION_NAME = 'shangbo-agent'

export interface AgentDesktopEnvelope {
  version?: string
  ok: boolean
  command?: string
  data?: Record<string, unknown>
  error?: {
    code?: string
    message?: string
    suggestion?: string
    recovery?: { strategy?: string; retryable?: boolean; requires_fresh_snapshot?: boolean }
    disposition?: { delivery?: string; retry?: string }
    details?: unknown
  }
}

export interface AgentDesktopRun {
  ok: boolean
  envelope: AgentDesktopEnvelope | null
  /** 原始输出，解析失败时用于排障。 */
  raw: string
}

let cachedBinary: string | null | undefined

/**
 * 定位可执行文件。
 *
 * 优先直接用平台原生二进制（npm 包 bin/ 下的 agent-desktop-win32-x64.exe），
 * 这样完全不经 cmd/sh，参数里的引号与 @ 都不会被二次解释；
 * 找不到再回退到 PATH 上的 agent-desktop（macOS/Linux 或非标准安装）。
 */
export function resolveBinary(): string | null {
  if (cachedBinary !== undefined) return cachedBinary
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64'
  const candidates: string[] = []

  if (process.platform === 'win32') {
    const appData = process.env.APPDATA
    const roots = [
      appData ? join(appData, 'npm', 'node_modules', 'agent-desktop', 'bin') : '',
      // 项目内局部安装（可选路径，存在才用）
      join(process.cwd(), 'node_modules', 'agent-desktop', 'bin')
    ].filter(Boolean)
    for (const root of roots) {
      candidates.push(join(root, `agent-desktop-win32-${arch}.exe`))
    }
  } else {
    const roots = [
      '/usr/local/lib/node_modules/agent-desktop/bin',
      '/usr/lib/node_modules/agent-desktop/bin',
      join(process.cwd(), 'node_modules', 'agent-desktop', 'bin')
    ]
    const suffix = process.platform === 'darwin' ? `darwin-${arch}` : `linux-${arch}`
    for (const root of roots) {
      candidates.push(join(root, `agent-desktop-${suffix}`))
    }
  }

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      cachedBinary = candidate
      return candidate
    }
  }
  // 回退：交给 PATH 解析（macOS/Linux 的全局安装、或用户自建软链）
  cachedBinary = process.platform === 'win32' ? null : 'agent-desktop'
  return cachedBinary
}

/** 是否装好可用。不可用时给出人话原因，供工具层直接提示模型。 */
export function availability(): { available: boolean; binary: string | null; reason?: string } {
  const binary = resolveBinary()
  if (!binary) {
    return {
      available: false,
      binary: null,
      reason:
        '未找到 agent-desktop CLI。安装：npm install -g agent-desktop --allow-scripts=agent-desktop（postinstall 需放行，否则原生二进制不会下载）。'
    }
  }
  return { available: true, binary }
}

function parseEnvelope(stdout: string): AgentDesktopEnvelope | null {
  const text = stdout.trim()
  if (!text) return null
  // 正常只有一行 JSON；但原生层可能先打印告警，从后往前找第一个可解析的 JSON 对象
  const lines = text.split(/\r?\n/).filter((line) => line.trim().startsWith('{'))
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]) as AgentDesktopEnvelope
      if (typeof parsed?.ok === 'boolean') return parsed
    } catch {
      continue
    }
  }
  return null
}

/**
 * 跑一条 agent-desktop 命令。
 *
 * 参数一律走数组，不经 shell：app 名、ref 里都可能出现 @ 与引号，
 * 走 shell 会被 PowerShell 的 splatting 或 cmd 的引号规则改写。
 */
export async function runAgentDesktop(
  args: string[],
  options?: { timeoutMs?: number; signal?: AbortSignal }
): Promise<AgentDesktopRun> {
  const { available, binary, reason } = availability()
  if (!available || !binary) throw new Error(reason ?? 'agent-desktop 不可用')

  // 统一注入 session：不加这一步，snapshot 产出的 ref 在 click 进程里查不到
  const finalArgs = args.includes('--session') ? args : [...args, '--session', SESSION_NAME]

  try {
    const { stdout, stderr } = await execFileAsync(binary, finalArgs, {
      timeout: options?.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
      signal: options?.signal,
      windowsHide: true
    })
    const envelope = parseEnvelope(stdout)
    const raw = `${stdout}${stderr ? `\n--- 标准错误 ---\n${stderr}` : ''}`.trim()
    return { ok: envelope?.ok === true, envelope, raw }
  } catch (error) {
    // 超时、被杀、二进制缺失都会走到这里；把已有输出尽量捞回来
    const failure = error as { stdout?: string; stderr?: string; message?: string; killed?: boolean }
    const envelope = parseEnvelope(failure.stdout ?? '')
    const raw = [failure.stdout?.trim(), failure.stderr?.trim()].filter(Boolean).join('\n')
    if (envelope) return { ok: envelope.ok === true, envelope, raw }
    const hint = failure.killed ? '（命令超时被终止）' : ''
    throw new Error(`agent-desktop 执行失败${hint}：${failure.message ?? String(error)}${raw ? `\n${raw}` : ''}`)
  }
}

/* ------------------------------------------------------------------ */
/* 快照 → 给模型看的紧凑文本                                              */
/* ------------------------------------------------------------------ */

export interface SnapshotNode {
  role?: string
  name?: string
  value?: string
  description?: string
  ref_id?: string
  native_id?: { kind?: string; value?: string }
  available_actions?: string[]
  states?: string[]
  children?: SnapshotNode[]
  children_count?: number
  subtree_truncated?: boolean
}

export interface SnapshotData {
  app?: string
  window?: { id?: string; title?: string }
  snapshot_id?: string
  ref_count?: number
  complete?: boolean
  truncated?: boolean
  nodes_observed?: number
  tree?: SnapshotNode
}

function clean(text: string | undefined, max: number): string {
  if (!text) return ''
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length > max ? `${flat.slice(0, max)}…` : flat
}

/**
 * 把无障碍树压成缩进文本。
 *
 * 不直接给模型原始 JSON：Chrome 这类密集界面一次就 2 万字符以上，
 * 会挤掉真正的上下文。这里只留定位与决策必需的信息，并给出行数上限，
 * 超限时提示用 --root 下钻而不是硬塞。
 */
export function renderSnapshot(data: SnapshotData, options?: { maxLines?: number }): string {
  const maxLines = options?.maxLines ?? 400
  const lines: string[] = []
  const head: string[] = []
  if (data.snapshot_id) head.push(`snapshot_id=${data.snapshot_id}`)
  if (data.app) head.push(`app=${data.app}`)
  if (data.window?.title) head.push(`window="${clean(data.window.title, 80)}"`)
  if (typeof data.ref_count === 'number') head.push(`ref_count=${data.ref_count}`)
  if (data.complete === false) head.push('complete=false（树被截断，可用 --root 下钻看局部）')
  lines.push(head.join(' '))

  let truncated = false
  const walk = (node: SnapshotNode, depth: number): void => {
    if (truncated) return
    if (lines.length >= maxLines) {
      truncated = true
      return
    }
    const indent = '  '.repeat(depth)
    const role = node.role ?? 'node'
    const name = clean(node.name, 60)
    const parts = [`${indent}- ${role}${name ? ` "${name}"` : ''}`]
    if (node.ref_id) parts.push(` ${node.ref_id}`)
    const value = clean(node.value, 60)
    if (value) parts.push(` value="${value}"`)
    if (node.description) parts.push(` desc="${clean(node.description, 40)}"`)
    if (node.available_actions?.length) parts.push(` [${node.available_actions.join(',')}]`)
    if (node.states?.length) parts.push(` (${node.states.join(',')})`)
    if (node.children_count && !node.children?.length) parts.push(` +${node.children_count}子`)
    if (node.subtree_truncated) parts.push(' …子树被截断')
    lines.push(parts.join(''))
    for (const child of node.children ?? []) walk(child, depth + 1)
  }
  if (data.tree) walk(data.tree, 0)

  if (truncated) {
    lines.push(`…（已按 ${maxLines} 行截断显示；要看其他区域请用 desktop_snapshot 的 root 参数指向某个 ref 下钻）`)
  }
  return lines.join('\n')
}

/** 把信封里的错误翻成人话，并标出可否安全重试。 */
export function describeFailure(run: AgentDesktopRun): string {
  const error = run.envelope?.error
  if (!error) return run.raw || 'agent-desktop 返回了无法解析的输出'
  const bits = [`[${error.code ?? 'UNKNOWN'}] ${error.message ?? ''}`.trim()]
  if (error.suggestion) bits.push(`建议：${error.suggestion}`)
  const retry = error.disposition?.retry
  if (retry) bits.push(`可重试：${retry === 'safe' ? '是（未送达）' : '否（可能已送达，勿盲目重试）'}`)
  return bits.join('\n')
}
