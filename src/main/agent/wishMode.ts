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
