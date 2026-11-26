import { exec } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { promisify } from 'node:util';
import { z } from 'zod';
import { analyzeCmdCommand, classifyDestructiveCommand } from '../agent/commandGuard';
import {
  describeError,
  guardPrivatePath,
  resolveUserPath,
  safeUserDataPath,
  truncate,
  type ToolContext,
  type ToolDefinition
} from './core';

const execAsync = promisify(exec);

/** 工作区顶层条目数；目录不存在或无权限时返回 null（删除命令的保险丝用）。 */
function countTopLevelEntries(dir: string | undefined): number | null {
  if (!dir) return null
  try {
    return readdirSync(dir).length
  } catch {
    return null
  }
}

/**
 * Freebuff 级系统命令安全审计与护栏规则库
 * 检测毁灭性擦盘、格式化、删库、系统密码影子文件读取等高危操作
 */
export interface SecurityAuditResult {
  isDangerous: boolean
  severity?: 'CRITICAL' | 'HIGH' | 'MEDIUM'
  reason?: string
}

/**
 * 擦盘级目标：根目录 / 家目录 / 盘符根 / 裸通配符，允许引号包裹。
 * 目标后必须紧跟命令边界（空白、;、&、|、引号或结尾）——否则 `rm -rf ./dist`、
 * `rm -rf *.log`、`del /q *.tmp` 这类删除子路径的日常命令会被整个拦死。
 * 盘符不限 C 盘：`rd /s /q D:\` 同样是擦整盘。
 */
const WIPE_TARGET = String.raw`(\/|\/\*|\\\*|~\/?\*?|\$home\/?\*?|%home%|\.\/?|\*|[a-z]:[\\/]\*?)`
const CMD_BOUNDARY = String.raw`(\s|$|[;&|"'])`

const RM_ROOT_RE = new RegExp(
  String.raw`rm\s+(-[a-z]+\s+)*-[a-z]*r[a-z]*\s+["']?` + WIPE_TARGET + CMD_BOUNDARY,
  'i'
)
const RD_ROOT_RE = new RegExp(
  String.raw`(rd|rmdir)\s+\/s(\s+\/[a-z]+)*\s+["']?([a-z]:[\\/]\*?|\\)["']?` + CMD_BOUNDARY,
  'i'
)
const DEL_ROOT_RE = new RegExp(
  String.raw`del(\s+\/[a-z]+)+\s+["']?([a-z]:[\\/]\*?|\*)["']?` + CMD_BOUNDARY,
  'i'
)
// Remove-Item 的 -Recurse 与根路径无论先后顺序都算擦盘，各覆盖一个方向
const RMITEM_RECURSE_FIRST_RE = new RegExp(
  String.raw`remove-item\s+.*-recurse.*\s+["']?` + WIPE_TARGET + CMD_BOUNDARY,
  'i'
)
const RMITEM_PATH_FIRST_RE = new RegExp(
  String.raw`remove-item\s+["']?` + WIPE_TARGET + String.raw`["']?` + CMD_BOUNDARY + String.raw`.*-recurse`,
  'i'
)

export function auditCommandSecurity(cmd: string, workspace?: string | null): SecurityAuditResult {
  const trimmed = cmd.trim().toLowerCase()

  // cmd 语义兜底：`;` 不是分隔符；工作区根/上级目录/多个递归目标。
  const destructive = classifyDestructiveCommand(cmd, workspace)
  if (destructive) {
    return {
      isDangerous: true,
      severity: destructive.tier === 'blocked' ? 'CRITICAL' : 'HIGH',
      reason: destructive.reason
    }
  }

  // 1. 全盘或根目录致命清除命令
  if (
    RM_ROOT_RE.test(trimmed) ||
    RD_ROOT_RE.test(trimmed) ||
    DEL_ROOT_RE.test(trimmed) ||
    RMITEM_RECURSE_FIRST_RE.test(trimmed) ||
    RMITEM_PATH_FIRST_RE.test(trimmed)
  ) {
    return {
      isDangerous: true,
      severity: 'CRITICAL',
      reason: 'Freebuff 安全红线：检测到试图全局递归清除磁盘/根目录的高危破坏性命令！'
    }
  }
  // 2. 磁盘分区、格式化与引导破坏
  if (
    /format\s+[a-z]:/i.test(trimmed) ||
    /diskpart/i.test(trimmed) ||
    /mkfs(\s|\.)/i.test(trimmed) ||
    /bcdedit\s+\/delete/i.test(trimmed) ||
    /vssadmin\s+delete/i.test(trimmed) ||
    /cipher\s+\/w:/i.test(trimmed)
  ) {
    return {
      isDangerous: true,
      severity: 'CRITICAL',
      reason: 'Freebuff 安全红线：检测到磁盘格式化、重分区或引导/卷影破坏命令！'
    }
  }
  // 3. 生产数据库全库清除
  if (/drop\s+database/i.test(trimmed) || /truncate\s+table/i.test(trimmed)) {
    return {
      isDangerous: true,
      severity: 'HIGH',
      reason: 'Freebuff 安全红线：检测到数据库删库/清空表的高危破坏性操作！'
    }
  }
  // 3b. 注册表破坏
  if (/reg\s+delete\s+hk/i.test(trimmed)) {
    return {
      isDangerous: true,
      severity: 'HIGH',
      reason: 'Freebuff 安全护栏：检测到注册表删除操作！'
    }
  }
  // 4. 窃取系统级秘密凭据
  if (
    /system32\\config\\sam/i.test(trimmed) ||
    /cat\s+\/etc\/(shadow|gshadow)/i.test(trimmed) ||
    /\.ssh[\\\/]id_rsa/i.test(trimmed)
  ) {
    return {
      isDangerous: true,
      severity: 'HIGH',
      reason: 'Freebuff 安全护栏：检测到尝试读取系统敏感密钥或影子凭据文件！'
    }
  }
  return { isDangerous: false }
}

