import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type { ShangboApi } from '../shared/api'
import type {
  AgentMode,
  AgentEvent,
  ApprovalDecision,
  ProviderInput,
  SendPayload,
  UpdateState
} from '../shared/types'

const api: ShangboApi = {
  conversation: {
    list: () => ipcRenderer.invoke(IPC.conversationList),
    create: (arg) => {
      const payload = typeof arg === 'string' ? { title: arg } : arg
      return ipcRenderer.invoke(IPC.conversationCreate, payload)
    },
    rename: (id, title) => ipcRenderer.invoke(IPC.conversationRename, id, title),
    remove: (id) => ipcRenderer.invoke(IPC.conversationDelete, id),
    messages: (id) => ipcRenderer.invoke(IPC.conversationMessages, id),
    setLeaf: (conversationId, leafId) =>
      ipcRenderer.invoke(IPC.conversationSetLeaf, conversationId, leafId),
    setWorkingDir: (id, dir) => ipcRenderer.invoke(IPC.conversationSetWorkingDir, id, dir),
    setMode: (id, mode: AgentMode | null) => ipcRenderer.invoke(IPC.conversationSetMode, id, mode),
    export: (id) => ipcRenderer.invoke(IPC.conversationExport, id)
  },

  chat: {
    send: (payload: SendPayload) => ipcRenderer.invoke(IPC.chatSend, payload),
    abort: (runId) => ipcRenderer.invoke(IPC.chatAbort, runId),
    stopConversation: (conversationId: string) =>
      ipcRenderer.invoke(IPC.chatStopConversation, conversationId),
    steerQueued: (conversationId: string, userMessageId: string) =>
      ipcRenderer.invoke(IPC.chatSteerQueued, conversationId, userMessageId),
    approve: (decision: ApprovalDecision) => ipcRenderer.invoke(IPC.chatApprove, decision),
    regenerate: (assistantMessageId) => ipcRenderer.invoke(IPC.chatRegenerate, assistantMessageId),
    editQueued: (conversationId, userMessageId, content) =>
      ipcRenderer.invoke(IPC.chatEditQueued, conversationId, userMessageId, content),
    cancelQueued: (conversationId, userMessageId) =>
      ipcRenderer.invoke(IPC.chatCancelQueued, conversationId, userMessageId),
    // 事件流是全局单例，因此不做按 handler 的精确解绑，避免跨 contextBridge 传递函数引用
    onEvent: (handler: (event: AgentEvent) => void) => {
      ipcRenderer.removeAllListeners(IPC.agentEvent)
      ipcRenderer.on(IPC.agentEvent, (_event, payload: AgentEvent) => handler(payload))
    },
    offEvent: () => {
      ipcRenderer.removeAllListeners(IPC.agentEvent)
    }
  },

  provider: {
    list: () => ipcRenderer.invoke(IPC.providerList),
    upsert: (input: ProviderInput) => ipcRenderer.invoke(IPC.providerUpsert, input),
    remove: (id) => ipcRenderer.invoke(IPC.providerDelete, id),
    test: (id) => ipcRenderer.invoke(IPC.providerTest, id),
    fetchModels: (input: ProviderInput) => ipcRenderer.invoke(IPC.providerFetchModels, input)
  },

  settings: {
    getAll: () => ipcRenderer.invoke(IPC.settingsGet),
    set: (key, value) => ipcRenderer.invoke(IPC.settingsSet, key, value)
  },

  app: {
    info: () => ipcRenderer.invoke(IPC.appInfo),
    contextStatics: () => ipcRenderer.invoke(IPC.appContextStatics),
    getGitBranch: (dir: string | null) => ipcRenderer.invoke(IPC.appGitBranch, dir),
    hideWindow: () => ipcRenderer.invoke(IPC.windowHide),
    quit: () => ipcRenderer.invoke(IPC.windowQuit)
  },

  dialog: {
    pickFolder: () => ipcRenderer.invoke(IPC.dialogPickFolder)
  },

  usage: {
    getStats: (days: number) => ipcRenderer.invoke(IPC.usageGetStats, days)
  },

  mcp: {
    status: () => ipcRenderer.invoke(IPC.mcpStatus)
  },

  remote: {
    status: () => ipcRenderer.invoke(IPC.remoteStatus),
    pair: (phoneName?: string) => ipcRenderer.invoke(IPC.remotePair, phoneName),
    devices: () => ipcRenderer.invoke(IPC.remoteDevices),
    revoke: (id: string) => ipcRenderer.invoke(IPC.remoteRevoke, id),
    disconnect: () => ipcRenderer.invoke(IPC.remoteDisconnect),
    identity: () => ipcRenderer.invoke(IPC.remoteIdentity),    onEvent: (handler: (status: string, detail: string) => void) => {
      ipcRenderer.removeAllListeners(IPC.remoteEvent)
      ipcRenderer.on(IPC.remoteEvent, (_event, status: string, detail: string) => handler(status, detail))
    },
    offEvent: () => {
      ipcRenderer.removeAllListeners(IPC.remoteEvent)
    }
  },

  update: {
    status: () => ipcRenderer.invoke(IPC.updateStatus),
    check: () => ipcRenderer.invoke(IPC.updateCheck),
    download: () => ipcRenderer.invoke(IPC.updateDownload),
    install: () => ipcRenderer.invoke(IPC.updateInstall),
    // 与 agent:event 同样的单例约定：不做按 handler 精确解绑，避免跨 contextBridge 传函数引用
    onEvent: (handler: (state: UpdateState) => void) => {
      ipcRenderer.removeAllListeners(IPC.updateEvent)
      ipcRenderer.on(IPC.updateEvent, (_event, payload: UpdateState) => handler(payload))
    },
    offEvent: () => {
      ipcRenderer.removeAllListeners(IPC.updateEvent)
    }
  },

  autonomous: {
    list: () => ipcRenderer.invoke(IPC.autonomousList),
    save: (input) => ipcRenderer.invoke(IPC.autonomousSave, input),
    remove: (id) => ipcRenderer.invoke(IPC.autonomousDelete, id),
    setEnabled: (id, enabled) => ipcRenderer.invoke(IPC.autonomousSetEnabled, id, enabled),
    runNow: (id) => ipcRenderer.invoke(IPC.autonomousRunNow, id),
    runs: (taskId) => ipcRenderer.invoke(IPC.autonomousRuns, taskId),
    pause: () => ipcRenderer.invoke(IPC.autonomousPause),
    resume: () => ipcRenderer.invoke(IPC.autonomousResume),
    status: () => ipcRenderer.invoke(IPC.autonomousStatus)
  },

  lessons: {
    list: (projectPath) => ipcRenderer.invoke(IPC.lessonsList, projectPath),
    save: (input) => ipcRenderer.invoke(IPC.lessonsSave, input),
    remove: (id) => ipcRenderer.invoke(IPC.lessonsDelete, id)
  }
}

contextBridge.exposeInMainWorld('shangbo', api)
