import { exec } from 'node:child_process'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, resolve } from 'node:path'
import { promisify } from 'node:util'
import { app } from 'electron'
import { z } from 'zod'

const execAsync = promisify(exec)

export interface ToolContext {
  conversationId: string
  /**
   * 对话绑定的项目目录。相对路径基于它解析；未绑定时相对路径基于应用启动目录。
   * run_command 也把它作为默认工作目录。
   */
  workingDirectory: string | null
  signal: AbortSignal
}

/**
 * 解析用户/模型给出的路径：绝对路径原样使用；
 * 相对路径优先基于对话的项目目录，未绑定时退回进程当前目录。
 */
function resolveUserPath(context: ToolContext, path: string): string {
  if (isAbsolute(path)) return path
  return context.workingDirectory ? resolve(context.workingDirectory, path) : resolve(path)
}

export interface ToolDefinition {
  name: string
  description: string
  /** 传给模型的 JSON Schema（由各工具手写，便于精确控制描述文案）。 */
  parameters: Record<string, unknown>
  /** 高危工具必须经用户确认后才执行。 */
  requiresApproval: boolean
  /** 展示在确认弹窗里的风险说明。 */
  approvalReason?: string
  execute(input: unknown, context: ToolContext): Promise<string>
}

/** 单次工具输出上限，避免一次目录列举就把上下文撑爆。 */
const MAX_OUTPUT_CHARS = 16_000

