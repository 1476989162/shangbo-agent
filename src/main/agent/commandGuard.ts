import { app } from 'electron'
import { existsSync, realpathSync } from 'node:fs'
import { isAbsolute, relative, resolve } from 'node:path'

/**
 * 许愿模式命令边界的唯一判定处。
 *
 * 这里决定的是「能不能不经人工审批直接执行」，不是「能不能执行」：
 * 返回 false 时 runtime 会落回审批流程，所以策略应当保守。
 *
 * 三条规则：
 *  1. 白名单优先：只有已知的构建/查看类命令才可能自动放行；
 *  2. 复合命令按 cmd.exe 语义逐段检查：`&&`、`||`、`|`、`&` 拆开；
 *     `;` 不是分隔符，出现即判语法错误；
 *  3. 黑名单兜底：根路径、编码执行、下载执行、符号链接等直接判否。
 */

/** 允许自动放行的命令首词（含 Windows 的 .exe/.cmd 形式）。 */
const ALLOWED_COMMANDS = new Set([
  'npm',
  'npx',
  'pnpm',
  'yarn',
  'bun',
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
  'mvn',
  'gradle',
  'make',
  'ls',
  'dir',
  'cat',
  'type',
  'more',
  'findstr',
  'where',
  'tree',
  'echo',
  'mkdir',
  'copy',
  'move'
])

/** git 只允许这些子命令；checkout 还要求带 -b（新建分支）。 */
const ALLOWED_GIT_SUBCOMMANDS = new Set([
  'status',
  'diff',
  'log',
  'show',
  'branch',
  'remote',
  'rev-parse',
  'ls-files',
  'blame',
  'describe',
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
 * 按 cmd.exe 的语义拆分复合命令。
 *
 * 关键点：cmd 的分隔符是 `&&`、`||`、`|`、`&`，**不是 `;`**。
 * 旧实现按 POSIX 的 `;` 拆分，护栏会把 `rmdir ... ; git ...` 看成两条命令，
 * 而 cmd 会把 `git`、`-C`、路径全部当成 rmdir 的参数——检查的对象和执行的
 * 对象不是同一条命令，这是 2026-11-04 F:\router 被误删的根因之一。
 *
 * 引号内的分隔符不拆；`^` 转义的下一个字符按字面处理。
 */
export function splitCommand(command: string): string[] {
  return scanCmd(command).segments
}

interface CmdScanResult {
  segments: string[]
  /** 引号外出现 `;`：cmd 不支持，通常意味着模型误用了 PowerShell/POSIX 语法。 */
  posixSemicolon: boolean
}

function scanCmd(command: string): CmdScanResult {
  const segments: string[] = []
  let current = ''
  let inQuote = false
  let posixSemicolon = false

  for (let i = 0; i < command.length; i++) {
    const ch = command[i]
    if (ch === '^' && !inQuote) {
      if (i + 1 < command.length) current += command[++i]
      continue
    }
    if (ch === '"') {
      inQuote = !inQuote
      current += ch
      continue
    }
    if (!inQuote) {
      // 行尾的 `;` 是 SQL 语句终止符，不按 shell 分隔符处理；
      // 只有后面还有内容（`; git ...`）才判成 cmd 语法错误。
      if (ch === ';' && command.slice(i + 1).trim()) posixSemicolon = true
      // `2>&1`、`>&2` 里的 & 是重定向，不是命令分隔符
      if (ch === '&' && command[i - 1] !== '>') {
        segments.push(current)
        current = ''
        if (command[i + 1] === '&') i++
        continue
      }
      if (ch === '|') {
        segments.push(current)
        current = ''
        if (command[i + 1] === '|') i++
        continue
      }
    }
    current += ch
  }
  segments.push(current)
  return {
    segments: segments.map((part) => part.trim()).filter(Boolean),
    posixSemicolon
  }
}

/** 删除类动词。move/rename 会单独走 .git / 数据库硬红线，这里只处理删除。 */
const DELETE_VERBS = new Set([
  'rmdir',
  'rd',
  'del',
  'erase',
  'rm',
  'remove-item',
  'ri',
  'unlink',
  'shred'
])

export interface CmdAnalysis {
  posixSemicolon: boolean
  destructive: boolean
  targets: string[]
  recursive: boolean
  segments: string[]
}

interface DestructiveTargets {
  verb: string
  targets: string[]
  recursive: boolean
}

function normalizeVerb(token: string): string {
  return token.replace(/^.*[\\/]/, '').replace(/\.(exe|cmd|bat)$/i, '').toLowerCase()
}

/** 去掉重定向（`2>&1`、`>nul`、`>> file`），避免把输出文件当成删除目标。 */
function stripRedirections(segment: string): string {
  let out = ''
  let inQuote = false
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]
    if (ch === '"') {
      inQuote = !inQuote
      out += ch
      continue
    }
    if (!inQuote && (ch === '>' || ch === '<')) {
      let j = i + 1
      if (segment[j] === '>') j++
      if (segment[j] === '&') {
        j++
        if (/\d/.test(segment[j] ?? '')) j++
      } else {
        while (j < segment.length && /\s/.test(segment[j])) j++
        if (segment[j] === '"') {
          j++
          while (j < segment.length && segment[j] !== '"') j++
          if (segment[j] === '"') j++
        } else {
          while (j < segment.length && !/[\s&|]/.test(segment[j])) j++
        }
      }
      i = j - 1
      // 去掉紧挨着重定向符的文件描述符数字（2>&1 的 2）
      if (/(^|\s)\d$/.test(out)) out = out.slice(0, -1)
      continue
    }
    out += ch
  }
  return out
}

