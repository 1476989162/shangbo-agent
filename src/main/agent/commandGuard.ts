import { app } from 'electron'
import { isAbsolute, relative, resolve } from 'node:path'

/**
 * 许愿模式命令边界的唯一判定处。
 *
 * 这里决定的是「能不能不经人工审批直接执行」，不是「能不能执行」：
 * 返回 false 时 runtime 会落回审批流程，所以策略应当保守。
 *
 * 三条规则：
 *  1. 白名单优先：只有已知的构建/查看类命令才可能自动放行；
 *  2. 复合命令逐段检查：`&&`、`||`、`;`、`|` 拆开后每一段都要过；
 *  3. 黑名单兜底：根路径、编码执行、下载执行、符号链接等直接判否。
 */

/** 允许自动放行的命令首词（含 Windows 的 .exe/.cmd 形式）。 */
const ALLOWED_COMMANDS = new Set([
  'npm',
  'npx',
  'pnpm',
  'yarn',
  'node',
  'tsc',
  'vitest',
  'git',
  'python',
  'pip',
  'pytest',
  'dotnet',
  'cargo',
  'go',
  'ls',
  'dir',
  'cat',
  'type',
  'echo',
  'mkdir'
])

/** git 只允许这些子命令；checkout 还要求带 -b（新建分支）。 */
const ALLOWED_GIT_SUBCOMMANDS = new Set([
  'status',
  'diff',
  'log',
  'add',
  'commit',
  'stash',
  'checkout'
])

/**
 * 明确危险的写法。即使首词在白名单里，命中任意一条也落回审批：
 * - 根相对/Unix 绝对路径
 * - 编码执行与表达式求值
 * - 下载执行、远程复制
 * - 符号链接与强制推送
 */
const DANGEROUS_PATTERNS: RegExp[] = [
  /(^|[\s"'=;|&])\\[a-z]/i, // \Windows、\Users：Windows 根相对路径
  /(^|[\s"'=;|&])\\(?=$|[\s"'=;|&])/, // 单独一个 \：根目录
  /(^|[\s"'=;|&])\//, // /、/c/Users、/etc/passwd：Unix 绝对路径
  /(^|[\s"'=;|&])--force(?=$|[\s"'=;|&])/i,
  /(^|[\s"'=;|&])-enc(?:odedcommand)?(?=$|[\s"'=;|&])/i,
  /(^|[\s"'=;|&])iex(?=$|[\s"'=;|&])/i,
  /invoke-expression/i,
  /invoke-webrequest/i,
  /(^|[\s"'=;|&])iwr(?=$|[\s"'=;|&])/i,
  /(^|[\s"'=;|&])curl(?=$|[\s"'=;|&])/i,
  /(^|[\s"'=;|&])wget(?=$|[\s"'=;|&])/i,
  /(^|[\s"'=;|&])scp(?=$|[\s"'=;|&])/i,
  /(^|[\s"'=;|&])mklink(?=$|[\s"'=;|&])/i,
  /symboliclink/i,
  /\[environment\]/i,
  /\[io\./i,
  // 内联求值：python -c、node -e/--eval 可以绕过所有路径检查
  /(^|[\s"'=;|&])python(?:\.exe)?\s+-c(?=$|[\s"'=;|&])/i,
  /(^|[\s"'=;|&])node(?:\.exe)?\s+(?:-e|--eval)(?=$|[\s"'=;|&])/i
]

/** 路径/变量逃逸：`..`、`~`、%VAR%、$env:、$HOME、$PROFILE 等。 */
const ESCAPE_PATTERN =
  /(^|[\s;&|"'`])(?:\.\.|~)(?=[\\/\s;&|"'`]|$)|%[a-z_]+%|\$env:|\$\{?home\}?|\$\{?userprofile\}?|\$\{?profile\}?|\$pwd/i

/**
 * 命令是否完全落在工作区内。
 * 返回 true 只代表「边界检查通过」，调用方还要再过私有数据检查。
 */
export function commandStaysInsideWorkspace(command: string, workspace: string): boolean {
  const cmd = command.trim()
  if (!cmd) return false
  if (ESCAPE_PATTERN.test(cmd)) return false
  if (DANGEROUS_PATTERNS.some((pattern) => pattern.test(cmd))) return false

  const segments = splitCommand(cmd)
  if (segments.length === 0) return false

  for (const segment of segments) {
    if (!segmentStaysInside(segment, workspace)) return false
  }
  return true
}

/**
 * 按复合/管道符号拆命令。引号内的分隔符也会被拆开：
 * 这只会让更多命令落回审批，不会放宽边界。
 */
export function splitCommand(command: string): string[] {
  return command
    .split(/\s*(?:&&|\|\||;|\|)\s*/)
    .map((part) => part.trim())
    .filter(Boolean)
}

function segmentStaysInside(segment: string, workspace: string): boolean {
  const tokens = segment.split(/\s+/)
  const rawName = tokens[0]?.replace(/^["']|["']$/g, '') ?? ''
  const name = rawName.replace(/\.(exe|cmd|bat)$/i, '').toLowerCase()
  if (!ALLOWED_COMMANDS.has(name)) return false

  if (name === 'git' && !gitSubcommandAllowed(tokens.slice(1))) return false

  // 段内出现的盘符/UNC 绝对路径必须都落在工作区内
  const absolutePaths = segment.match(/(?:[a-zA-Z]:[\\/][^\s"';&|]*|\\\\[^\s"';&|]+)/g) ?? []
  for (const path of absolutePaths) {
    if (!isPathInside(workspace, path)) return false
  }
  return true
}

function gitSubcommandAllowed(args: string[]): boolean {
  const sub = args[0]?.toLowerCase() ?? ''
  if (!ALLOWED_GIT_SUBCOMMANDS.has(sub)) return false
  if (sub !== 'checkout') return true
  // 只允许 `checkout -b <branch>`：`checkout .` 会丢弃工作区改动
  return args[1] === '-b' && typeof args[2] === 'string' && args[2].length > 0
}

/** 字符串层面的路径包含判断；T2 会在此基础上补 realpath 检查。 */
export function isPathInside(root: string, candidate: string): boolean {
  try {
    const base = resolve(root)
    const target = isAbsolute(candidate) ? resolve(candidate) : resolve(base, candidate)
    const rel = relative(base, target)
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  } catch {
    return false
  }
}

/**
 * 是否触碰应用私有数据（密钥库、会话数据库及其 sidecar）。
 * userData 路径可注入，单测无需真的启动 Electron。
 */
export function touchesPrivateData(value: string, userDataPath = safeUserDataPath()): boolean {
  const normalized = value.replace(/\//g, '\\').toLowerCase()
  if (normalized.includes('secrets.json')) return true
  if (normalized.includes('shangbo-agent.db')) return true
  // 任意 sqlite 的 WAL/SHM sidecar：`--walk` 这类参数不会命中
  if (/\.db-(wal|shm)(?=$|[\\\s"';&|])/.test(normalized)) return true
  if (userDataPath) {
    const userData = userDataPath.replace(/\//g, '\\').toLowerCase().replace(/\\+$/, '')
    if (userData && normalized.includes(userData)) return true
  }
  return false
}

/** 取真实 userData；无 Electron 环境时返回 null，不影响纯函数测试。 */
export function safeUserDataPath(): string | null {
  try {
    const value = app?.getPath?.('userData')
    return typeof value === 'string' && value ? value : null
  } catch {
    return null
  }
}
