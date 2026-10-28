import { isAbsolute, resolve } from 'node:path'
import type { AutonomyLevel } from '../../shared/types'
import { commandStaysInsideWorkspace, isPathInsideResolved, touchesPrivateData } from './commandGuard'

/**
 * 工具调用的安全分级。
 *
 * 这一层只回答一个问题：**这次调用能不能在没有人看着的情况下执行**。
 * 它不负责执行，也不负责弹窗；runtime 依据 tier 决定直接放行、请求确认，
 * 还是永久拒绝。所有判定都是纯函数，便于单测与审计。
 *
 * 三条硬红线（无论自治等级、许愿模式、永久放行名单如何设置，都不自动放行）：
 *  1. 磁盘格式化 / 分区 / 擦盘 —— 直接 blocked，永不执行；
 *  2. 删除 .git 仓库、强推/硬重置等重写历史的 git 操作 —— hard，必须人工确认；
 *  3. 删库、清表、无 WHERE 的 DELETE、删除数据库文件 —— hard，必须人工确认。
 */

export type SafetyTier = 'blocked' | 'hard' | 'soft' | 'auto'

export type SafetyCategory =
  | 'disk'
  | 'git'
  | 'database'
  | 'system'
  | 'private-data'
  | 'workspace'
  | 'external'
  | 'read'

export interface SafetyVerdict {
  tier: SafetyTier
  category: SafetyCategory
  /** 展示给用户/模型的判定理由。 */
  reason?: string
  /** 是否允许被「始终允许」或自治等级自动放行；hard / blocked 恒为 false。 */
  autoApprovable: boolean
}

export interface SafetyContext {
  workingDirectory: string | null
  autonomy: AutonomyLevel
}

const READ_ONLY_TOOLS = new Set([
  'get_current_time',
  'list_directory',
  'read_file',
  'search_files',
  'glob_files',
  'todo_write',
  'computer_screenshot'
])

/** 删除类动词：rm / rmdir / rd / del / erase / Remove-Item / unlink / shred。 */
const DELETE_VERB = /\b(?:rm|rmdir|rd|del|erase|remove-item|ri|unlink|shred)\b/i
/** 移动/改名也能让仓库或数据库「消失」。 */
const MOVE_VERB = /\b(?:mv|move|move-item|rename-item|ren)\b/i

/** .git 目录出现在路径位置（避免误伤 `.gitignore`、`git` 普通单词）。 */
const GIT_DIR_TOKEN = /(?:^|[\s"'=;|&(])(?:[a-z]:[\\/][^\s"';&|]*[\\/])?\.git(?:[\\/\s"';&|)]|$)/i

/** 磁盘级毁灭操作：直接 blocked。 */
const DISK_BLOCKERS: RegExp[] = [
  /\bformat\s+[a-z]:/i,
  /\bdiskpart\b/i,
  /\bmkfs(?:\.|\s)/i,
  /\b(?:fdisk|parted|wipefs)\b/i,
  /\bbcdedit\s+\/delete/i,
  /\bvssadmin\s+delete/i,
  /\bcipher\s+\/w/i,
  /\bdd\b[^\n]*\bof=\/dev\//i,
  /\bshred\b[^\n]*\/dev\//i,
  // 裸盘设备写入：`echo x > /dev/sda`、`cat img > /dev/nvme0n1`
  />\s*\/dev\/(?:sd|hd|nvme|vd|disk)/i
]

/**
 * 根目录/整盘删除目标。
 * 只匹配「目标本身就是根」：`/`、`/*`、`C:\`、`C:/*`、`~/*`、`*`。
 * `./dist`、`/tmp/x`、`*.log` 都不命中，避免把日常清理误判成擦盘。
 */
