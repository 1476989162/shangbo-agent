import { BrowserWindow, app, dialog, ipcMain } from 'electron'
import { z } from 'zod'
import { IPC } from '../../shared/ipc'
import * as repo from '../db/repo'
import { getDbPath } from '../db'
import { getAllSettings, setSetting } from '../settings'
import { agentRuntime } from '../agent/runtime'
import {
  adapterForKind,
  deleteProvider,
  getApiKey,
  getProvider,
  listProviders,
  upsertProvider
} from '../providers/store'
import { probeProvider } from '../providers/gateway'
import { exportConversation } from '../exporter'
import { markQuitting } from '../windows/mainWindow'
import type { AgentEvent, AppInfo, ProviderInput } from '../../shared/types'

/* 渲染进程传来的一切数据都在这里做一次校验，主进程内部不再重复防御。 */

const ProviderInputSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1, '名称不能为空'),
  kind: z.enum(['openai-compatible', 'anthropic']),
  baseUrl: z.string().url('Base URL 必须是合法地址'),
  apiKey: z.string().optional(),
  models: z.array(z.string()),
  enabled: z.boolean(),
  priority: z.number().int(),
  headers: z.record(z.string(), z.string()).optional()
})

const SendPayloadSchema = z.object({
  conversationId: z.string().min(1),
  parentMessageId: z.string().nullable(),
  content: z.string().min(1, '消息不能为空'),
  providerId: z.string().optional(),
  model: z.string().optional()
})

const ApprovalSchema = z.object({
  runId: z.string().min(1),
  toolUseId: z.string().min(1),
  approved: z.boolean(),
  alwaysAllow: z.boolean().optional()
})

function broadcast(event: AgentEvent): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(IPC.agentEvent, event)
  }
}

