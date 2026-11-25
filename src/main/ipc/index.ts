import { extname } from 'node:path'
import fs from 'node:fs'
import log from 'electron-log/main'
import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron'
import { z } from 'zod'
import { IPC } from '../../shared/ipc'
import { bridgeEventsToWindow } from '../events/bus'
import { remoteService } from '../remote/service'
import { listRemoteAudit } from '../remote/audit'
import * as repo from '../db/repo'
import { getDbPath } from '../db'
import { getAllSettings, getSetting, setSetting } from '../settings'
import { parseSettingValue } from '../settingsSchema'
import { toolRegistry } from '../tools'
import { checkTerminalCommand } from './terminalGuard'
import { probeChromeDebugging } from '../browserProbe'
import { agentRuntime } from '../agent/runtime'
import { cCoreBridge } from '../agent/cCoreBridge'
import {
  adapterForKind,
  deleteProvider,
  getApiKey,
  getProvider,
  listProviders,
  upsertProvider,
  LOCAL_ENGINE_BASE_URL
} from '../providers/store'
import {
  probePolyStrataHealth,
  probeRealHardware,
  recommendLocalModel,
  verifyLocalModelReady
} from '../providers/autopilot'
import { probeProvider } from '../providers/gateway'
import { mcpManager } from '../mcp/manager'
import { updateService } from '../update'
import { getInstallInfo } from '../installInfo'
import { exportConversation } from '../exporter'
import { markQuitting } from '../windows/mainWindow'
import { autonomousScheduler } from '../autonomous/scheduler'
import * as autonomousStore from '../autonomous/store'
import {
  deleteConversationImages,
  MAX_IMAGE_BYTES,
  saveImage,
  type ResolvedImage
} from '../storage/images'
import { listViewerDir, openViewerFile, readViewerFile, VIEWER_MAX_BYTES } from '../files/viewer'
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

