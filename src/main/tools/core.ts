import { app } from 'electron';
import { basename, isAbsolute, resolve } from 'node:path';

export interface ToolContext {
  conversationId: string
  /** 当前回合 id；todo_write 用它隔离同一会话内的不同运行。 */
  runId: string
  /**
   * 对话绑定的项目目录。相对路径基于它解析；未绑定时相对路径基于应用启动目录。
   * run_command 也把它作为默认工作目录。
   */
  workingDirectory: string | null
  signal: AbortSignal
}

/** 工具模块之间共享的最小能力接口，避免互相 import index 形成循环依赖。 */
export interface ToolHost {
  resolveUserPath(context: ToolContext, path: string): string
  guardPrivatePath(target: string): void
  truncate(text: string): string
}

/**
 * 解析用户/模型给出的路径：绝对路径原样使用；
 * 相对路径优先基于对话的项目目录，未绑定时退回进程当前目录。
 */
export function resolveUserPath(context: ToolContext, path: string): string {
  if (isAbsolute(path)) return path
  return context.workingDirectory ? resolve(context.workingDirectory, path) : resolve(path)
}

/** 工具执行结果：纯文本工具直接返回 string，只有截图这类才用对象带图。 */
export interface ToolResult {
  content: string
  isError: boolean
  image?: { mimeType: string; dataUrl: string }
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
  execute(input: unknown, context: ToolContext): Promise<string | ToolResult>
}

/** 单次工具输出上限，避免一次目录列举就把上下文撑爆。 */
const MAX_OUTPUT_CHARS = 16_000

export function truncate(text: string): string {
  if (text.length <= MAX_OUTPUT_CHARS) return text
  return `${text.slice(0, MAX_OUTPUT_CHARS)}\n\n…（输出过长已截断，共 ${text.length} 字符）`
}
export function describeError(error: unknown): string {
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
 *
 * 单测等无 Electron app 环境下，app.getPath 会抛错：此时按文件名兜底，
 * 只要目标文件名命中私有前缀同样拦截，保证防护在任何环境不断线。
 */
export function safeUserDataPath(): string | null {
  try {
    return app.getPath('userData')
  } catch {
    return null
  }
}

const PRIVATE_FILE_PREFIXES = ['secrets.json', 'shangbo-agent.db']

export function guardPrivatePath(target: string): void {
  const normalized = resolve(target).toLowerCase()
  // 文件名兜底：无 app 环境或路径不在 userData 下时，命中私有文件名同样拦截
  const base = basename(normalized)
  if (PRIVATE_FILE_PREFIXES.some((prefix) => base === prefix || base.startsWith(`${prefix}-`) || base.startsWith(`${prefix}.`))) {
    throw new Error(
      `禁止访问应用私有数据：${target}。该位置存放密钥与数据库，不作为工具的读取或写入对象。`
    )
  }
  let userData: string | null = null
  try {
    userData = typeof app?.getPath === 'function' ? safeUserDataPath() : null
  } catch {
    userData = null
  }
  // 拿不到应用数据目录时已由文件名兜底覆盖常见旁路；此处不再直接放行判断，
  // 目录级精确匹配仅作为补充（userData 可用时）。
  if (!userData) return
  // Windows 文件系统大小写不敏感，比较时统一转小写，避免 Secrets.JSON 类旁路。
  // 私有文件前缀：密钥库与会话数据库（含 -wal/-shm/-journal 伴生文件与 .tmp/.bak 临时文件）。
  // secrets.json.tmp 是 secrets.ts 原子写入的中间文件，同样含密钥
  for (const name of PRIVATE_FILE_PREFIXES) {
    const lower = resolve(userData, name).toLowerCase()
    if (normalized === lower || normalized.startsWith(`${lower}-`) || normalized.startsWith(`${lower}.`)) {
      throw new Error(
        `禁止访问应用私有数据：${resolve(userData, name)}。该位置存放密钥与数据库，不作为工具的读取或写入对象。`
      )
    }
  }
}