export function registerIpcHandlers(): void {
  /* 会话 ---------------------------------------------------------- */

  ipcMain.handle(IPC.conversationList, () => repo.listConversations())

  ipcMain.handle(
    IPC.conversationCreate,
    (
      _event,
      input: string | { title?: string; workingDir?: string | null; projectId?: string | null } | undefined
    ) => {
      if (typeof input === 'string') {
        return repo.createConversation({ title: input })
      }
      return repo.createConversation({
        title: input?.title ?? '新对话',
        workingDir: input?.workingDir ?? null,
        projectId: input?.projectId ?? null
      })
    }
  )

  ipcMain.handle(IPC.conversationRename, (_event, id: string, title: string) => {
    repo.updateConversation(id, { title: title.trim() || '新对话' })
    return repo.getConversation(id)
  })

  ipcMain.handle(IPC.conversationDelete, (_event, id: string) => {
    agentRuntime.abortConversation(id)
    repo.deleteConversation(id)
    return true
  })

  ipcMain.handle(IPC.conversationMessages, (_event, conversationId: string) => ({
    messages: repo.listMessages(conversationId),
    activeLeafId: repo.getActiveLeaf(conversationId)
  }))

  ipcMain.handle(IPC.conversationSetLeaf, (_event, conversationId: string, leafId: string) => {
    repo.setActiveLeaf(conversationId, leafId)
    return true
  })

  ipcMain.handle(IPC.conversationSetWorkingDir, (_event, conversationId: string, dir: unknown) => {
    if (dir !== null && typeof dir !== 'string') throw new Error('目录必须是字符串或 null')
    repo.updateConversation(conversationId, { workingDir: dir })
    return repo.getConversation(conversationId)
  })

  ipcMain.handle(IPC.conversationExport, (_event, conversationId: string) =>
    exportConversation(conversationId)
  )

  /* 对话 ---------------------------------------------------------- */

  ipcMain.handle(IPC.chatSend, (_event, payload: unknown) => {
    const parsed = SendPayloadSchema.parse(payload)
    return agentRuntime.send(parsed, broadcast)
  })

  ipcMain.handle(IPC.chatAbort, (_event, runId: string) => {
    agentRuntime.abort(runId)
    return true
  })

  ipcMain.handle(IPC.chatApprove, (_event, decision: unknown) => {
    agentRuntime.decide(ApprovalSchema.parse(decision))
    return true
  })

  ipcMain.handle(IPC.chatRegenerate, (_event, assistantMessageId: string) =>
    agentRuntime.regenerate(assistantMessageId, broadcast)
  )

  /* 供应商 -------------------------------------------------------- */

  ipcMain.handle(IPC.providerList, () => listProviders())

  ipcMain.handle(IPC.providerUpsert, (_event, input: unknown) =>
    upsertProvider(ProviderInputSchema.parse(input) as ProviderInput)
  )

  ipcMain.handle(IPC.providerDelete, (_event, id: string) => {
    deleteProvider(id)
    return true
  })

  ipcMain.handle(IPC.providerTest, async (_event, id: string) => {
    const provider = getProvider(id)
    if (!provider) return { ok: false, latencyMs: 0, message: '供应商不存在' }
    try {
      const result = await probeProvider(provider)
      return {
        ok: true,
        latencyMs: result.latencyMs,
        message: `连接正常，可见 ${result.models} 个模型`
      }
    } catch (error) {
      return {
        ok: false,
        latencyMs: 0,
        message: error instanceof Error ? error.message : String(error)
      }
    }
  })

  /** 拉取模型列表时允许使用「尚未保存」的配置，方便用户先试再存。 */
  ipcMain.handle(IPC.providerFetchModels, async (_event, input: unknown) => {
    const parsed = ProviderInputSchema.parse(input)
    const apiKey = parsed.apiKey?.trim() || (parsed.id ? getApiKey(parsed.id) : '')
    if (!apiKey) throw new Error('请先填写 API Key')

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 20_000)
    try {
      return await adapterForKind(parsed.kind).listModels({
        baseUrl: parsed.baseUrl,
        apiKey,
        headers: parsed.headers,
        signal: controller.signal
      })
    } finally {
      clearTimeout(timer)
    }
  })

  /* 设置与系统信息 ------------------------------------------------ */

  ipcMain.handle(IPC.settingsGet, () => getAllSettings())

  ipcMain.handle(IPC.settingsSet, (_event, key: string, value: unknown) => {
    setSetting(key, value)
    return true
  })

  /* Token 用量真实统计 -------------------------------------------- */

  ipcMain.handle(IPC.usageGetStats, (_event, days: unknown) => {
    const numDays = typeof days === 'number' ? days : 30
    return repo.getUsageStats(numDays)
  })

  ipcMain.handle(IPC.appInfo, (): AppInfo => {
    return {
      name: '尚搏 Agent',
      version: app.getVersion(),
      electron: process.versions.electron,
      node: process.versions.node,
      chrome: process.versions.chrome,
      platform: process.platform,
      userDataPath: app.getPath('userData'),
      dbPath: getDbPath(),
      username: process.env.USERNAME || process.env.USER || 'Administrator'
    }
  })

  ipcMain.handle('git:branch', async (_event, dir: string | null) => {
    if (!dir) return 'main'
    try {
      const { execFile } = await import('node:child_process')
      const { promisify } = await import('node:util')
      const exec = promisify(execFile)
      const { stdout } = await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: dir,
        timeout: 2000
      })
      return stdout.trim() || 'main'
    } catch {
      return 'main'
    }
  })

  ipcMain.handle(IPC.windowHide, () => {
    BrowserWindow.getFocusedWindow()?.hide()
    return true
  })

  /** 系统目录选择对话框；取消时返回 null。 */
  ipcMain.handle(IPC.dialogPickFolder, async () => {
    const focused = BrowserWindow.getFocusedWindow() ?? undefined
    const result = await dialog.showOpenDialog(focused!, {
      title: '选择项目文件夹',
      properties: ['openDirectory', 'createDirectory']
    })
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  ipcMain.handle(IPC.windowQuit, () => {
    markQuitting()
    app.quit()
    return true
  })
}