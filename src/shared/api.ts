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

/** 暴露给渲染进程的完整 API 契约；preload 必须逐项实现，渲染进程只依赖此类型。 */
export interface ShangboApi {
  conversation: {
    list(): Promise<Conversation[]>
    create(title?: string): Promise<Conversation>
    rename(id: string, title: string): Promise<Conversation | null>
    remove(id: string): Promise<boolean>
    messages(id: string): Promise<{ messages: Message[]; activeLeafId: string | null }>
    setLeaf(conversationId: string, leafId: string): Promise<boolean>
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
    hideWindow(): Promise<boolean>
    quit(): Promise<boolean>
  }
}