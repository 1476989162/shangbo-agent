import { isAbsolute, resolve } from 'node:path'
import type { AgentMode, Conversation } from '../../shared/types'
import type { IntentResult } from './intent'
import {
  commandStaysInsideWorkspace,
  isPathAutoApprovable,
  isPathInside,
  isPathInsideResolved,
  touchesPrivateData
} from './commandGuard'

export interface WishModeSettings {
  wishEnabled: boolean
  autoApproveWorkspace: boolean
  defaultMode: string
}

/**
 * 会话实际生效的模式。
 *
 * `auto` 是智能模式：按本轮自然语言判定 chat / builder / wish。
 * 判定结果由 runtime 传入，保证「主循环看到的模式」与「工具放行用的模式」
 * 是同一个，不会出现提示词说许愿、审批却按建造者走的分裂。
 */
export function resolveAgentMode(
  conversationMode: Conversation['mode'],
  settings: WishModeSettings,
  intent?: IntentResult | null
): AgentMode {
  const declared = conversationMode ?? settings.defaultMode
  let resolved: AgentMode
  if (declared === 'auto') {
    resolved = intent?.mode ?? 'builder'
  } else if (declared === 'chat' || declared === 'builder' || declared === 'wish') {
    resolved = declared
  } else {
    resolved = 'builder'
  }
  if (resolved === 'wish' && !settings.wishEnabled) return 'builder'
  return resolved
}

export function isWishModeActive(
  conversationMode: Conversation['mode'],
  settings: WishModeSettings,
  intent?: IntentResult | null
): boolean {
  return settings.wishEnabled && resolveAgentMode(conversationMode, settings, intent) === 'wish'
}

/**
 * 许愿模式的“工作区内免审批”。
 *
 * 这不是无限制放行：只对读写类工具与工作区内的命令生效；密钥库、数据库、
 * 工作区外绝对路径、目录穿越与环境变量逃逸仍会落回审批或直接被工具层拒绝。
 */
export function isWishAutoApproved(
  toolName: string,
  input: unknown,
  wishActive: boolean,
  autoApproveWorkspace: boolean,
  workingDirectory: string | null
): boolean {
  if (!autoApproveWorkspace) return false
  if (!wishActive) return false
  if (!workingDirectory) return false

  if (toolName === 'write_file' || toolName === 'patch_file' || toolName === 'read_file') {
    const rawPath = (input as { path?: unknown } | null)?.path
    if (typeof rawPath !== 'string' || !rawPath.trim()) return false
    return isPathAutoApprovable(workingDirectory, rawPath)
  }

  if (toolName === 'run_command') {
    const record = (input ?? {}) as { command?: unknown; cwd?: unknown }
    if (typeof record.command !== 'string' || !record.command.trim()) return false
    const cwd = typeof record.cwd === 'string' && record.cwd.trim() ? record.cwd : workingDirectory
    const resolvedCwd = isAbsolute(cwd) ? resolve(cwd) : resolve(workingDirectory, cwd)
    if (!isPathInside(workingDirectory, resolvedCwd)) return false
    if (!isPathInsideResolved(workingDirectory, resolvedCwd)) return false
    return (
      commandStaysInsideWorkspace(record.command, resolvedCwd) &&
      !touchesPrivateData(record.command)
    )
  }

  return false
}

/** 从 `mcp__服务__工具` 取服务 id；非法命名返回 null（与 manager 同规则，但不引入其依赖）。 */
export function mcpServerIdOf(toolName: string): string | null {
  if (!toolName.startsWith('mcp__')) return null
  const parts = toolName.slice('mcp__'.length).split('__')
  if (parts.length < 2 || !parts[0] || parts.slice(1).some((p) => !p)) return null
  return parts[0]
}

/**
 * 许愿模式下 MCP 工具能否免审批。
 *
 * 与本地工具的区别：MCP 的能力边界由外部服务进程决定，无法按「路径在工作区内」判断，
 * 只能按服务粒度白名单放行。
 *
 * - allowMcp 关闭：许愿模式完全不调 MCP（回到旧行为）。
 * - autoApproveServers 为空：全部已启用服务免审批。许愿模式按无人值守设计，
 *   弹窗只会空转 5 分钟后按拒绝处理，等价于「不能用」；要逐个确认请切回建造者模式。
 * - autoApproveServers 非空：只有列出的服务免审批，其余服务直接拒绝并提示。
 */
export function isWishMcpAutoApproved(
  toolName: string,
  wishActive: boolean,
  allowMcp: boolean,
  autoApproveServers: readonly string[]
): boolean {
  if (!wishActive || !allowMcp) return false
  const serverId = mcpServerIdOf(toolName)
  if (!serverId) return false
  if (autoApproveServers.length === 0) return true
  return autoApproveServers.includes(serverId)
}
