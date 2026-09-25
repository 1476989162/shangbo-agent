/**
 * 主进程与渲染进程共享的领域模型。
 * 所有跨进程数据结构都必须在此定义，禁止各层自行定义影子类型。
 */

export type Role = 'system' | 'user' | 'assistant' | 'tool'

export type MessageStatus = 'pending' | 'streaming' | 'done' | 'error' | 'aborted'

/** 助手的回复不是纯字符串，而是有序内容块序列（文本 / 思考 / 工具调用 / 工具结果 / 图片）。 */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; toolUseId: string; content: string; isError: boolean }
  | { type: 'image'; mimeType: string; dataUrl: string }

export interface Usage {
  promptTokens: number
  completionTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
}

export interface Conversation {
  id: string
  title: string
  projectId: string | null
  providerId: string | null
  model: string | null
  systemPrompt: string | null
  createdAt: number
  updatedAt: number
  archivedAt: number | null
}

/**
 * 消息以树形存储（parentId 指向父消息），而非线性数组。
 * 「编辑后重发」「重新生成」「会话分支」全部依赖这一结构，后期无法低成本改造。
 */
export interface Message {
  id: string
  conversationId: string
  parentId: string | null
  role: Role
  blocks: ContentBlock[]
  status: MessageStatus
  error: string | null
  providerId: string | null
  model: string | null
  usage: Usage | null
  createdAt: number
  updatedAt: number
}

/** 一个会话当前激活的叶子消息，决定渲染哪一条分支。 */
export interface ConversationState {
  conversationId: string
  activeLeafId: string | null
}

/* ------------------------------------------------------------------ */
/* 模型供应商                                                          */
/* ------------------------------------------------------------------ */

export type ProviderKind = 'openai-compatible' | 'anthropic'

export interface Provider {
  id: string
  name: string
  kind: ProviderKind
  baseUrl: string
  /** 密钥不以明文入库；此处仅记录是否已配置。真实密钥由 safeStorage 保管。 */
  hasApiKey: boolean
  models: string[]
  enabled: boolean
  /** 数值越小优先级越高，网关按优先级路由与降级。 */
  priority: number
  createdAt: number
  updatedAt: number
}

export interface ProviderInput {
  id?: string
  name: string
  kind: ProviderKind
  baseUrl: string
  apiKey?: string
  models: string[]
  enabled: boolean
  priority: number
}

export interface ProviderTestResult {
  ok: boolean
  latencyMs: number
  message: string
}

/* ------------------------------------------------------------------ */
/* Agent 运行时事件                                                     */
/* ------------------------------------------------------------------ */

export interface SendPayload {
  conversationId: string
  /** 新消息挂载到哪个父消息下；为 null 表示作为根消息（新分支起点）。 */
  parentMessageId: string | null
  content: string
  providerId?: string
  model?: string
}

export type AgentEvent =
  | { type: 'run_start'; runId: string; userMessageId: string; assistantMessageId: string }
  | { type: 'text_delta'; runId: string; messageId: string; text: string }
  | { type: 'reasoning_delta'; runId: string; messageId: string; text: string }
  | { type: 'tool_use'; runId: string; messageId: string; toolUseId: string; name: string; input: unknown }
  | {
      type: 'tool_result'
      runId: string
      messageId: string
      toolUseId: string
      content: string
      isError: boolean
    }
  | {
      type: 'approval_required'
      runId: string
      messageId: string
      toolUseId: string
      name: string
      input: unknown
      reason: string
    }
  | { type: 'usage'; runId: string; messageId: string; usage: Usage }
  | { type: 'message_done'; runId: string; messageId: string; status: MessageStatus }
  | { type: 'run_error'; runId: string; messageId: string; error: string }
  | { type: 'run_end'; runId: string }

export interface ApprovalDecision {
  runId: string
  toolUseId: string
  approved: boolean
  /** 允许后是否对该工具永久放行。 */
  alwaysAllow?: boolean
}

/* ------------------------------------------------------------------ */
/* 应用信息                                                            */
/* ------------------------------------------------------------------ */

export interface AppInfo {
  name: string
  version: string
  electron: string
  node: string
  chrome: string
  platform: string
  userDataPath: string
  dbPath: string
}