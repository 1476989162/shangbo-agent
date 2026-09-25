import { exec } from 'node:child_process'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { promisify } from 'node:util'
import { z } from 'zod'

const execAsync = promisify(exec)

export interface ToolContext {
  conversationId: string
  signal: AbortSignal
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
  description: '列出本机某个目录下的文件与子目录。用于了解项目结构或查找文件位置。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '目录的绝对路径' }
    },
    required: ['path']
  },
  requiresApproval: false,
  async execute(input) {
    const { path } = z.object({ path: z.string().min(1) }).parse(input)
    const target = resolve(path)
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
  description: '读取本机文本文件的内容。读取前建议先用 list_directory 确认路径。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件的绝对路径' },
      maxBytes: { type: 'integer', description: '最多读取的字节数，默认 262144' }
    },
    required: ['path']
  },
  requiresApproval: false,
  async execute(input) {
    const { path, maxBytes } = z
      .object({ path: z.string().min(1), maxBytes: z.number().int().positive().optional() })
      .parse(input)

    const target = resolve(path)
    const limit = maxBytes ?? 262_144
    const info = await stat(target)
    const buffer = await readFile(target)
    const slice = buffer.subarray(0, limit)

    const notice =
      buffer.length > limit ? `\n\n…（文件共 ${buffer.length} 字节，仅读取前 ${limit} 字节）` : ''
    return truncate(`${target}（${info.size} 字节）：\n\n${slice.toString('utf8')}${notice}`)
  }
}

const writeFileTool: ToolDefinition = {
  name: 'write_file',
  description: '把内容写入本机文件，目录不存在时会自动创建。会覆盖同名文件原有内容。',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: '文件的绝对路径' },
      content: { type: 'string', description: '要写入的完整内容' }
    },
    required: ['path', 'content']
  },
  requiresApproval: true,
  approvalReason: '将在你的本机磁盘上写入文件，可能覆盖已有内容。',
  async execute(input) {
    const { path, content } = z
      .object({ path: z.string().min(1), content: z.string() })
      .parse(input)

    const target = resolve(path)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, content, 'utf8')
    return `已写入 ${target}（${Buffer.byteLength(content, 'utf8')} 字节）`
  }
}

const runCommand: ToolDefinition = {
  name: 'run_command',
  description:
    '在本机执行 shell 命令并返回标准输出与错误输出。适合运行构建、测试、git 等命令，不要用于长时间驻留的交互式程序。',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: '要执行的命令' },
      cwd: { type: 'string', description: '工作目录，缺省为当前目录' },
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

    try {
      const { stdout, stderr } = await execAsync(command, {
        cwd: cwd ? resolve(cwd) : undefined,
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