const LocalModelVerifySchema = z.object({
  baseUrl: z.string().url('Base URL 必须是合法地址'),
  model: z.string().min(1, '模型名不能为空'),
  apiKey: z.string().optional()
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
    model: z.string().optional(),
    viewMode: z.enum(['cowork', 'code']).optional(),
    worktree: z.boolean().optional()
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

/**
 * 阶段1：桌面窗口改为订阅事件总线（行为不变）。
 * AgentRuntime 的 emit 经 withBus 包装后会自动 publish 到总线，
 * 这里的订阅只负责把总线事件转发给桌面窗口；远程模块另行订阅。
 */
let desktopBridgeDisposer: (() => void) | null = null

function ensureDesktopBridge(): void {
  if (desktopBridgeDisposer) return
  desktopBridgeDisposer = bridgeEventsToWindow(broadcast)
}

export function registerIpcHandlers(): void {
  ensureDesktopBridge()
  /* 会话 ---------------------------------------------------------- */

  ipcMain.handle(IPC.conversationList, () => repo.listConversations())

  const ConversationCreateSchema = z.union([
    z.string().min(1).max(300),
    z.object({
      title: z.string().min(1).max(300).optional(),
      workingDir: z.string().max(1000).nullable().optional(),
      projectId: z.string().max(200).nullable().optional(),
      mode: z.enum(['auto', 'chat', 'builder', 'wish']).nullable().optional()
    })
  ])

  ipcMain.handle(
    IPC.conversationCreate,
    (_event, inputRaw: unknown) => {
      // 渲染层不可信：input 未过校验前连 typeof 分支都不能信
      const input = ConversationCreateSchema.nullish().parse(inputRaw) ?? {}
      const workingDir0 = typeof input === 'object' ? (input.workingDir ?? null) : null
      let workingDir = workingDir0
      if (!workingDir) {
        const coworkPath = getSetting<string>('cowork.filesPath', '')
        if (coworkPath && fs.existsSync(coworkPath)) {
          workingDir = coworkPath
        }
      }
      if (typeof input === 'string') {
        return repo.createConversation({ title: input, workingDir })
      }
      return repo.createConversation({
        title: input.title ?? '新对话',
        workingDir,
        projectId: input.projectId ?? null,
        mode: input.mode ?? null
      })
    }
  )

  ipcMain.handle(IPC.conversationRename, (_event, idRaw: unknown, titleRaw: unknown) => {
    const id = z.string().min(1).max(100).parse(idRaw)
    const title = z.string().min(1).max(500).parse(titleRaw)
    repo.updateConversation(id, { title: title.trim() || '新对话' })
    return repo.getConversation(id)
  })

  ipcMain.handle(IPC.conversationDelete, async (_event, idRaw: unknown) => {
    const id = z.string().min(1).max(100).parse(idRaw)
    agentRuntime.abortConversation(id)
    repo.deleteConversation(id)
    // 方案 A：会话没了，图片目录同步删掉，不在磁盘上留垃圾
    await deleteConversationImages(id)
    return true
  })

  ipcMain.handle(IPC.conversationMessages, (_event, conversationIdRaw: unknown) => {
    const conversationId = z.string().min(1).max(100).parse(conversationIdRaw)
    return {
      messages: repo.listMessages(conversationId),
      activeLeafId: repo.getActiveLeaf(conversationId)
    }
  })

  ipcMain.handle(IPC.conversationSetLeaf, (_event, conversationIdRaw: unknown, leafIdRaw: unknown) => {
    const conversationId = z.string().min(1).max(100).parse(conversationIdRaw)
    const leafId = z.string().min(1).max(100).parse(leafIdRaw)
    repo.setActiveLeaf(conversationId, leafId)
    return true
  })

  ipcMain.handle(IPC.conversationSetWorkingDir, (_event, conversationIdRaw: unknown, dirRaw: unknown) => {
    const conversationId = z.string().min(1).max(100).parse(conversationIdRaw)
    const dir = z.string().max(1000).nullable().parse(dirRaw)
    repo.updateConversation(conversationId, { workingDir: dir })
    return repo.getConversation(conversationId)
  })

  ipcMain.handle(IPC.conversationSetMode, (_event, conversationId: unknown, mode: unknown) => {
    const id = z.string().min(1).parse(conversationId)
    const parsed = z.enum(['auto', 'chat', 'builder', 'wish']).nullable().parse(mode)
    repo.updateConversation(id, { mode: parsed })
    return repo.getConversation(id)
  })

  ipcMain.handle(IPC.conversationExport, (_event, conversationIdRaw: unknown) =>
    exportConversation(z.string().min(1).max(100).parse(conversationIdRaw))
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

    return agentRuntime.send(
      { ...parsed, images: images.length > 0 ? images : undefined },
      // 事件只走总线：withBus 会 publish，桌面桥接订阅者负责 broadcast。
      // 若这里再传 broadcast，同一事件会被发给窗口两次，导致流式文本重复。
      agentRuntime.withBus(() => {})
    )
  })

  ipcMain.handle(IPC.chatAbort, (_event, runIdRaw: unknown) => {
    const runId = z.string().min(1).max(100).parse(runIdRaw)
    agentRuntime.abort(runId)
    return true
  })

  // 停止整个会话：中断正在跑的 + 清空排队。渲染层"停止"按钮走这里，
  // 而不是只 abort 单轮——否则下一条自动接力，看起来像"停不掉"。
  ipcMain.handle(IPC.chatStopConversation, (_event, conversationId: string) => {
    const id = z.string().min(1).parse(conversationId)
    return agentRuntime.abortConversationRuns(id)
  })

  // 排队消息转"指导当前轮"：注入正在跑回合的上下文，不新开回合
  ipcMain.handle(IPC.chatSteerQueued, (_event, conversationId: unknown, userMessageId: unknown) => {
    const conv = z.string().min(1).parse(conversationId)
    const id = z.string().min(1).parse(userMessageId)
    return agentRuntime.steerRunningRound(conv, id)
  })

  ipcMain.handle(IPC.chatApprove, (_event, decision: unknown) => {
    agentRuntime.decide(ApprovalSchema.parse(decision))
    return true
  })

  // 切回会话时对账用：主进程内存里的真实运行态（是否在跑、在等哪个审批、任务清单）
  ipcMain.handle(IPC.chatRuntimeState, (_event, conversationId: unknown) => {
    const id = z.string().min(1).parse(conversationId)
    return agentRuntime.conversationRuntimeState(id)
  })

  ipcMain.handle(IPC.chatRegenerate, (_event, assistantMessageIdRaw: unknown) =>
    agentRuntime.regenerate(z.string().min(1).max(100).parse(assistantMessageIdRaw), agentRuntime.withBus(() => {}))
  )

  /* 供应商 -------------------------------------------------------- */

  ipcMain.handle(IPC.providerList, () => listProviders())

  ipcMain.handle(IPC.providerUpsert, (_event, input: unknown) =>
    upsertProvider(ProviderInputSchema.parse(input) as ProviderInput)
  )

  ipcMain.handle(IPC.providerDelete, (_event, idRaw: unknown) => {
    const id = z.string().min(1).max(200).parse(idRaw)
    deleteProvider(id)
    return true
  })

  // Model Autopilot：探测真实 GPU/显存与本地推理引擎状态，并给出模型推荐。
  ipcMain.handle(IPC.providerAutopilotProbe, async () => {
    const hardware = await probeRealHardware()
    const health = await probePolyStrataHealth(LOCAL_ENGINE_BASE_URL.replace(/\/v1$/, ''))
    return { hardware, health, pick: recommendLocalModel(hardware) }
  })

  // 真题验活：只有模型真能用一个最小问题答上来，才算「就绪」。
  ipcMain.handle(IPC.providerAutopilotVerify, async (_event, input: unknown) => {
    const parsed = LocalModelVerifySchema.parse(input)
    return verifyLocalModelReady(parsed.baseUrl, parsed.model, parsed.apiKey)
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

  ipcMain.handle(IPC.providerTest, async (_event, idRaw: unknown) => {
    const id = z.string().min(1).max(200).parse(idRaw)
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

  ipcMain.handle(IPC.settingsSet, (_event, key: unknown, value: unknown) => {
    const name = z.string().min(1).parse(key)
    // 白名单 + 类型校验：渲染层不可信，未知键/越界值/篡改自动批准名单都在这里挡下
    const parsed = parseSettingValue(name, value, {
      knownToolNames: toolRegistry.all().map((tool) => tool.name)
    })
    setSetting(name, parsed)
    // 更新开关改完立即生效，不必等重启
    if (name.startsWith('app.update.')) updateService.syncSettings()
    // MCP 开关改完清掉 status() 30 秒缓存，下一次 refresh 立即可见
    if (name === 'agent.mcpServers' || name === 'agent.mcp.servers') {
      mcpManager.invalidateStatusCache()
    }
    // 远程开关/地址/准入密钥/策略改完立即生效
    if (
      name === 'remote.enabled' ||
      name === 'remote.relayUrl' ||
      name === 'remote.accessKey' ||
      name === 'remote.approvalPolicy'
    ) {
      remoteService.sync()
    }
    if (name === 'agent.autonomous.enabled') autonomousScheduler.kick()
    return true
  })

  /* Token 用量真实统计 -------------------------------------------- */

  ipcMain.handle(IPC.usageGetStats, (_event, daysRaw: unknown) => {
    // 类型兜底换 zod：非数字/越界直接拒，不再静默回落 30
    const numDays = z.number().int().min(1).max(365).parse(daysRaw)
    return repo.getUsageStats(numDays)
  })

  /* MCP 实时状态（设置页列表数据源，全部实测） ------------------------ */

  ipcMain.handle(IPC.mcpStatus, () => mcpManager.status())

  ipcMain.handle(IPC.appContextStatics, async () => agentRuntime.contextStatics())

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
      username: process.env.USERNAME || process.env.USER || 'Administrator',
      cCoreEngine: cCoreBridge.getStatus(),
      ...getInstallInfo()
    }
  })

  ipcMain.handle(IPC.cCoreStatus, () => {
    return cCoreBridge.getStatus()
  })

  ipcMain.handle(IPC.cCoreAudit, async (_event, command: unknown) => {
    const cmd = typeof command === 'string' ? command : ''
    return cCoreBridge.auditHardLines(cmd)
  })

  ipcMain.handle(IPC.appWindowTheme, (_event, theme: unknown) => {
    const parsed = z.enum(['light', 'dark']).parse(theme)
    const colors =
      parsed === 'dark'
        ? { background: '#0C0E12', symbol: '#E8EBF1' }
        : { background: '#F5F7FA', symbol: '#171B23' }
    for (const win of BrowserWindow.getAllWindows()) {
      win.setBackgroundColor(colors.background)
      try {
        win.setTitleBarOverlay({
          color: colors.background,
          symbolColor: colors.symbol,
          height: 40
        })
      } catch {
        // 非 Windows 或未启用 overlay 时忽略
      }
    }
    return true
  })

  ipcMain.handle(IPC.appGitBranch, async (_event, dir: unknown) => {
    const parsed = z.string().nullable().safeParse(dir)
    if (!parsed.success || !parsed.data) return ''
    try {
      const { execFile } = await import('node:child_process')
      const { promisify } = await import('node:util')
      const exec = promisify(execFile)
      const { stdout } = await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd: parsed.data,
        timeout: 2000
      })
      return stdout.trim() || ''
    } catch {
      return ''
    }
  })

  ipcMain.handle(IPC.appGitDiff, async (_event, dir: unknown) => {
    const parsed = z.string().nullable().safeParse(dir)
    if (!parsed.success || !parsed.data) return ''
    try {
      const { execFile } = await import('node:child_process')
      const { promisify } = await import('node:util')
      const exec = promisify(execFile)
      const { stdout } = await exec('git', ['diff', 'HEAD'], {
        cwd: parsed.data,
        timeout: 5000
      })
      return stdout || ''
    } catch {
      return ''
    }
  })

  ipcMain.handle(IPC.appGitStatus, async (_event, dir: unknown) => {
    const parsed = z.string().nullable().safeParse(dir)
    if (!parsed.success || !parsed.data) return ''
    try {
      const { execFile } = await import('node:child_process')
      const { promisify } = await import('node:util')
      const exec = promisify(execFile)
      const { stdout } = await exec('git', ['status', '--short'], {
        cwd: parsed.data,
        timeout: 5000
      })
      return stdout || ''
    } catch {
      return ''
    }
  })

  ipcMain.handle(IPC.browserChromeStatus, async () => ({
    connected: await probeChromeDebugging()
  }))

  ipcMain.handle(IPC.browserClearData, async () => {
    try {
      const ses = session.defaultSession
      await ses.clearStorageData()
      await ses.clearCache()
      return true
    } catch (e) {
      log.error('[browser] clearStorageData 失败', e)
      return false
    }
  })

  ipcMain.handle(IPC.appToggleDevTools, () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (win) {
      win.webContents.toggleDevTools()
      return true
    }
    return false
  })

  ipcMain.handle(IPC.appOpenPath, async (_event, targetPath: unknown) => {
    // 收紧：UNC 路径（\\server\share）指向网内任意主机，渲染层被注入时可用它探测内网；
    // 高危可执行类型直接拒，只放行文档/媒体/压缩包等。
    const p = z.string().min(1).max(1000).parse(targetPath)
    if (process.platform === 'win32' && /^(?:\\\\|\/\/)/.test(p)) {
      log.warn(`[ipc] app:openPath 拒绝 UNC 路径：${p}`)
      return '已拒绝：不允许打开 UNC 网络路径。'
    }
    const ext = extname(p).slice(1).toLowerCase()
    const EXECUTABLE_EXTS = new Set([
      'exe', 'bat', 'cmd', 'com', 'scr', 'pif', 'msi', 'msp', 'mst',
      'ps1', 'psm1', 'vbs', 'vbe', 'js', 'jse', 'wsf', 'wsh', 'hta', 'cpl', 'jar', 'lnk'
    ])
    if (EXECUTABLE_EXTS.has(ext)) {
      log.warn(`[ipc] app:openPath 拒绝可执行类型：${p}`)
      return `已拒绝：不允许用系统默认程序打开 .${ext} 可执行文件。`
    }
    return shell.openPath(p)
  })

  ipcMain.handle(IPC.appExecCommand, async (_event, cmdRaw: unknown, dirRaw?: unknown) => {
    const cmd = z.string().min(1).parse(cmdRaw)
    const cwd = typeof dirRaw === 'string' && dirRaw ? dirRaw : process.cwd()
    // 工作台终端与工具层共用同一套护栏，原因见 terminalGuard.ts。
    const guard = checkTerminalCommand(cmd, cwd)
    if (guard.blocked) {
      return { stdout: '', stderr: guard.reason ?? '已拒绝执行。', exitCode: 1 }
    }
    const { exec } = await import('node:child_process')
    const { promisify } = await import('node:util')
    const execAsync = promisify(exec)
    const configuredShell = getSetting<string>('code.defaultShell', '').trim()
    const shellExe = configuredShell || (process.platform === 'win32' ? 'powershell.exe' : '/bin/sh')
    try {
      const { stdout, stderr } = await execAsync(cmd, {
        cwd,
        timeout: 30000,
        maxBuffer: 10 * 1024 * 1024,
        shell: shellExe
      })
      return { stdout: stdout ?? '', stderr: stderr ?? '', exitCode: 0 }
    } catch (err: any) {
      return {
        stdout: err.stdout ?? '',
        stderr: err.stderr ?? err.message ?? String(err),
        exitCode: typeof err.code === 'number' ? err.code : 1
      }
    }
  })

  ipcMain.handle(IPC.configExport, async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const opts = {
      title: '导出配置与经验库',
      defaultPath: `shangbo-config-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON 文件', extensions: ['json'] }]
    }
    const { canceled, filePath } = win
      ? await dialog.showSaveDialog(win, opts)
      : await dialog.showSaveDialog(opts)
    if (canceled || !filePath) return { ok: false, message: '已取消' }
    const settings = getAllSettings()
    const lessons = autonomousStore.listLessons({})
    const payload = { version: app.getVersion(), exportedAt: Date.now(), settings, lessons }
    const fsPromises = await import('node:fs/promises')
    await fsPromises.writeFile(filePath, JSON.stringify(payload, null, 2), 'utf-8')
    return { ok: true, path: filePath }
  })

  ipcMain.handle(IPC.configImport, async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const opts = {
      title: '选择恢复配置文件',
      filters: [{ name: 'JSON 文件', extensions: ['json'] }],
      properties: ['openFile' as const]
    }
    const { canceled, filePaths } = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts)
    if (canceled || filePaths.length === 0) return { ok: false, message: '已取消' }
    const fsPromises = await import('node:fs/promises')
    const raw = await fsPromises.readFile(filePaths[0], 'utf-8')
    const parsed = JSON.parse(raw)
    if (parsed.settings && typeof parsed.settings === 'object') {
      // 与 settings:set 同源校验：含 knownToolNames，防导入伪造的自动批准名单
      for (const [k, v] of Object.entries(parsed.settings)) {
        try {
          const val = parseSettingValue(k, v, {
            knownToolNames: toolRegistry.all().map((tool) => tool.name)
          })
          setSetting(k, val)
        } catch (error) {
          // 单键非法不阻断整体导入，但要留诊断线索（静默 catch 是红线）
          log.warn(`[ipc] configImport 拒收设置键 ${k}`, error)
        }
      }
    }
    if (Array.isArray(parsed.lessons)) {
      // lessons 同样是不可信导入：标题/内容必须是有限字符串，超量拒收
      const LessonSchema = z.object({ title: z.string().min(1).max(500), content: z.string().min(1).max(20_000) })
      let imported = 0
      for (const item of parsed.lessons) {
        const lesson = LessonSchema.safeParse(item)
        if (!lesson.success) {
          log.warn('[ipc] configImport 拒收非法 lesson 条目')
          continue
        }
        try {
          autonomousStore.upsertLesson(lesson.data)
          imported++
        } catch (error) {
          log.warn('[ipc] configImport lesson 写入失败', error)
        }
      }
      log.info(`[ipc] configImport 导入 lessons ${imported} 条`)
    }
    return { ok: true, message: '配置与经验库已恢复' }
  })

  ipcMain.handle(IPC.conversationsExportAll, async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const opts = {
      title: '导出全部会话记录',
      defaultPath: `shangbo-conversations-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: 'JSON 文件', extensions: ['json'] }]
    }
    const { canceled, filePath } = win
      ? await dialog.showSaveDialog(win, opts)
      : await dialog.showSaveDialog(opts)
    if (canceled || !filePath) return { ok: false, message: '已取消' }
    const convs = repo.listConversations()
    const all = convs.map((c) => ({
      conversation: c,
      messages: repo.listMessages(c.id)
    }))
    const fsPromises = await import('node:fs/promises')
    await fsPromises.writeFile(filePath, JSON.stringify(all, null, 2), 'utf-8')
    return { ok: true, path: filePath }
  })

  ipcMain.handle(IPC.windowHide, () => {
    BrowserWindow.getFocusedWindow()?.hide()
    return true
  })

  /** 系统目录选择对话框；取消时返回 null。 */
  ipcMain.handle(IPC.dialogPickFolder, async () => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    const opts = {
      title: '选择项目文件夹',
      properties: ['openDirectory' as const, 'createDirectory' as const]
    }
    const result = win
      ? await dialog.showOpenDialog(win, opts)
      : await dialog.showOpenDialog(opts)
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0]
  })

  /* 右侧查看器：受限文件通道（仅当前会话工程目录内） ------------------ */

  ipcMain.handle(IPC.fileRead, async (_event, conversationId: unknown, relPath: unknown) => {
    const convo = z.string().min(1).parse(conversationId)
    const rel = z.string().min(1).max(2000).parse(relPath)
    // 路径穿越在 resolveViewerPath 里二次校验：zod 只拦超长与空串
    const file = await readViewerFile(convo, rel)
    // IPC 序列化上限兜底：dataUrl 超 14MB 字符直接拒绝，避免窗口间传输卡死
    if (file.dataUrl && file.dataUrl.length > 14_000_000) {
      throw new Error('文件过大，无法在面板内预览，请用系统默认应用打开。')
    }
    void VIEWER_MAX_BYTES
    return file
  })

  ipcMain.handle(IPC.fileList, async (_event, conversationId: unknown, relPath: unknown) => {
    const convo = z.string().min(1).parse(conversationId)
    const rel = relPath === undefined ? '.' : z.string().max(2000).parse(relPath)
    return listViewerDir(convo, rel || '.')
  })

  ipcMain.handle(IPC.fileOpen, async (_event, conversationId: unknown, relPath: unknown) => {
    const convo = z.string().min(1).parse(conversationId)
    const rel = z.string().min(1).max(2000).parse(relPath)
    return openViewerFile(convo, rel)
  })

  ipcMain.handle(IPC.windowQuit, () => {
    markQuitting()
    app.quit()
    return true
  })

  /* 应用自更新 ----------------------------------------------------------
     渲染层只能"请求"，能不能下载、能不能安装由主进程的状态机裁决，
     避免伪造一次 IPC 就触发退出安装。 */

  ipcMain.handle(IPC.updateStatus, () => updateService.getState())

  ipcMain.handle(IPC.updateCheck, () => updateService.check())

  ipcMain.handle(IPC.updateDownload, () => updateService.download())

  ipcMain.handle(IPC.updateInstall, () => updateService.install())

  /* 手机远程（只能桌面本机调用；远程通道无 settings:set，见 remote/handler） */

  // 开关变更即时生效：remote.enabled / remote.relayUrl 改完立即 sync，不断开重连
  ipcMain.handle(IPC.remoteStatus, () => remoteService.getStatus())

  ipcMain.handle(IPC.remotePair, async (_event, phoneName: unknown) => {
    const name = typeof phoneName === 'string' ? phoneName : ''
    return remoteService.issuePairing(name)
  })

  ipcMain.handle(IPC.remoteDevices, () => remoteService.listDevices())

  ipcMain.handle(IPC.remotePending, () => remoteService.listPendingPairings())

  ipcMain.handle(IPC.remoteConfirmPairing, async (_event, phoneToken: string) =>
    remoteService.confirmPendingPairing(z.string().min(1).parse(phoneToken))
  )

  ipcMain.handle(IPC.remoteDenyPairing, async (_event, phoneToken: string) =>
    remoteService.denyPendingPairing(z.string().min(1).parse(phoneToken))
  )

  ipcMain.handle(IPC.remoteIdentity, () => remoteService.getIdentityInfo())

  ipcMain.handle(IPC.remoteRevoke, async (_event, idRaw: unknown) =>
    remoteService.revokeDevice(z.string().min(1).max(100).parse(idRaw))
  )

  ipcMain.handle(IPC.remoteDisconnect, () => {
    remoteService.disconnectAll()
    return true
  })

  /* 许愿式自主任务与经验 ------------------------------------------ */

  const AutonomousTaskSchema = z.object({
    id: z.string().optional(),
    name: z.string().min(1).max(200),
    prompt: z.string().min(1).max(50_000),
    acceptance: z.string().max(20_000).optional(),
    workingDir: z.string().min(1).max(2000),
    schedule: z.enum(['manual', 'interval']).optional(),
    intervalMinutes: z.number().int().min(1).max(43_200).nullable().optional(),
    verifyCommand: z.string().max(2000).optional(),
    maxVerifyAttempts: z.number().int().min(0).max(10).optional(),
    enabled: z.boolean().optional(),
    maxSteps: z.number().int().min(1).max(500).optional(),
    maxRunsPerDay: z.number().int().min(1).max(100).optional()
  })

  const LessonInputSchema = z.object({
    id: z.string().optional(),
    scope: z.enum(['global', 'project']).optional(),
    projectPath: z.string().max(2000).nullable().optional(),
    title: z.string().min(1).max(300),
    content: z.string().min(1).max(20_000),
    confidence: z.number().min(0).max(1).optional()
  })

  ipcMain.handle(IPC.autonomousList, () => autonomousScheduler.list())

  ipcMain.handle(IPC.autonomousSave, (_event, input: unknown) =>
    {
      const task = autonomousScheduler.save(AutonomousTaskSchema.parse(input))
      autonomousScheduler.kick()
      return task
    }
  )

  ipcMain.handle(IPC.autonomousDelete, (_event, id: unknown) => {
    autonomousScheduler.remove(z.string().min(1).parse(id))
    return true
  })

  ipcMain.handle(IPC.autonomousSetEnabled, (_event, id: unknown, enabled: unknown) =>
    {
      const task = autonomousScheduler.setEnabled(
        z.string().min(1).parse(id),
        z.boolean().parse(enabled)
      )
      autonomousScheduler.kick()
      return task
    }
  )

  ipcMain.handle(IPC.autonomousRunNow, (_event, id: unknown) =>
    autonomousScheduler.runNow(z.string().min(1).parse(id))
  )

  ipcMain.handle(IPC.autonomousRuns, (_event, taskId: unknown) => {
    const parsed = z.string().min(1).nullable().optional().parse(taskId)
    return autonomousStore.listRuns(parsed ?? undefined)
  })

  ipcMain.handle(IPC.autonomousPause, () => {
    autonomousScheduler.pause()
    return true
  })

  ipcMain.handle(IPC.autonomousResume, () => {
    autonomousScheduler.resume()
    return true
  })

  ipcMain.handle(IPC.autonomousStatus, () => ({
    paused: autonomousScheduler.isPaused(),
    enabled: getSetting<boolean>('agent.autonomous.enabled', false)
  }))

  ipcMain.handle(IPC.lessonsList, (_event, projectPath: unknown) => {
    const parsed = z.string().max(2000).nullable().optional().parse(projectPath)
    return parsed
      ? autonomousStore.listLessons({ projectPath: parsed })
      : autonomousStore.listLessons({ all: true })
  })

  ipcMain.handle(IPC.lessonsSave, (_event, input: unknown) =>
    autonomousStore.upsertLesson(LessonInputSchema.parse(input))
  )

  ipcMain.handle(IPC.lessonsDelete, (_event, id: unknown) => {
    autonomousStore.deleteLesson(z.string().min(1).parse(id))
    return true
  })

  // 兼容旧测试：审计查询走 settings 通道不合适，暂挂 remoteStatus 扩展返回
  void listRemoteAudit
}
