import { isAbsolute, resolve } from 'node:path'
import type { Conversation } from '../../shared/types'
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

/** 许愿模式是否生效：总开关关闭时，已标记为 wish 的会话也按建造者处理。 */
export function resolveAgentMode(
  conversationMode: Conversation['mode'],
  settings: WishModeSettings
): string {
  if (conversationMode === 'wish' && !settings.wishEnabled) return 'builder'
  return conversationMode ?? settings.defaultMode
}

export function isWishModeActive(
  conversationMode: Conversation['mode'],
  settings: WishModeSettings
): boolean {
  return settings.wishEnabled && resolveAgentMode(conversationMode, settings) === 'wish'
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