const ROOT_WIPE_TARGET = /(?:^|[\s"'=;|&])(?:\/|\/\*|[a-z]:[\\/]\*?|~\/?\*?|%home%|\*)(?=$|[\s"';|&])/i

/** 数据库破坏性语句。 */
const DB_BLOCKERS: RegExp[] = [
  /\bdrop\s+(?:database|schema|table)\b/i,
  /\btruncate\s+table\b/i,
  /\balter\s+table\b[\s\S]*\bdrop\b/i,
  /\bdb\.dropdatabase\s*\(/i,
  /\bdropdatabase\s*\(/i,
  /\b(?:flushall|flushdb)\b/i,
  /\bdropdb\b/i,
  /\bmongorestore\b[\s\S]*--drop\b/i,
  /\bsqlite3?\b[\s\S]*\.(?:delete|drop)\b/i
]

/** 数据库文件：删除或移动即视为删库。 */
const DB_FILE = /\.(?:db|sqlite|sqlite3|mdf|ldf|accdb|dbf)(?=$|[\s"';|&])/i

/** 系统级高危：注册表、关机重启、强杀进程。 */
const SYSTEM_BLOCKERS: RegExp[] = [
  /\breg\s+delete\s+hk/i,
  /\bshutdown\b/i,
  /\breboot\b/i,
  /\btaskkill\b[\s\S]*\/f\b/i,
  /\bnet\s+user\b[\s\S]*\/delete\b/i
]

/** git 破坏性操作：不删仓库，但会不可逆地丢弃历史/改动。 */
const GIT_HARD: RegExp[] = [
  /\bgit\s+push\b[\s\S]*--force(?:-with-lease)?\b/i,
  /\bgit\s+push\b[\s\S]*\s-f(?:\s|$)/i,
  /\bgit\s+reset\b[\s\S]*--hard\b/i,
  /\bgit\s+clean\b[\s\S]*-[a-z]*f/i,
  /\bgit\s+branch\b[\s\S]*\s-D\b/,
  /\bgit\s+filter-branch\b/i,
  /\bgit\s+reflog\s+expire\b/i
]

function blocked(category: SafetyCategory, reason: string): SafetyVerdict {
  return { tier: 'blocked', category, reason, autoApprovable: false }
}

function hard(category: SafetyCategory, reason: string): SafetyVerdict {
  return { tier: 'hard', category, reason, autoApprovable: false }
}

function soft(category: SafetyCategory, reason?: string, autoApprovable = true): SafetyVerdict {
  return { tier: 'soft', category, reason, autoApprovable }
}

function auto(category: SafetyCategory, reason?: string): SafetyVerdict {
  return { tier: 'auto', category, reason, autoApprovable: true }
}

/** 命令首词是解释器或数据库客户端时，引号内是「要执行的代码」，不能剥离。 */
const QUOTED_CODE_HOSTS =
  /^(?:mysql|mariadb|psql|sqlite3?|sqlcmd|osql|mongo|mongosh|redis-cli|powershell|pwsh|cmd|bash|sh|zsh|perl|ruby|php|python|python3|node)\b/i

/** 去掉引号内的普通文本，避免 `git commit -m "drop database"` 这类提交信息误触发红线。 */
function stripQuotedText(text: string): string {
  return text.replace(/"[^"]*"/g, '""').replace(/'[^']*'/g, "''").replace(/`[^`]*`/g, '``')
}

/** 命令文本是否触碰硬红线；命中即返回对应判定。 */
export function auditHardLines(command: string): SafetyVerdict | null {
  const cmd = command.trim()
  if (!cmd) return null

  const firstWord = cmd.split(/\s+/)[0] ?? ''
  const inspected = QUOTED_CODE_HOSTS.test(firstWord) ? cmd : stripQuotedText(cmd)

  for (const pattern of DISK_BLOCKERS) {
    if (pattern.test(inspected)) {
      return blocked('disk', '检测到磁盘格式化/分区/擦盘类操作：这是永久禁止的红线，任何模式下都不会执行。')
    }
  }

  // 设备写入：`echo x > /dev/sda`，即使目标被引号包住也要拦
  if (/>\s*["']?\/dev\/(?:sd|hd|nvme|vd|disk)/i.test(cmd)) {
    return blocked('disk', '检测到直接写入磁盘设备：这是永久禁止的红线，任何模式下都不会执行。')
  }

  // 根目录/整盘递归删除
  if (DELETE_VERB.test(inspected) && ROOT_WIPE_TARGET.test(inspected)) {
    return blocked('disk', '检测到对根目录或整盘的通配删除：这是永久禁止的红线，任何模式下都不会执行。')
  }

  // .git 仓库删除/移动
  if ((DELETE_VERB.test(inspected) || MOVE_VERB.test(inspected)) && GIT_DIR_TOKEN.test(inspected)) {
    return hard('git', '检测到删除或移动 .git 仓库目录：会丢失全部提交历史，必须你本人手工确认。')
  }

  for (const pattern of GIT_HARD) {
    if (pattern.test(inspected)) {
      return hard('git', '检测到重写 git 历史或丢弃工作区改动的操作（强推/硬重置/强制清理/删分支），必须人工确认。')
    }
  }

  for (const pattern of DB_BLOCKERS) {
    if (pattern.test(inspected)) {
      return hard('database', '检测到删库/清表/删除表结构类操作，必须人工确认。')
    }
  }

  // 无 WHERE 的 DELETE：整表清空，按删库同级处理
  if (/\bdelete\s+from\b/i.test(inspected) && !/\bwhere\b/i.test(inspected)) {
    return hard('database', '检测到没有 WHERE 条件的 DELETE（会清空整张表），必须人工确认。')
  }

  // 删除/移动数据库文件
  if ((DELETE_VERB.test(inspected) || MOVE_VERB.test(inspected)) && DB_FILE.test(inspected)) {
    return hard('database', '检测到删除或移动数据库文件，必须人工确认。')
  }

  for (const pattern of SYSTEM_BLOCKERS) {
    if (pattern.test(inspected)) {
      return hard('system', '检测到注册表/关机重启/强制结束进程等系统级高危操作，必须人工确认。')
    }
  }

  return null
}

/** 文件工具的目标是否落在工作区内（含 realpath 检查，防 junction 逃逸）。 */
function pathInsideWorkspace(workingDirectory: string | null, rawPath: string): boolean {
  if (!workingDirectory || !rawPath.trim()) return false
  const target = isAbsolute(rawPath) ? rawPath : resolve(workingDirectory, rawPath)
  return isPathInsideResolved(workingDirectory, target)
}

function workspaceWriteVerdict(rawPath: string, ctx: SafetyContext): SafetyVerdict {
  if (!rawPath.trim()) return soft('workspace', '缺少目标路径。')
  if (!pathInsideWorkspace(ctx.workingDirectory, rawPath)) {
    return soft('workspace', '目标在工作区之外，需要你确认。', ctx.autonomy === 'trusted')
  }
  if (ctx.autonomy === 'strict') {
    return soft('workspace', '当前为严格模式：工作区内写入也需要确认。')
  }
  return auto('workspace', '工作区内写入。')
}

/** 递归删除的写法：rm -rf、rd /s、Remove-Item -Recurse、del /s。 */
const RECURSIVE_DELETE =
  /(?:\brm\s+[^\n]*-(?:[a-z]*r[a-z]*)\b|\b(?:rd|rmdir)\s+\/s\b|\bremove-item\b[^\n]*-recurse\b|\bdel\b[^\n]*\/s\b)/i

function commandVerdict(command: string, cwd: string | null, ctx: SafetyContext): SafetyVerdict {
  const cmd = command.trim()
  if (!cmd) return soft('workspace', '空命令。')

  if (touchesPrivateData(cmd)) {
    return blocked('private-data', '命令触碰应用私有数据（密钥库/会话数据库），永久拒绝。')
  }

  const hardLine = auditHardLines(cmd)
  if (hardLine) return hardLine

  // 递归删除工作区外的绝对路径：即使「完全信任」也必须确认。
  // 根目录/整盘删除已在上面的硬红线里永久拒绝，这里兜住 C:\Users 这类系统目录。
  if (RECURSIVE_DELETE.test(cmd)) {
    const targets = cmd.match(/[a-z]:[\\/][^\s"';&|]*/gi) ?? []
    const outside = targets.some(
      (target) => !ctx.workingDirectory || !isPathInsideResolved(ctx.workingDirectory, target)
    )
    if (outside) {
      return hard('system', '检测到递归删除工作区外的绝对路径，可能破坏系统目录，必须人工确认。')
    }
  }

  const baseDir = cwd || ctx.workingDirectory
  const inside =
    !!baseDir &&
    commandStaysInsideWorkspace(cmd, baseDir) &&
    (!ctx.workingDirectory || isPathInsideResolved(ctx.workingDirectory, baseDir))

  if (!inside) {
    return soft('workspace', '命令超出工作区边界或不在安全白名单内，需要你确认。', ctx.autonomy === 'trusted')
  }
  if (ctx.autonomy === 'strict') {
    return soft('workspace', '当前为严格模式：工作区内命令也需要确认。')
  }
  return auto('workspace', '工作区内的安全命令。')
}

/**
 * 对一次工具调用做安全分级。
 *
 * 注意：这里返回 `auto` 只代表「策略上允许免确认」，不代表工具一定成功；
 * 工具层仍会独立做私有数据与 CRITICAL 命令拦截。
 */
export function classifyToolCall(
  toolName: string,
  input: unknown,
  ctx: SafetyContext
): SafetyVerdict {
  if (READ_ONLY_TOOLS.has(toolName)) return auto('read', '只读操作。')

  const record = (input ?? {}) as Record<string, unknown>

  if (toolName === 'write_file' || toolName === 'patch_file' || toolName === 'multi_patch_file') {
    return workspaceWriteVerdict(typeof record.path === 'string' ? record.path : '', ctx)
  }

  if (toolName === 'run_command') {
    const command = typeof record.command === 'string' ? record.command : ''
    const rawCwd = typeof record.cwd === 'string' && record.cwd.trim() ? record.cwd : ''
    const cwd = rawCwd
      ? isAbsolute(rawCwd)
        ? resolve(rawCwd)
        : resolve(ctx.workingDirectory ?? process.cwd(), rawCwd)
      : null
    return commandVerdict(command, cwd, ctx)
  }

  // 外部 CLI / MCP / 键鼠控制：能力边界由外部进程决定，永不自动放行。
  if (toolName.startsWith('mcp__') || /^(?:qoder|codex|claude)_ask$/.test(toolName)) {
    return soft('external', '将调用外部进程或服务，能力由其自身决定，需要你确认。', false)
  }
  if (toolName.startsWith('computer_')) {
    return soft('external', '将直接操控本机鼠标键盘，需要你确认。', false)
  }

  return soft('system', '未知工具，按需要确认处理。')
}

/** 该判定是否允许在本轮直接执行，不再弹确认。 */
export function isAutoAllowed(verdict: SafetyVerdict, autonomy: AutonomyLevel): boolean {
  if (verdict.tier === 'blocked' || verdict.tier === 'hard') return false
  if (verdict.tier === 'auto') return true
  if (!verdict.autoApprovable) return false
  if (autonomy === 'trusted') return true
  if (autonomy === 'balanced' && verdict.category === 'workspace') return true
  return false
}
