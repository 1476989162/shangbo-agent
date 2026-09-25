import type {
  AgentEvent,
  AppInfo,
  ApprovalDecision,
  Conversation,
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
      input?: string | { title?: string; workingDir?: string | null; projectId?: string | null }
    ): Promise<Conversation>
    rename(id: string, title: string): Promise<Conversation | null>
    remove(id: string): Promise<boolean>
    messages(id: string): Promise<{ messages: Message[]; activeLeafId: string | null }>
    setLeaf(conversationId: string, leafId: string): Promise<boolean>
    setWorkingDir(id: string, dir: string | null): Promise<Conversation | null>
    export(id: string): Promise<ExportResult>
  }

  chat: {
    send(payload: SendPayload): Promise<{ runId: string }>
    abort(runId: string): Promise<boolean>
    approve(decision: ApprovalDecision): Promise<boolean>
    regenerate(assistantMessageId: string): Promise<{ runId: string }>
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
}