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
  | { type: 'tool_result'; toolUseId: string; content: string; isError: boolean; image?: { mimeType: string; dataUrl: string } }
  /**
   * 图片块。二者至少要有一个：
   * - file：已落盘的相对路径（持久化形态，DB 只存它，体积不膨胀）
   * - dataUrl：内存态直传，仅在发往模型前短暂存在，不入库
   * 两者皆空时由各 provider 降级为纯文本（见 providers/types.ts 的 textOf）。
   */
  | { type: 'image'; mimeType: string; file?: string; dataUrl?: string }

export interface Usage {
  /** 末次请求的输入 tokens——多步工具循环时，这才是单次请求上下文的真实规模 */
  promptTokens: number
  /** 末次请求的输出 tokens */
  completionTokens: number
  /** 整轮（含多次工具请求）累计输入 tokens；单次请求时不填 */
  totalPromptTokens?: number
  /** 整轮累计输出 tokens；单次请求时不填 */
  totalCompletionTokens?: number
  /** 产出这条消息所用的 LLM 请求数；单次请求时不填 */
  requests?: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  finishReason?: string
}

/** 真实的每日 Token 统计汇总项 (从本地 SQLite 数据库真实聚合) */
export interface DailyUsageStat {
  date: string
  fullDate: string
  promptTokens: number
  completionTokens: number
  totalTokens: number
  toolCallsCount: number
  coworkTokens: number
  codeTokens: number
}

/** 周期 Token 用量汇总数据 */
export interface UsageSummaryStats {
  days: number
  totalTokens: number
  coworkTokens: number
  codeTokens: number
  toolCallsCount: number
  dailyList: DailyUsageStat[]
}

export interface Conversation {
  id: string
  title: string
  projectId: string | null
  /**
   * 该对话绑定的本机项目目录。绑定后：
   * 工具收到相对路径时基于它解析，run_command 以它为默认工作目录，
   * 系统提示里也会告诉模型当前目录，让它围绕项目展开操作。
   */
  workingDir: string | null
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

export type ProviderKind = 'openai-compatible' | 'openai-responses' | 'anthropic'

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
  /**
   * 随请求额外发送的 HTTP 头。部分网关/中转需要自定义头
   * （如 opencode 要求 x-opencode-session、企业代理要求追踪头），在此按供应商配置。
   * 自定义头优先级高于适配器默认头。
   */
  headers: Record<string, string>
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
  headers?: Record<string, string>
}

export interface ProviderTestResult {
  ok: boolean
  latencyMs: number
  message: string
}

/** MCP 服务实时状态（设置页列表的数据源，状态全部实测而来）。 */
export interface McpServerStatus {
  id: string
  name: string
  enabled: boolean
  /** ready=进程活着且工具已拉回；error=起不来或缺东西；disabled=开关关了。 */
  state: 'ready' | 'error' | 'disabled'
  toolCount: number
  tools: { name: string; description?: string }[]
  error?: string
}

/* ------------------------------------------------------------------ */
/* Agent 运行时事件                                                     */
/* ------------------------------------------------------------------ */

/**
 * 随消息发送的图片附件（IPC 线格式）。
 * 刻意不传 base64：粘贴的截图动辄数 MB，编成 base64 既膨胀 33% 又会在
 * IPC、结构化克隆、DB 写入上反复搬运。改为传原始字节，由主进程落盘，
 * 渲染层与 DB 之间只传递路径。
 */
export interface ImageAttachment {
  /** 仅允许常见图片类型，如 image/png、image/jpeg、image/webp、image/gif */
  mimeType: string
  /** 原始字节 */
  data: Uint8Array
}

/** 落盘后的图片引用：DB 里的 image 块与运行时的请求都用它，file 为相对路径。 */
export interface StoredImage {
  mimeType: string
  /** 形如 `<conversationId>/<uuid>.png`，相对于 userData/images */
  file: string
}

/** 上下文窗口的静态开销（不含会话消息），由主进程实测后回传。 */
export interface ContextStatics {
  /** 本地工具 schema 序列化后的 token 估算 */
  systemTools: number
  /** MCP 工具 schema 序列化后的 token 估算 */
  mcp: number
  skills: number
  /** 本轮实际拼装的系统提示长度 */
  systemPrompt: number
  memory: number
}

export interface SendPayload {
  conversationId: string
  /** 新消息挂载到哪个父消息下；为 null 表示作为根消息（新分支起点）。 */
  parentMessageId: string | null
  content: string
  /** 随消息一起发送的图片（如从剪贴板粘贴的截图），以原始字节表达。 */
  images?: ImageAttachment[]
  providerId?: string
  model?: string
}

/** 主进程内部使用的发送请求：图片已落盘，只剩路径。 */
export interface AgentSendRequest extends Omit<SendPayload, 'images'> {
  images?: StoredImage[]
}

export type AgentEvent =
  | {
      type: 'run_start'
      runId: string
      conversationId: string
      userMessageId: string
      assistantMessageId: string
      /**
       * 刚落库的用户消息。图片此时已带 file 路径，渲染层可直接用它渲染气泡，
       * 无需自己猜内容——也避免乐观渲染与真实落库结果出现偏差。
       */
      userMessage: Message
    }
  | { type: 'text_delta'; runId: string; conversationId: string; messageId: string; text: string }
  | {
      type: 'reasoning_delta'
      runId: string
      conversationId: string
      messageId: string
      text: string
    }
  | {
      type: 'tool_use'
      runId: string
      conversationId: string
      messageId: string
      toolUseId: string
      name: string
      input: unknown
    }
  | {
      type: 'tool_result'
      runId: string
      conversationId: string
      messageId: string
      toolUseId: string
      content: string
      isError: boolean
    }
  | {
      type: 'approval_required'
      runId: string
      conversationId: string
      messageId: string
      toolUseId: string
      name: string
      input: unknown
      reason: string
    }
  | {
      type: 'subagent_start'
      runId: string
      conversationId: string
      messageId: string
      toolUseId: string
      task: string
    }
  | {
      type: 'subagent_done'
      runId: string
      conversationId: string
      messageId: string
      toolUseId: string
      task: string
      isError: boolean
    }
  | { type: 'usage'; runId: string; conversationId: string; messageId: string; usage: Usage }
  | {
      type: 'provider_switched'
      runId: string
      conversationId: string
      fromProviderName: string
      providerName: string
      model: string
      reason: string
    }
  | {
      type: 'retry_status'
      runId: string
      conversationId: string
      providerName: string
      attempt: number
      maxAttempts: number
      waitMs: number
      reason: string
    }
  | {
      type: 'message_done'
      runId: string
      conversationId: string
      messageId: string
      status: MessageStatus
    }
  | {
      type: 'run_error'
      runId: string
      conversationId: string
      messageId: string
      error: string
    }
  | {
      type: 'run_end'
      runId: string
      conversationId: string
      /** 该会话（含正在跑的）还剩几个排队项。会话被删除时为 0。 */
      queued: number
    }
  /**
   * 轮次进入等待队列：同会话已有回合在跑，本轮排在它后面。
   * 渲染层据此把消息标成「排队中」，而不是凭空消失。
   */
  | {
      type: 'run_queued'
      runId: string
      conversationId: string
      userMessageId: string
      /** 前面还有几个回合在等（含正在跑的那个） */
      position: number
      userMessage: Message
    }

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
  username?: string
}