function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n\n…（输出过长已截断，共 ${text.length} 字符）`
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/* ------------------------------------------------------------------ */
/* 私有目录保护                                                          */
/* ------------------------------------------------------------------ */

/**
 * userData 下存放着加密后的 API Key（secrets.json）和会话数据库，
 * 属于应用自身的数据而非用户的普通文件。模型一旦读到密钥库，
 * 注入指令就能把密钥带进对话上下文发往任意供应商——审批拦不住"读"，
 * 所以这里直接禁止文件类工具触碰。
 */
function guardPrivatePath(target: string): void {
  const userData = typeof app?.getPath === 'function' ? app.getPath('userData') : null
  if (!userData) return
  // db 的 -wal / -shm 伴生文件用前缀一并拦住
  const privatePaths = [resolve(userData, 'secrets.json'), resolve(userData, 'shangbo-agent.db')]
  const normalized = resolve(target)
  for (const forbidden of privatePaths) {
    if (normalized === forbidden || normalized.startsWith(`${forbidden}-`)) {
      throw new Error(
        `禁止访问应用私有数据：${forbidden}。该位置存放密钥与数据库，不作为工具的读取或写入对象。`
      )
    }
  }
}

/* ------------------------------------------------------------------ */

const getCurrentTime: ToolDefinition = {
  name: 'get_current_time',
  description: '获取当前的本地日期与时间。当用户询问「现在几点」「今天几号」或需要计算时间差时使用。',
  parameters: {
    type: 'object',
    properties: {
      timezone: {
        type: 'string',
        description: 'IANA 时区名，例如 Asia/Shanghai。留空则使用本机时区。'
      }
    },
    required: []
  },
  requiresApproval: false,
  async execute(input) {
    const { timezone } = z.object({ timezone: z.string().optional() }).parse(input ?? {})
    const now = new Date()
    const formatter = new Intl.DateTimeFormat('zh-CN', {
      dateStyle: 'full',
      timeStyle: 'long',
      timeZone: timezone || undefined
    })
    return `${formatter.format(now)}\nISO: ${now.toISOString()}\n时间戳: ${now.getTime()}`
  }
}

const listDirectory: ToolDefinition = {
  name: 'list_directory',
  description:
    '列出某个目录下的文件与子目录，用于了解项目结构或查找文件位置。支持相对路径（基于当前项目目录）与绝对路径。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '目录路径，相对路径基于项目目录解析' }
    },
    required: ['path']
  },
  requiresApproval: false,
  async execute(input, context) {
    const { path } = z.object({ path: z.string().min(1) }).parse(input)
    const target = resolveUserPath(context, path)
    guardPrivatePath(target)
    const entries = await readdir(target, { withFileTypes: true })

    const lines = await Promise.all(
      entries.slice(0, 500).map(async (entry) => {
        if (entry.isDirectory()) return `[目录] ${entry.name}/`
        try {
          const info = await stat(resolve(target, entry.name))
          return `[文件] ${entry.name}  ${info.size} 字节`
        } catch {
          return `[文件] ${entry.name}`
        }
      })
    )

    const suffix = entries.length > 500 ? `\n…（共 ${entries.length} 项，仅显示前 500 项）` : ''
    return truncate(`${target} 下共 ${entries.length} 项：\n${lines.join('\n')}${suffix}`)
  }
}

const readFileTool: ToolDefinition = {
  name: 'read_file',
  description: '读取文本文件的内容。支持相对路径（基于当前项目目录）与绝对路径。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径，相对路径基于项目目录解析' },
      maxBytes: { type: 'integer', description: '最多读取的字节数，默认 262144' }
    },
    required: ['path']
  },
  requiresApproval: false,
  async execute(input, context) {
    const { path, maxBytes } = z
      .object({ path: z.string().min(1), maxBytes: z.number().int().positive().optional() })
      .parse(input)

    const target = resolveUserPath(context, path)
    guardPrivatePath(target)
    const limit = maxBytes ?? 262_144
    const info = await stat(target)
    const buffer = await readFile(target)
    const slice = buffer.subarray(0, limit)

    // 二进制内容没有阅读价值，只会变成一大段乱码污染上下文
    let nullByteCount = 0
    for (const byte of slice) if (byte === 0) nullByteCount++
    if (nullByteCount > 0) {
      return `${target}（${info.size} 字节）：二进制文件，不提供文本内容。`
    }

    const notice =
      buffer.length > limit ? `\n\n…（文件共 ${buffer.length} 字节，仅读取前 ${limit} 字节）` : ''
    return truncate(`${target}（${info.size} 字节）：\n\n${slice.toString('utf8')}${notice}`)
  }
}

const writeFileTool: ToolDefinition = {
  name: 'write_file',
  description:
    '把内容写入文件，目录不存在时会自动创建，会覆盖同名文件原有内容。支持相对路径（基于当前项目目录）。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径，相对路径基于项目目录解析' },
      content: { type: 'string', description: '要写入的完整内容' }
    },
    required: ['path', 'content']
  },
  requiresApproval: true,
  approvalReason: '将在你的本机磁盘上写入文件，可能覆盖已有内容。',
  async execute(input, context) {
    const { path, content } = z
      .object({ path: z.string().min(1), content: z.string() })
      .parse(input)

    const target = resolveUserPath(context, path)
    guardPrivatePath(target)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content, 'utf8')
    return `已写入 ${target}（${Buffer.byteLength(content, 'utf8')} 字节）`
  }
}

/**
 * 局部精确替换工具 (对标 Cursor / Cline / Roo Code 核心代码编辑机制)
 * 避免为了修改几行代码而重写数百行整个文件，节省 90%+ 的 Token，彻底杜绝单次输出溢出截断。
 */
const patchFileTool: ToolDefinition = {
  name: 'patch_file',
  description:
    '对文本文件进行局部精确替换更新。修改现有代码时强烈优先使用此工具（而非 write_file 全量重写），只需在 targetContent 中提供待替换的一小段原代码（必须与文件中原内容逐字匹配），并在 replacementContent 中提供替换后的新代码。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件路径，相对路径基于项目目录解析' },
      targetContent: { type: 'string', description: '要被替换的原文本内容，必须在原文件中唯一存在且逐字匹配' },
      replacementContent: { type: 'string', description: '替换后的新文本内容' }
    },
    required: ['path', 'targetContent', 'replacementContent']
  },
  requiresApproval: true,
  approvalReason: '将对本地代码文件进行局部精确修改。',
  async execute(input, context) {
    const { path, targetContent, replacementContent } = z
      .object({
        path: z.string().min(1),
        targetContent: z.string(),
        replacementContent: z.string()
      })
      .parse(input)

    const target = resolveUserPath(context, path)
    guardPrivatePath(target)
    const raw = await readFile(target, 'utf8')
    if (!raw.includes(targetContent)) {
      throw new Error(`在文件 ${target} 中未找到指定的 targetContent。请先调用 read_file 确认目标文件的精确代码块后再重试。`)
    }
    const count = raw.split(targetContent).length - 1
    if (count > 1) {
      throw new Error(`在文件 ${target} 中匹配到 ${count} 处完全相同的内容，无法唯一定位。请在 targetContent 中包含更多上下文行以保证唯一性。`)
    }
    const updated = raw.replace(targetContent, replacementContent)
    await writeFile(target, updated, 'utf8')
    return `已成功对 ${target} 进行局部精确补丁更新。`
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

export function auditCommandSecurity(cmd: string): SecurityAuditResult {
  const trimmed = cmd.trim().toLowerCase()
  // 1. 全盘或根目录致命清除命令
  if (
    /rm\s+(-[a-z]*r[a-z]*f|-[a-z]*f[a-z]*r)\s+(\/|\\\*|\/\*|c:\\|c:\/\*|c:\\\*)/i.test(trimmed) ||
    /rmdir\s+\/s\s+\/q\s+(c:\\|c:\/|c:\\\*|\\)/i.test(trimmed) ||
    /del\s+\/f\s+\/s\s+\/q\s+(c:\\|c:\/|\*)/i.test(trimmed)
  ) {
    return {
      isDangerous: true,
      severity: 'CRITICAL',
      reason: 'Freebuff 安全红线：检测到试图全局递归清除磁盘/根目录的高危破坏性命令！'
    }
  }
  // 2. 磁盘分区与格式化
  if (/format\s+[a-z]:/i.test(trimmed) || /diskpart/i.test(trimmed) || /mkfs\./i.test(trimmed)) {
    return {
      isDangerous: true,
      severity: 'CRITICAL',
      reason: 'Freebuff 安全红线：检测到磁盘格式化或重分区高危命令！'
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

const runCommand: ToolDefinition = {
  name: 'run_command',
  description:
    '执行 shell 命令并返回标准输出与错误输出，默认工作目录是当前项目目录。适合运行构建、测试、git 等命令，不要用于长时间驻留的交互式程序。',
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

    // 有意设计：命令失败不抛异常，而是把退出码、stdout、stderr 作为正常观察结果回给模型。
    // 命令失败（在不存在的目录里执行、测试没通过、某个工具没装）是探索过程的常态，
    // 模型需要读到真实报错才能自己纠正下一步；若在这里抛出，整轮工具链会被中断，
    // 模型只能看到一句"工具执行失败"，反而失去了自救的依据。
    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: cwd ? resolveUserPath(context, cwd) : context.workingDirectory ?? undefined,
        timeout: timeoutMs ?? 60_000,
        maxBuffer: 8 * 1024 * 1024,
        signal: context.signal,
        windowsHide: true
      })
      const parts = [`$ ${command}`]
      if (stdout.trim()) parts.push(`--- 标准输出 ---\n${stdout.trim()}`)
      if (stderr.trim()) parts.push(`--- 标准错误 ---\n${stderr.trim()}`)
      if (parts.length === 1) parts.push('（命令执行成功，没有输出）')
      return truncate(parts.join('\n\n'))
    } catch (error) {
      const failure = error as { stdout?: string; stderr?: string; code?: number }
      const parts = [`$ ${command}`, `--- 执行失败（退出码 ${failure.code ?? '未知'}）---`]
      if (failure.stdout?.trim()) parts.push(failure.stdout.trim())
      if (failure.stderr?.trim()) parts.push(failure.stderr.trim())
      if (parts.length === 2) parts.push(describeError(error))
      return truncate(parts.join('\n\n'))
    }
  }
}

/* ------------------------------------------------------------------ */

const definitions: ToolDefinition[] = [
  getCurrentTime,
  listDirectory,
  readFileTool,
  writeFileTool,
  patchFileTool,
  runCommand
]

const byName = new Map(definitions.map((tool) => [tool.name, tool]))

export const toolRegistry = {
  all(): ToolDefinition[] {
    return definitions
  },

  get(name: string): ToolDefinition | undefined {
    return byName.get(name)
  },

  /** 传给模型的工具清单。 */
  schemas(): { name: string; description: string; parameters: Record<string, unknown> }[] {
    return definitions.map((tool) => ({
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters
    }))
  }
}