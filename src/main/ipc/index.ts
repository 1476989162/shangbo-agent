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
import { mcpManager } from '../mcp/manager'
import { exportConversation } from '../exporter'
import { markQuitting } from '../windows/mainWindow'
import {
  deleteConversationImages,
  MAX_IMAGE_BYTES,
  saveImage,
  type ResolvedImage
} from '../storage/images'
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

const MAX_IMAGES_PER_MESSAGE = 8

const ImageAttachmentSchema = z.object({
  // 只放行真正的图片类型，避免把任意二进制数据当图片落盘并塞进模型上下文
  mimeType: z
    .string()
    .regex(/^image\/(png|jpeg|jpg|webp|gif|bmp)$/i, '仅支持 png/jpeg/webp/gif/bmp 图片'),
  // 传原始字节而非 base64：结构化克隆下 Uint8Array 比字符串省 33% 体积，
  // 也省掉一次编解码。大小上限在下方按字节校验。
  data: z.instanceof(Uint8Array)
})

const SendPayloadSchema = z
  .object({
    conversationId: z.string().min(1),
    parentMessageId: z.string().nullable(),
    content: z.string().default(''),
    images: z
      .array(ImageAttachmentSchema)
      .max(MAX_IMAGES_PER_MESSAGE, '一次最多发送 8 张图片')
      .optional(),
    providerId: z.string().optional(),
    model: z.string().optional()
  })
  // 允许「只发图不发字」，但两者不能同时为空
  .refine((value) => value.content.trim().length > 0 || (value.images?.length ?? 0) > 0, {
    message: '消息不能为空'
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

  ipcMain.handle(IPC.conversationDelete, async (_event, id: string) => {
    agentRuntime.abortConversation(id)
    repo.deleteConversation(id)
    // 方案 A：会话没了，图片目录同步删掉，不在磁盘上留垃圾
    await deleteConversationImages(id)
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

  ipcMain.handle(IPC.chatSend, async (_event, payload: unknown) => {
    const parsed = SendPayloadSchema.parse(payload)
    const conversationId = parsed.conversationId

    // 落盘并把字节换成相对路径：DB 里从此不再有 base64
    const images: ResolvedImage[] = []
    for (const attachment of parsed.images ?? []) {
      if (attachment.data.byteLength > MAX_IMAGE_BYTES) {
        throw new Error('单张图片过大，请压缩后再发送')
      }
      const file = await saveImage(conversationId, attachment.mimeType, attachment.data)
      images.push({ mimeType: attachment.mimeType, file })
    }

    return agentRuntime.send({ ...parsed, images: images.length > 0 ? images : undefined }, broadcast)
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

  // 渲染进程传来的一切都在这里校验；排队消息的编辑/撤回只允许作用于本会话
  ipcMain.handle(
    IPC.chatEditQueued,
    (_event, conversationId: unknown, userMessageId: unknown, content: unknown) => {
      const conv = z.string().min(1).parse(conversationId)
      const id = z.string().min(1).parse(userMessageId)
      const text = z.string().min(1, '内容不能为空').parse(content)
      return agentRuntime.editQueuedMessage(conv, id, text)
    }
  )

  ipcMain.handle(
    IPC.chatCancelQueued,
    async (_event, conversationId: unknown, userMessageId: unknown) => {
      const conv = z.string().min(1).parse(conversationId)
      const id = z.string().min(1).parse(userMessageId)
      return agentRuntime.cancelQueuedMessage(conv, id)
    }
  )

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

  /* MCP 实时状态（设置页列表数据源，全部实测） ------------------------ */

  ipcMain.handle(IPC.mcpStatus, () => mcpManager.status())

  ipcMain.handle(IPC.appInfo, (): AppInfo => {

  ipcMain.handle(IPC.appContextStatics, async () => agentRuntime.contextStatics())
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