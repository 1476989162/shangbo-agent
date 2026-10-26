import { z } from 'zod'

/**
 * 阶段1：远程协议（主进程内部 + 中转密文载荷的明文结构定义）。
 * 桌面与手机之间所有业务消息都用这套 schema 校验，类型导出给手机端（PWA）复用。
 *
 * 传输说明：
 * - 外层 WSS 帧为二进制密文（阶段3 crypto.ts 负责加解密），解密后 JSON 即为本文件定义的结构。
 * - 请求：{ id, kind: 'req', op, params }；响应：{ id, kind: 'res', ok, data/error }。
 * - 推送：{ kind: 'push', event }，其中 event 为 AgentEvent 或 PendingApprovalsSnapshot。
 */

export const RemoteOpSchema = z.enum([
  'listConversations',
  'createConversation',
  'deleteConversation',
  'getMessages',
  'setLeaf',
  'send',
  'abort',
  'approve',
  'regenerate',
  'cancelQueued',
  'listApprovals'
])

export type RemoteOp = z.infer<typeof RemoteOpSchema>

const ListConversationsParams = z.object({}).strict()
const CreateConversationParams = z
  .object({
    title: z.string().max(100).optional(),
    workingDir: z.string().max(2000).nullable().optional()
  })
  .strict()
const DeleteConversationParams = z.object({ conversationId: z.string().min(1) }).strict()
const GetMessagesParams = z.object({ conversationId: z.string().min(1) }).strict()
const SetLeafParams = z
  .object({ conversationId: z.string().min(1), leafId: z.string().min(1) })
  .strict()
const SendParams = z
  .object({
    conversationId: z.string().min(1),
    parentMessageId: z.string().nullable(),
    content: z.string().max(200_000)
  })
  .strict()
  .refine((v) => v.content.trim().length > 0, { message: '消息不能为空' })
const AbortParams = z.object({ runId: z.string().min(1) }).strict()
const ApproveParams = z
  .object({
    runId: z.string().min(1),
    toolUseId: z.string().min(1),
    approved: z.boolean(),
    /** 阶段5：审批绑定参数哈希，桌面端核对一致后才放行，防止中途替换参数 */
    paramHash: z.string().min(1).max(256)
  })
  .strict()
const RegenerateParams = z.object({ assistantMessageId: z.string().min(1) }).strict()
const CancelQueuedParams = z
  .object({ conversationId: z.string().min(1), userMessageId: z.string().min(1) })
  .strict()
const ListApprovalsParams = z.object({}).strict()

/** 每个 op 对应的 params schema，用于 handler 统一校验。 */
export const RemoteParamsSchemas = {
  listConversations: ListConversationsParams,
  createConversation: CreateConversationParams,
  deleteConversation: DeleteConversationParams,
  getMessages: GetMessagesParams,
  setLeaf: SetLeafParams,
  send: SendParams,
  abort: AbortParams,
  approve: ApproveParams,
  regenerate: RegenerateParams,
  cancelQueued: CancelQueuedParams,
  listApprovals: ListApprovalsParams
} as const

export const RemoteRequestSchema = z.object({
  id: z.string().min(1).max(100),
  kind: z.literal('req'),
  op: RemoteOpSchema,
  params: z.unknown()
})

export type RemoteRequest = z.infer<typeof RemoteRequestSchema>

export const RemoteResponseSchema = z.object({
  id: z.string().min(1).max(100),
  kind: z.literal('res'),
  ok: z.boolean(),
  data: z.unknown().optional(),
  error: z.string().max(2000).optional()
})

export type RemoteResponse = z.infer<typeof RemoteResponseSchema>

/** 待审批项：手机连上时立刻能看到当前还在等待的审批（含工具名、参数、原因、剩余时间）。 */
export const PendingApprovalSchema = z.object({
  runId: z.string(),
  toolUseId: z.string(),
  conversationId: z.string(),
  messageId: z.string(),
  toolName: z.string(),
  input: z.unknown(),
  reason: z.string(),
  paramHash: z.string(),
  createdAt: z.number(),
  expiresAt: z.number(),
  remainingMs: z.number()
})

export type PendingApprovalInfo = z.infer<typeof PendingApprovalSchema>

export const PendingApprovalsSnapshotSchema = z.object({
  type: z.literal('pendingApprovals'),
  approvals: z.array(PendingApprovalSchema)
})

export type PendingApprovalsSnapshot = z.infer<typeof PendingApprovalsSnapshotSchema>

/** 推送帧：业务事件（AgentEvent）或待审批快照。 */
export const RemotePushSchema = z.object({
  kind: z.literal('push'),
  event: z.unknown()
})

/**
 * 校验某次远程请求，返回 { op, params }。
 * op 未列入 RemoteOp（例如 settings:set、provider:*、dialog:*、app:quit）直接抛错，
 * handler 层据此拒绝未开放的操作。
 */
export function parseRemoteRequest(raw: unknown): { id: string; op: RemoteOp; params: unknown } {
  const req = RemoteRequestSchema.parse(raw)
  const schema = RemoteParamsSchemas[req.op]
  const params = schema.parse(req.params)
  return { id: req.id, op: req.op, params }
}

/** 仅允许的操作集合，供 handler 与单测断言“未列出的操作返回错误”。 */
export const ALLOWED_REMOTE_OPS: readonly RemoteOp[] = RemoteOpSchema.options

/* ------------------------------------------------------------------ */
/* 参数哈希（阶段5审批绑定）                                            */
/* ------------------------------------------------------------------ */

/**
 * 稳定序列化：递归排序对象键，保证桌面 Node 与手机 WebCrypto 对同一 input
 * 算出相同的哈希。undefined / 函数跳过；其他按 JSON 语义处理。
 */
export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'string') return JSON.stringify(value)
  if (typeof value !== 'object') return JSON.stringify(value) ?? 'null'
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined && typeof v !== 'function')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(',')}}`
}

/** 待哈希的原文：stableStringify(input)。哈希算法统一为 SHA-256 hex。 */
export function canonicalParamString(input: unknown): string {
  return stableStringify(input ?? null)
}
