import { createHash } from 'node:crypto'
import log from 'electron-log/main'
import { getSetting, setSetting } from '../settings'
import { canonicalParamString } from '../../shared/remote'
import type { ApprovalDecision, AgentEvent } from '../../shared/types'

/** 审批弹窗超时：用户 5 分钟不点按拒绝处理。 */
export const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000
export const AUTO_APPROVE_KEY = 'tools.autoApprove'

export type ApprovalEmitter = (event: AgentEvent) => void

interface PendingApproval {
  toolName: string
  conversationId: string
  messageId: string
  input: unknown
  paramHash: string
  reason: string
  createdAt: number
  settle: (approved: boolean) => void
}

/** 待审批清单项（手机连上时立刻下发，不含 settle）。 */
export interface PendingApprovalSnapshot {
  runId: string
  toolUseId: string
  conversationId: string
  messageId: string
  toolName: string
  input: unknown
  paramHash: string
  reason: string
  createdAt: number
  expiresAt: number
  remainingMs: number
}

/** 审批状态与裁决逻辑：从 AgentRuntime 抽离，便于独立测试且不携带队列状态。 */
export class ApprovalBroker {
  private approvals = new Map<string, PendingApproval>()

  decide(decision: ApprovalDecision): void {
    const key = `${decision.runId}:${decision.toolUseId}`
    const pending = this.approvals.get(key)
    const toolName = pending?.toolName
    this.decideWithHash(decision.runId, decision.toolUseId, decision.approved, undefined)
    // 只有桌面本地审批的 alwaysAllow 才记自动放行；远程审批永不记入
    if (decision.approved && decision.alwaysAllow && toolName) {
      this.grantAutoApprove(toolName)
    }
  }

  decideWithHash(runId: string, toolUseId: string, approved: boolean, expectedParamHash?: string): boolean {
    const key = `${runId}:${toolUseId}`
    const pending = this.approvals.get(key)
    if (!pending) return false
    if (expectedParamHash !== undefined && expectedParamHash !== pending.paramHash) {
      log.warn(`[agent] 远程审批哈希不一致，已按拒绝处理：${key}`)
      pending.settle(false)
      return false
    }
    pending.settle(approved)
    return true
  }

  list(): PendingApprovalSnapshot[] {
    const now = Date.now()
    const out: PendingApprovalSnapshot[] = []
    for (const [key, pending] of this.approvals) {
      const sep = key.indexOf(':')
      const runId = key.slice(0, sep)
      const toolUseId = key.slice(sep + 1)
      const remainingMs = Math.max(0, pending.createdAt + APPROVAL_TIMEOUT_MS - now)
      out.push({
        runId,
        toolUseId,
        conversationId: pending.conversationId,
        messageId: pending.messageId,
        toolName: pending.toolName,
        input: pending.input,
        paramHash: pending.paramHash,
        reason: pending.reason,
        createdAt: pending.createdAt,
        expiresAt: pending.createdAt + APPROVAL_TIMEOUT_MS,
        remainingMs
      })
    }
    return out
  }

  /** 会话删除/停止时，把该会话所有挂起审批按拒绝收尾。 */
  rejectConversation(conversationId: string): void {
    for (const [key, pending] of [...this.approvals]) {
      if (pending.conversationId !== conversationId) continue
      try {
        pending.settle(false)
      } catch {}
      this.approvals.delete(key)
    }
  }

  /** 会话删除且只拿到 runId 集合时的兼容路径。 */
  rejectRuns(runIds: Set<string>): void {
    for (const [key, pending] of this.approvals) {
      if (runIds.has(key.split(':')[0])) pending.settle(false)
    }
  }

  request(
    runId: string,
    conversationId: string,
    messageId: string,
    call: { id: string; name: string; input: unknown },
    tool: { name: string; approvalReason?: string },
    emit: ApprovalEmitter,
    controller: AbortController
  ): Promise<ApprovalDecision> {
    const key = `${runId}:${call.id}`
    const paramHash = ApprovalBroker.paramHashOf(call.input)
    const reason = tool.approvalReason ?? '该操作会修改你的本机环境。'

    emit({
      type: 'approval_required',
      runId,
      conversationId,
      messageId,
      toolUseId: call.id,
      name: call.name,
      input: call.input,
      reason
    })

    return new Promise<ApprovalDecision>((resolve) => {
      const settle = (approved: boolean): void => {
        clearTimeout(timer)
        controller.signal.removeEventListener('abort', onAbort)
        this.approvals.delete(key)
        resolve({ runId, toolUseId: call.id, approved })
      }

      const timer = setTimeout(() => {
        log.warn(`[agent] 工具 ${call.name} 的确认超时，按拒绝处理`)
        settle(false)
      }, APPROVAL_TIMEOUT_MS)

      const onAbort = (): void => settle(false)
      controller.signal.addEventListener('abort', onAbort, { once: true })

      this.approvals.set(key, {
        toolName: tool.name,
        conversationId,
        messageId,
        input: call.input,
        paramHash,
        reason,
        createdAt: Date.now(),
        settle
      })
    })
  }

  isAutoApproved(toolName: string): boolean {
    return getSetting<string[]>(AUTO_APPROVE_KEY, []).includes(toolName)
  }

  grantAutoApprove(toolName: string): void {
    const current = getSetting<string[]>(AUTO_APPROVE_KEY, [])
    if (current.includes(toolName)) return
    setSetting(AUTO_APPROVE_KEY, [...current, toolName])
    log.info(`[agent] 已永久放行工具：${toolName}`)
  }

  static paramHashOf(input: unknown): string {
    return createHash('sha256').update(canonicalParamString(input), 'utf8').digest('hex')
  }
}