/** 按 cmd 规则分词：双引号保留空格，^ 转义，单引号不是引号。 */
function tokenizeCmd(segment: string): string[] {
  const tokens: string[] = []
  let current = ''
  let inQuote = false
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]
    if (ch === '^' && !inQuote) {
      if (i + 1 < segment.length) current += segment[++i]
      continue
    }
    if (ch === '"') {
      inQuote = !inQuote
      continue
    }
    if (!inQuote && /\s/.test(ch)) {
      if (current) {
        tokens.push(current)
        current = ''
      }
      continue
    }
    current += ch
  }
  if (current) tokens.push(current)
  return tokens
}

function findDestructiveTargets(segment: string): DestructiveTargets | null {
  const tokens = tokenizeCmd(stripRedirections(segment))
  if (tokens.length === 0) return null
  const verb = normalizeVerb(tokens[0])
  if (!DELETE_VERBS.has(verb)) return null

  const rest = tokens.slice(1)
  const isCmdVerb = verb === 'rmdir' || verb === 'rd' || verb === 'del' || verb === 'erase'
  const recursive = isCmdVerb
    ? rest.some((token) => /^\/s$/i.test(token))
    : verb === 'rm'
      ? rest.some((token) => /^-[a-z]*r[a-z]*$/i.test(token))
      : verb === 'remove-item' || verb === 'ri'
        ? rest.some((token) => /^-recurse$/i.test(token))
        : false
  const targets = rest.filter((token) => {
    if (isCmdVerb) return !token.startsWith('/')
    if (verb === 'rm' || verb === 'remove-item' || verb === 'ri') return !token.startsWith('-')
    return true
  })
  return { verb, targets, recursive }
}

/** 提取命令里的删除动词、全部目标与递归标记，供 safety / 工具层共用。 */
export function analyzeCmdCommand(command: string): CmdAnalysis {
  const { segments, posixSemicolon } = scanCmd(command)
  const found = segments
    .map(findDestructiveTargets)
    .filter((item): item is DestructiveTargets => item !== null)
  return {
    posixSemicolon,
    destructive: found.length > 0,
    targets: found.flatMap((item) => item.targets),
    recursive: found.some((item) => item.recursive),
    segments
  }
}

export type DestructiveCategory = 'disk' | 'system' | 'workspace'

export interface DestructiveVerdict {
  tier: 'blocked' | 'hard'
  category: DestructiveCategory
  reason: string
}

/** 删除目标本身就是根目录/盘符根/当前目录/裸通配。 */
const ROOT_TARGET = /^(?:[a-z]:[\\/]\*?|\\|\/|\/\*|\.|\.\.|\*|~\/?\*?)$/i

/** candidate 是否是 root 的上级目录（或等于 root）。 */
function isAncestorOrSelf(root: string, candidate: string): boolean {
  try {
    const rel = relative(resolve(candidate), resolve(root))
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  } catch {
    return false
  }
}

/**
 * 判断删除命令是否触碰工作区根/上级目录/多个目标。
 *
 * 这是对“cmd 语义”的兜底：即使模型把 `;` 写进了 cmd，或者一条命令里
 * 塞了多个删除目标，也不会被当成普通的子目录清理放过去。
 */
