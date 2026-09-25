import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '../shared/ipc'
import type { ShangboApi } from '../shared/api'
import type { AgentEvent, ApprovalDecision, ProviderInput, SendPayload } from '../shared/types'

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
    export: (id) => ipcRenderer.invoke(IPC.conversationExport, id)
  },

  chat: {
    send: (payload: SendPayload) => ipcRenderer.invoke(IPC.chatSend, payload),
    abort: (runId) => ipcRenderer.invoke(IPC.chatAbort, runId),
    approve: (decision: ApprovalDecision) => ipcRenderer.invoke(IPC.chatApprove, decision),
    regenerate: (assistantMessageId) => ipcRenderer.invoke(IPC.chatRegenerate, assistantMessageId),
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
    getGitBranch: (dir: string | null) => ipcRenderer.invoke('git:branch', dir),
    hideWindow: () => ipcRenderer.invoke(IPC.windowHide),
    quit: () => ipcRenderer.invoke(IPC.windowQuit)
  },

  dialog: {
    pickFolder: () => ipcRenderer.invoke(IPC.dialogPickFolder)
  },

  usage: {
    getStats: (days: number) => ipcRenderer.invoke(IPC.usageGetStats, days)
  }
}

contextBridge.exposeInMainWorld('shangbo', api)