/** 把正则元字符转义，用于把动态字符串（目录名）安全拼进正则。 */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * 命令字符串是否触碰应用私有数据（密钥库/会话数据库）。
 * guardPrivatePath 只拦文件类工具的路径参数；run_command 的 command/cwd 是
 * 自由字符串，`type secrets.json`、`type %APPDATA%\shangbo-agent\secr*` 这类
 * 读法必须在这里拦，否则密钥进上下文。
 */
export function commandTouchesPrivateData(command: string, cwd?: string): boolean {
  const lowered = command.toLowerCase()
  // 命令文本含私有文件名（大小写不敏感）即命中
  if (lowered.includes('secrets.json') || lowered.includes('shangbo-agent.db')) return true
  const userData = safeUserDataPath()
  if (userData) {
    const normalizedCmd = command.replace(/\//g, '\\').toLowerCase()
    const normalizedUserData = userData.replace(/\//g, '\\').toLowerCase()
    // userData 绝对路径出现在命令里（读/写/删库文件都算触碰）
    if (normalizedCmd.includes(normalizedUserData)) return true
    const dirName = basename(normalizedUserData)
    if (dirName) {
      const escaped = escapeRegExp(dirName)
      // 目录名出现在「路径上下文」里（前是分隔符或开头，后是分隔符或结尾）才算指向
      // 应用数据目录。不能裸匹配整个单词：`npm test -- shangbo-agent` 这类同名参数、
      // `git clone .../shangbo-agent.git` 这类仓库名都会被误伤
      const dirInPath = new RegExp(`(^|\\\\)${escaped}(\\\\|$)`)
      if (dirInPath.test(normalizedCmd)) return true
      // 目录名被通配符打断的旁路（`type %APPDATA%\shangbo*\secr*`）：
      // 「环境变量展开特征」与「私有文件的通配形态」同时出现才拦，
      // 单独出现 %APPDATA% 或 *.json 不至于误伤普通命令
      const envExpand = /(%appdata%|%localappdata%|\$env:appdata|\$env:localappdata|appdata\\(roaming|local))/
      const privateWildcard = new RegExp(`(secr\\w*[*?])|([*?]\\.db)|(\\\\${escaped}\\w*[*?])`)
      if (envExpand.test(normalizedCmd) && privateWildcard.test(normalizedCmd)) return true
    }
  }
  if (cwd) {
    if (userData) {
      const normalizedUserData = userData.replace(/\//g, '\\').toLowerCase()
      const resolvedCwd = resolve(cwd).replace(/\//g, '\\').toLowerCase()
      // cwd 落在 userData 目录下（含它本身）就拒绝：
      // 目录名不叫 secrets.json，文件名兜底拦不住，在里面执行 `type secret*` 即可读到密钥
      if (resolvedCwd === normalizedUserData || resolvedCwd.startsWith(`${normalizedUserData}\\`)) {
        return true
      }
    }
    // cwd 恰好指向私有文件本身时，复用文件级防护
    try {
      guardPrivatePath(resolve(cwd))
    } catch {
      return true
    }
  }
  return false
}

export const runCommand: ToolDefinition = {
  name: 'run_command',
  description:
    '执行 shell 命令并返回标准输出与错误输出，默认工作目录是当前项目目录。Windows 下固定使用 cmd.exe：多条命令用 && 连接，不要用 ;；删除类命令只写一个目标。适合运行构建、测试、git 等命令，不要用于长时间驻留的交互式程序。',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的命令' },
      cwd: { type: 'string', description: '工作目录，缺省为当前项目目录' },
      timeoutMs: { type: 'integer', description: '超时毫秒数，默认 60000，最大 300000' }
    },
    required: ['command']
  },
  requiresApproval: true,
  approvalReason: '将在你的本机执行命令，命令可以读取、修改或删除文件。',
  async execute(input, context) {
    const { command, cwd, timeoutMs } = z
      .object({
        command: z.string().min(1),
        cwd: z.string().optional(),
        timeoutMs: z.number().int().positive().max(300_000).optional()
      })
      .parse(input)

    const resolvedCwd = cwd ? resolveUserPath(context, cwd) : context.workingDirectory ?? undefined
    const analysis = analyzeCmdCommand(command)

    // cmd 与 POSIX 的语法差异是 2026-11-04 事故的根因：`;` 在 cmd 里不是分隔符，
    // 会把后面的路径变成 rmdir/del 的额外目标。这里直接拒绝，要求模型改写。
    if (process.platform === 'win32' && analysis.posixSemicolon) {
      throw new Error('当前 shell 是 cmd.exe，不支持 `;`。请用 `&&` 连接多条命令，或分两次调用。')
    }

    // 工作区根目录/上级目录/多个递归目标：工具层自保，直接拒绝。
    // hard 级（工作区外、多个目标）交给 runtime 审批，不在工具层拦。
    for (const root of new Set([context.workingDirectory, resolvedCwd])) {
      if (!root) continue
      const destructive = classifyDestructiveCommand(command, root)
      if (destructive?.tier === 'blocked') {
        throw new Error(destructive.reason)
      }
    }

    // 工具层自保：私有目录与 CRITICAL 级命令在执行前直接拦截，不依赖调用方是否记得审计。
    // HIGH 级（drop database 等）由 runtime 弹窗审批——用户批准后可执行，
    // 这里再拦就会出现「批准了却执行不了」的自相矛盾。
    // 抛错走工具错误通道（调用方展示给模型/用户），不进 exec。
    if (commandTouchesPrivateData(command, resolvedCwd)) {
      throw new Error(
        '禁止访问应用私有数据：该命令触碰存放密钥与数据库的位置，不作为工具的执行对象。'
      )
    }
    const audit = auditCommandSecurity(command, resolvedCwd)
    if (audit.isDangerous && audit.severity === 'CRITICAL') {
      throw new Error(audit.reason ?? '【Freebuff 安全护栏拦截】检测到高危系统级操作！')
    }

    // 删除类命令执行前记下工作区顶层条目数；执行后若被清空，触发保险丝。
    const beforeCount = analysis.destructive ? countTopLevelEntries(resolvedCwd) : null

    // 有意设计：命令失败不抛异常，而是把退出码、stdout、stderr 作为正常观察结果回给模型。
    // 命令失败（在不存在的目录里执行、测试没通过、某个工具没装）是探索过程的常态，
    // 模型需要读到真实报错才能自己纠正下一步；若在这里抛出，整轮工具链会被中断，
    // 模型只能看到一句"工具执行失败"，反而失去了自救的依据。
    let result: string
    try {
      const execOptions = {
        cwd: resolvedCwd,
        timeout: timeoutMs ?? 60_000,
        maxBuffer: 8 * 1024 * 1024,
        signal: context.signal,
        windowsHide: true,
        ...(process.platform === 'win32' ? { shell: process.env.ComSpec || 'cmd.exe' } : {})
      }
      const { stdout, stderr } = await execAsync(command, execOptions)
      const parts = [`$ ${command}`]
      if (stdout.trim()) parts.push(`--- 标准输出 ---\n${stdout.trim()}`)
      if (stderr.trim()) parts.push(`--- 标准错误 ---\n${stderr.trim()}`)
      if (parts.length === 1) parts.push('（命令执行成功，没有输出）')
      result = truncate(parts.join('\n\n'))
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; code?: number }
      const parts = [`$ ${command}`, `--- 执行失败（退出码 ${failure.code ?? '未知'}）---`]
      if (failure.stdout?.trim()) parts.push(failure.stdout.trim())
      if (failure.stderr?.trim()) parts.push(failure.stderr.trim())
      if (parts.length === 2) parts.push(describeError(error))
      result = truncate(parts.join('\n\n'))
    }

    if (analysis.destructive && beforeCount !== null) {
      const afterCount = countTopLevelEntries(resolvedCwd)
      if (afterCount === null || (beforeCount > 0 && afterCount === 0)) {
        return {
          content: `⚠️ 安全保险丝：执行删除命令后，工作区 ${resolvedCwd ?? '(未绑定)'} 的顶层条目从 ${beforeCount} 变为 ${afterCount === null ? '不可访问' : '0'}。\n命令：${command}\n\n请立即检查工作区并从备份恢复，不要再执行任何删除/写入操作。`,
          isError: true
        }
      }
    }

    return result
  }
}