export function classifyDestructiveCommand(
  command: string,
  workspace?: string | null
): DestructiveVerdict | null {
  const analysis = analyzeCmdCommand(command)

  // cmd 不支持 `;`。这不是“风险审批”，而是确定性语法错误：
  // 继续执行只会让 rmdir 把后面的路径当参数，直接拒绝并要求改写。
  if (process.platform === 'win32' && analysis.posixSemicolon) {
    return {
      tier: 'blocked',
      category: 'system',
      reason: '【Freebuff 安全护栏】当前 shell 是 cmd.exe，不支持 `;`。请用 `&&` 连接多条命令，或分两次调用。'
    }
  }

  if (!analysis.destructive) return null
  const ws = workspace ? resolve(workspace) : null

  for (const raw of analysis.targets) {
    const target = raw.trim()
    if (!target) continue
    if (ROOT_TARGET.test(target)) {
      return {
        tier: 'blocked',
        category: 'disk',
        reason: '【Freebuff 安全护栏】检测到删除根目录、盘符根、当前目录或裸通配符：这是永久禁止的红线。'
      }
    }
    if (!ws) continue

    const resolved = isAbsolute(target) ? resolve(target) : resolve(ws, target)
    if (resolved === ws) {
      return {
        tier: 'blocked',
        category: 'workspace',
        reason: '【Freebuff 安全护栏】检测到删除工作区根目录：这会清空整个项目，永久禁止。'
      }
    }
    if (isAncestorOrSelf(ws, resolved)) {
      return {
        tier: 'blocked',
        category: 'workspace',
        reason: '【Freebuff 安全护栏】检测到删除工作区的上级目录：这会连带删除整个工作区，永久禁止。'
      }
    }
    const wildcardBase = target.replace(/[\\/]\*.*$/, '')
    if (wildcardBase !== target && isAbsolute(wildcardBase) && resolve(wildcardBase) === ws) {
      return {
        tier: 'blocked',
        category: 'workspace',
        reason: '【Freebuff 安全护栏】检测到通配删除工作区根目录下的全部内容，永久禁止。'
      }
    }
  }

  if (analysis.recursive && analysis.targets.length > 1) {
    return {
      tier: 'hard',
      category: 'system',
      reason: '【Freebuff 安全护栏】递归删除命令包含多个目标，必须人工确认。'
    }
  }

  if (ws) {
    for (const raw of analysis.targets) {
      const target = raw.trim()
      if (!target) continue
      const resolved = isAbsolute(target) ? resolve(target) : resolve(ws, target)
      if (!isPathInside(ws, resolved)) {
        return {
          tier: 'hard',
          category: 'system',
          reason: '【Freebuff 安全护栏】递归删除工作区外的路径，必须人工确认。'
        }
      }
      if (existsSync(ws) && !isPathInsideResolved(ws, resolved)) {
        return {
          tier: 'hard',
          category: 'system',
          reason: '【Freebuff 安全护栏】递归删除工作区外的路径（解析链接后），必须人工确认。'
        }
      }
    }
  }

  return null
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
    // 工作区真实存在时再加一道 realpath：防止借 junction 指向外部
    if (existsSync(workspace) && !isPathInsideResolved(workspace, path)) return false
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
 * 解析符号链接后的路径包含判断。
 *
 * 工作区里的 junction / 符号链接可以指向外部目录，只做字符串比较会被绕过。
 * 目标存在时解析目标本身；目标不存在时解析最近一层存在的父目录，
 * 再把剩余的不存在部分拼回去比较。
 */
export function isPathInsideResolved(root: string, candidate: string): boolean {
  try {
    const base = realpathSync.native(resolve(root))
    const target = isAbsolute(candidate) ? resolve(candidate) : resolve(base, candidate)
    const resolvedTarget = realpathNearest(target)
    const rel = relative(base, resolvedTarget)
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  } catch {
    // 路径不存在、符号链接成环或无权限时一律判否
    return false
  }
}

/** 解析最近一层存在的祖先，再把不存在的那几段拼回去。 */
function realpathNearest(target: string): string {
  const missing: string[] = []
  let cursor = target
  while (!existsSync(cursor)) {
    const parent = resolve(cursor, '..')
    if (parent === cursor) throw new Error('无法解析路径')
    missing.unshift(resolve(cursor).slice(parent.length).replace(/^[\\/]+/, ''))
    cursor = parent
  }
  const base = realpathSync.native(cursor)
  return missing.length > 0 ? resolve(base, ...missing) : base
}

/**
 * 文件类工具能否在许愿模式下免审批。
 * 字符串边界 + realpath 边界都要通过，且不能触碰私有数据。
 */
export function isPathAutoApprovable(
  workingDirectory: string,
  rawPath: string,
  userDataPath?: string | null
): boolean {
  if (!rawPath.trim()) return false
  const target = isAbsolute(rawPath) ? rawPath : resolve(workingDirectory, rawPath)
  if (!isPathInsideResolved(workingDirectory, target)) return false
  return !touchesPrivateData(target, userDataPath)
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
