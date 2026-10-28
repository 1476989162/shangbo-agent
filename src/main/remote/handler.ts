import { z } from 'zod'
import * as repo from '../db/repo'
import { agentRuntime } from '../agent/runtime'
import {
  ALLOWED_REMOTE_OPS,
  parseRemoteRequest,
  type PendingApprovalInfo,
  type RemoteOp
} from '../../shared/remote'

/**
 * 阶段1：远程协议 handler——把协议请求映射到 repo 和 AgentRuntime。
 * 只开放白名单内的操作（ALLOWED_REMOTE_OPS），不暴露：
 * - settings:set（remote.* 只能桌面本机改，见阶段3/阶段5）
 * - provider:*（含 API Key）
 * - dialog:*、app:*、mcp:*（文件选择、退出应用等本机能力）
 * 未列出的操作统一返回 { ok: false, error }，不抛错穿透。
 */

export interface RemoteHandlerContext {
  /** 远程审批策略：allow-all（默认）/ confirm-high / read-only。阶段5实现，阶段1先透传。 */
  approvalPolicy?: 'allow-all' | 'confirm-high' | 'read-only'
}

export interface RemoteHandlerResult {
  ok: boolean
  data?: unknown
  error?: string
}

/** 写操作集合：read-only 策略下拒绝。 */
const WRITE_OPS: ReadonlySet<RemoteOp> = new Set(['send', 'approve', 'regenerate', 'cancelQueued'])

/** 高危工具前缀：confirm-high 策略下必须回桌面确认，远程直接拒绝。 */
const HIGH_RISK_PREFIXES = ['run_command', 'write_file', 'patch_file', 'computer_']

function isHighRiskToolName(name: string): boolean {
  return HIGH_RISK_PREFIXES.some((p) => name === p || name.startsWith(`${p}`)) || name.startsWith('mcp__')
}

export async function handleRemoteRequest(
  raw: unknown,
  ctx: RemoteHandlerContext = {}
): Promise<RemoteHandlerResult> {
  let op: RemoteOp
  let params: unknown
  const parsed = safeParse(raw)
  if (!parsed) return { ok: false, error: '非法请求格式' }
  op = parsed.op
  params = parsed.params

  if (!ALLOWED_REMOTE_OPS.includes(op)) {
    return { ok: false, error: `不支持的远程操作：${String((raw as { op?: unknown })?.op ?? 'unknown')}` }
  }

  // 阶段5策略（阶段1先实现 read-only 拒绝，confirm-high 在审批时生效）：
  if (ctx.approvalPolicy === 'read-only' && WRITE_OPS.has(op)) {
    return { ok: false, error: '当前为只读模式，远程写操作已被禁用' }
  }

  try {
    switch (op) {
      case 'listConversations': {
        return { ok: true, data: repo.listConversations() }
      }
      case 'createConversation': {
        const p = params as { title?: string; workingDir?: string | null }
        return {
          ok: true,
          data: repo.createConversation({ title: p.title ?? '新对话', workingDir: p.workingDir ?? null })
        }
      }
      case 'deleteConversation': {
        const p = params as { conversationId: string }
        agentRuntime.abortConversation(p.conversationId)
        repo.deleteConversation(p.conversationId)
        return { ok: true, data: true }
      }
      case 'getMessages': {
        const p = params as { conversationId: string }
        const conversation = repo.getConversation(p.conversationId)
        if (!conversation) return { ok: false, error: '会话不存在或已被删除' }
        return {
          ok: true,
          data: {
            messages: repo.listMessages(p.conversationId),
            activeLeafId: repo.getActiveLeaf(p.conversationId)
          }
        }
      }
      case 'setLeaf': {
        const p = params as { conversationId: string; leafId: string }
        repo.setActiveLeaf(p.conversationId, p.leafId)
        return { ok: true, data: true }
      }
      case 'send': {
        const p = params as { conversationId: string; parentMessageId: string | null; content: string }
        const conversation = repo.getConversation(p.conversationId)
        if (!conversation) return { ok: false, error: '会话不存在或已被删除' }
        // 远程通道只发纯文本：文件选择是本机能力，不开放
        return {
          ok: true,
          // handler 内部没有 emit 闭包：用空 emit + 事件总线广播（runtime.withBus 包装）。
          // 订阅者（桌面窗口/远程推送）从总线收到事件。
          data: agentRuntime.send(
            { conversationId: p.conversationId, parentMessageId: p.parentMessageId, content: p.content },
            agentRuntime.withBus(() => {})
          )
        }
      }
      case 'abort': {
        const p = params as { runId: string }
        agentRuntime.abort(p.runId)
        return { ok: true, data: true }
      }
      case 'approve': {
        const p = params as { runId: string; toolUseId: string; approved: boolean; paramHash: string }
        if (ctx.approvalPolicy === 'confirm-high') {
          const pending = agentRuntime.listPendingApprovals().find(
            (a) => a.runId === p.runId && a.toolUseId === p.toolUseId
          )
          if (pending && isHighRiskToolName(pending.toolName)) {
            return { ok: false, error: '高危操作需回桌面确认，远程审批已被策略拒绝' }
          }
        }
        const accepted = agentRuntime.decideWithHash(p.runId, p.toolUseId, p.approved, p.paramHash)
        if (!accepted) return { ok: false, error: '审批不存在、已过期或参数哈希不一致（已按拒绝处理）' }
        return { ok: true, data: true }
      }
      case 'regenerate': {
        const p = params as { assistantMessageId: string }
        return { ok: true, data: agentRuntime.regenerate(p.assistantMessageId, agentRuntime.withBus(() => {})) }
      }
      case 'cancelQueued': {
        const p = params as { conversationId: string; userMessageId: string }
        return { ok: true, data: await agentRuntime.cancelQueuedMessage(p.conversationId, p.userMessageId) }
      }
      case 'listApprovals': {
        const now = Date.now()
        const approvals: PendingApprovalInfo[] = agentRuntime.listPendingApprovals().map((a) => ({
          runId: a.runId,
          toolUseId: a.toolUseId,
          conversationId: a.conversationId,
          messageId: a.messageId,
          toolName: a.toolName,
          input: a.input,
          reason: a.reason,
          paramHash: a.paramHash,
          severity: a.severity,
          autoApprovable: a.autoApprovable,
          createdAt: a.createdAt,
          expiresAt: a.expiresAt,
          remainingMs: Math.max(0, a.expiresAt - now)
        }))
        return { ok: true, data: approvals }
      }
      default: {
        return { ok: false, error: `不支持的远程操作：${String(op)}` }
      }
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

function safeParse(raw: unknown): { op: RemoteOp; params: unknown } | null {
  try {
    const { op, params } = parseRemoteRequest(raw)
    return { op, params }
  } catch {
    return null
  }
}

/** 未开放的操作名集合（settings/provider/dialog/app/mcp），单测断言用。 */
export const BLOCKED_REMOTE_OPS = [
  'settings:set',
  'provider:list',
  'provider:upsert',
  'dialog:pickFolder',
  'app:quit'
] as const

/** 校验请求体为非法 zod 类型（测试辅助）。 */
export const RemoteIdSchema = z.object({
  id: z.string().min(1).max(100),
  kind: z.literal('req'),
  op: z.string(),
  params: z.unknown()
})
