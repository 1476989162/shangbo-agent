import type {
  AgentMode,
  AgentEvent,
  AppInfo,
  ApprovalDecision,
  AutonomousRun,
  AutonomousTask,
  AutonomousTaskInput,
  ContextStatics,
  Conversation,
  Lesson,
  Message,
  Provider,
  ProviderInput,
  ProviderTestResult,
  SendPayload
} from './types'

/** 导出会话的结果，与主进程 exporter.ts 的 ExportResult 对应。 */
export interface ExportResult {
  ok: boolean
  canceled?: boolean
  path?: string
  message?: string
}

/** 暴露给渲染进程的完整 API 契约；preload 必须逐项实现，渲染进程只依赖此类型。 */
export interface ShangboApi {
  conversation: {
    list(): Promise<Conversation[]>
    create(
      input?:
        | string
        | {
            title?: string
            workingDir?: string | null
            projectId?: string | null
            mode?: AgentMode | null
          }
    ): Promise<Conversation>
    rename(id: string, title: string): Promise<Conversation | null>
    remove(id: string): Promise<boolean>
    messages(id: string): Promise<{ messages: Message[]; activeLeafId: string | null }>
    setLeaf(conversationId: string, leafId: string): Promise<boolean>
    setWorkingDir(id: string, dir: string | null): Promise<Conversation | null>
    setMode(id: string, mode: AgentMode | null): Promise<Conversation | null>
    export(id: string): Promise<ExportResult>
  }

  chat: {
    send(payload: SendPayload): Promise<{ runId: string }>
    abort(runId: string): Promise<boolean>
    /** 停止整个会话：中断正在跑的 + 清空排队。渲染层"停止"按钮走这里。 */
    stopConversation(conversationId: string): Promise<{ abortedRun: string | null; clearedQueued: number }>
    /** 排队消息转"指导当前轮"，注入正在跑回合的上下文。 */
    steerQueued(conversationId: string, userMessageId: string): Promise<boolean>
    approve(decision: ApprovalDecision): Promise<boolean>
    regenerate(assistantMessageId: string): Promise<{ runId: string }>
    /** 编辑一条排队中（尚未开跑）的消息文本。 */
    editQueued(conversationId: string, userMessageId: string, content: string): Promise<boolean>
    /** 撤回一条排队中的消息，同时删除其已落库的记录与图片。 */
    cancelQueued(conversationId: string, userMessageId: string): Promise<boolean>
    onEvent(handler: (event: AgentEvent) => void): void
    offEvent(): void
  }

  provider: {
    list(): Promise<Provider[]>
    upsert(input: ProviderInput): Promise<Provider>
    remove(id: string): Promise<boolean>
    test(id: string): Promise<ProviderTestResult>
    fetchModels(input: ProviderInput): Promise<string[]>
  }

  settings: {
    getAll(): Promise<Record<string, unknown>>
    set(key: string, value: unknown): Promise<boolean>
  }

  app: {
    info(): Promise<AppInfo>
    contextStatics(): Promise<ContextStatics>
    getGitBranch(dir: string | null): Promise<string>
    hideWindow(): Promise<boolean>
    quit(): Promise<boolean>
  }

  dialog: {
    /** 系统目录选择对话框，取消返回 null。 */
    pickFolder(): Promise<string | null>
  }

  usage: {
    getStats(days: number): Promise<import('./types').UsageSummaryStats>
  }

  mcp: {
    /** 各 MCP 服务实时状态（是否启用、进程是否活着、工具清单）。 */
    status(): Promise<import('./types').McpServerStatus[]>
  }

  update: {
    /** 当前更新状态机快照，渲染层打开设置页时先拉一次。 */
    status(): Promise<import('./types').UpdateState>
    /** 主动检查更新。manual 由 preload 固定为 true，渲染层无法伪装成自动检查。 */
    check(): Promise<import('./types').UpdateState>
    /** 下载已发现的更新（未处于 available 状态时主进程会拒绝）。 */
    download(): Promise<import('./types').UpdateState>
    /** 退出并安装已下载完成的更新；未 ready 时不执行。 */
    install(): Promise<import('./types').UpdateState>
    onEvent(handler: (state: import('./types').UpdateState) => void): void
    offEvent(): void
  }

  remote: {
    /** 远程状态（开关、连接状态、在线手机数），设置页轮询/订阅用。 */
    status(): Promise<{ enabled: boolean; status: string; detail: string }>
    /** 申请配对：返回二维码文本（含中转地址+配对码+桌面公钥指纹）。 */
    pair(phoneName?: string): Promise<{ qrText: string; code: string; expiresAt: number; fingerprint: string }>
    /** 已配对设备列表。 */
    devices(): Promise<{ id: string; name: string; createdAt: number; lastSeenAt: number | null }[]>
    /** 吊销设备。 */
    revoke(id: string): Promise<boolean>
    /** 一键断开所有远程设备并关闭远程功能。 */
    disconnect(): Promise<boolean>
    /** 本机中转身份指纹：填到中转 RELAY_ALLOWED_DESKTOPS 后，中转只服务本机。 */
    identity(): Promise<{ publicKeyB64: string; fingerprint: string }>
    onEvent(handler: (status: string, detail: string) => void): void
    offEvent(): void
  }

  autonomous: {
    list(): Promise<AutonomousTask[]>
    save(input: AutonomousTaskInput): Promise<AutonomousTask>
    remove(id: string): Promise<boolean>
    setEnabled(id: string, enabled: boolean): Promise<AutonomousTask | null>
    runNow(id: string): Promise<{ runRecordId: string; conversationId: string }>
    runs(taskId?: string): Promise<AutonomousRun[]>
    pause(): Promise<boolean>
    resume(): Promise<boolean>
    status(): Promise<{ paused: boolean; enabled: boolean }>
  }

  lessons: {
    list(projectPath?: string | null): Promise<Lesson[]>
    save(input: {
      id?: string
      scope?: 'global' | 'project'
      projectPath?: string | null
      title: string
      content: string
      confidence?: number
    }): Promise<Lesson>
    remove(id: string): Promise<boolean>
  }
}
