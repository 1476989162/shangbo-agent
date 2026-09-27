import log from 'electron-log/main'
import { getSetting } from '../settings'
import { McpClient } from './client'
import type { ToolSchema } from '../providers/types'

/**
 * MCP 服务管理器：配置 → 拉起进程 → 工具聚合 → 调用转发。
 *
 * 命名：远端工具以 `mcp__<服务>__<工具>` 暴露给模型，前缀保证不与本地工具撞名。
 * 存活：进程一旦拉起就常驻复用，回合结束不杀，避免每轮重复握手。
 * 失败：单个服务起不来只记日志跳过，不炸整轮（与网关降级同一哲学）。
 */

export interface McpServerConfig {
  id: string
  name: string
  command: string
  args: string[]
  env?: Record<string, string>
  enabled: boolean
}

const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx'

/**
 * 内置服务（已实测协议，逐个加，不靠猜写死）。
 * 已接入：memory、fetch、playwright（25 工具）、github（45 工具）、chrome-devtools（30 工具）、context7（2 工具）、duckduckgo（1 工具）、docker（网关 8 工具）。
 * 全部经 handshake + tools/list 实测。
 */
export const BUILTIN_MCP_SERVERS: McpServerConfig[] = [
  {
    id: 'memory',
    name: 'Memory',
    command: NPX,
    args: ['-y', '@modelcontextprotocol/server-memory'],
    enabled: true
  },
  {
    id: 'fetch',
    name: 'Fetch',
    command: NPX,
    args: ['-y', '@modelcontextprotocol/server-fetch'],
    enabled: true
  },
  {
    id: 'playwright',
    name: 'Playwright',
    command: NPX,
    args: ['-y', '@playwright/mcp'],
    enabled: true
  },
  {
    id: 'github',
    name: 'GitHub',
    command: 'docker',
    args: ['run', '-i', '--rm', '-e', 'GITHUB_PERSONAL_ACCESS_TOKEN', 'ghcr.io/github/github-mcp-server'],
    env: { GITHUB_PERSONAL_ACCESS_TOKEN: '${GITHUB_PERSONAL_ACCESS_TOKEN}' },
    enabled: true
  },
  {
    id: 'chrome-devtools',
    name: 'Chrome DevTools',
    command: NPX,
    args: ['-y', 'chrome-devtools-mcp'],
    enabled: true
  },
  {
    id: 'context7',
    name: 'Context7',
    command: NPX,
    args: ['-y', '@upstash/context7-mcp'],
    enabled: true
  },
  {
    id: 'duckduckgo',
    name: 'DuckDuckGo',
    command: NPX,
    args: ['-y', 'duckduckgo-mcp-server'],
    enabled: true
  },
  {
    id: 'docker',
    name: 'Docker',
    command: 'docker',
    args: ['mcp', 'gateway', 'run', '--transport', 'stdio'],
    enabled: true
  }
]

function slug(text: string): string {
  return text.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/__+/g, '_')
}

/**
 * 环境变量展开：配置里写 `${VAR_NAME}`，启动时用进程环境变量替换。
 * 密钥绝不进仓库与数据库：用户在 Windows 用户环境变量里设一次即可。
 * 返回展开后的 env 与缺失的变量名（缺失则跳过该服务并明说）。
 */
export function resolveEnv(env: Record<string, string>): { env: Record<string, string>; missing: string[] } {
  const out: Record<string, string> = {}
  const missing: string[] = []
  for (const [key, raw] of Object.entries(env)) {
    const expanded = raw.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name: string) => process.env[name] ?? '')
    out[key] = expanded
    if (/\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(raw) && !expanded) missing.push(key)
  }
  return { env: out, missing }
}

export function mcpToolName(serverId: string, toolName: string): string {
  return `mcp__${slug(serverId)}__${slug(toolName)}`
}

/** 解析 mcp__server__tool，tool 部分允许含 __（用首段切分、余下拼回）。 */
export function parseMcpToolName(name: string): { serverId: string; toolName: string } | null {
  if (!name.startsWith('mcp__')) return null
  const parts = name.slice('mcp__'.length).split('__')
  if (parts.length < 2 || !parts[0] || parts.slice(1).some((p) => !p)) return null
  return { serverId: parts[0], toolName: parts.slice(1).join('__') }
}

/**
 * 生效配置 = 用户全量覆盖（agent.mcp.servers）否则内置；
 * 再与设置页开关（agent.mcpServers，渲染端 toggles 写的 id 白名单）取交集，
 * 保证界面开关继续有效。
 */
export function loadServerConfigs(): McpServerConfig[] {
  const configured = getSetting<McpServerConfig[]>('agent.mcp.servers', BUILTIN_MCP_SERVERS)
  const legacy = getSetting<string[] | null>('agent.mcpServers', null)
  return configured
    .filter((s) => s && s.id && s.command)
    .map((s) => ({ ...s, id: slug(s.id) }))
    .filter((s) => s.enabled && (!Array.isArray(legacy) || legacy.includes(s.id)))
}

interface LiveServer {
  client: McpClient
  tools: { name: string; description?: string; inputSchema: Record<string, unknown> }[]
}

export class McpManager {
  private live = new Map<string, LiveServer>()
  private starting = new Map<string, Promise<LiveServer | null>>()
  private lastError = new Map<string, string>()

  /** 设置页用的实时状态：开关、进程死活、工具清单，全部实测。 */
  async status(): Promise<
    { id: string; name: string; enabled: boolean; state: 'ready' | 'error' | 'disabled'; toolCount: number; tools: { name: string; description?: string }[]; error?: string }[]
  > {
    const out: {
      id: string
      name: string
      enabled: boolean
      state: 'ready' | 'error' | 'disabled'
      toolCount: number
      tools: { name: string; description?: string }[]
      error?: string
    }[] = []
    // 关掉的服务不拉进程，直接标 disabled（不验证死活）。
    const all = getSetting<McpServerConfig[]>('agent.mcp.servers', BUILTIN_MCP_SERVERS)
      .filter((s) => s && s.id && s.command)
      .map((s) => ({ ...s, id: slug(s.id) }))
    const legacy = getSetting<string[] | null>('agent.mcpServers', null)
    for (const config of all) {
      const enabled = config.enabled && (!Array.isArray(legacy) || legacy.includes(config.id))
      if (!enabled) {
        out.push({ id: config.id, name: config.name, enabled: false, state: 'disabled', toolCount: 0, tools: [] })
        continue
      }
      const live = await this.ensureStarted(config)
      if (!live) {
        out.push({
          id: config.id,
          name: config.name,
          enabled: true,
          state: 'error',
          toolCount: 0,
          tools: [],
          error: this.lastError.get(config.id) ?? '启动失败'
        })
        continue
      }
      out.push({
        id: config.id,
        name: config.name,
        enabled: true,
        state: 'ready',
        toolCount: live.tools.length,
        tools: live.tools.map((t) => ({ name: t.name, description: t.description }))
      })
    }
    return out
  }

  /** 聚合所有已启用服务的工具清单（顺手拉起还没起的进程）。 */
  async toolSchemas(): Promise<ToolSchema[]> {
    const out: ToolSchema[] = []
    for (const config of loadServerConfigs()) {
      const live = await this.ensureStarted(config)
      if (!live) continue
      for (const tool of live.tools) {
        out.push({
          name: mcpToolName(config.id, tool.name),
          description: `[${config.name}] ${tool.description ?? tool.name}`,
          parameters: tool.inputSchema
        })
      }
    }
    return out
  }

  async callTool(
    serverId: string,
    toolName: string,
    args: unknown,
    signal?: AbortSignal
  ): Promise<{ content: string; isError: boolean }> {
    const config = loadServerConfigs().find((s) => s.id === serverId)
    if (!config) return { content: `MCP 服务未配置或未启用：${serverId}`, isError: true }
    const live = await this.ensureStarted(config)
    if (!live) return { content: `MCP 服务启动失败：${config.name}，已跳过`, isError: true }
    try {
      return await live.client.callTool(toolName, args, signal)
    } catch (error) {
      return { content: `MCP 调用失败：${error instanceof Error ? error.message : String(error)}`, isError: true }
    }
  }

  async shutdown(): Promise<void> {
    const clients = [...this.live.values()].map((s) => s.client)
    this.live.clear()
    this.starting.clear()
    await Promise.all(clients.map((c) => c.stop().catch(() => undefined)))
  }

  private ensureStarted(config: McpServerConfig): Promise<LiveServer | null> {
    const existing = this.live.get(config.id)
    if (existing) return Promise.resolve(existing)
    const ongoing = this.starting.get(config.id)
    if (ongoing) return ongoing
    const task = (async (): Promise<LiveServer | null> => {
      try {
        const { env, missing } = resolveEnv(config.env ?? {})
        if (missing.length > 0) {
          log.warn(`[mcp] ${config.name} 缺少环境变量（${missing.join('、')}），已跳过：请设置后重启应用`)
          return null
        }
        const client = await McpClient.start({ command: config.command, args: config.args, env })
        const tools = await client.listTools()
        const live: LiveServer = { client, tools }
        this.live.set(config.id, live)
        this.lastError.delete(config.id)
        log.info(`[mcp] 服务已就绪：${config.name}（${tools.length} 个工具）`)
        return live
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        log.warn(`[mcp] 服务启动失败，已跳过：${config.name}：${message}`)
        this.lastError.set(config.id, message)
        return null
      } finally {
        this.starting.delete(config.id)
      }
    })()
    this.starting.set(config.id, task)
    return task
  }
}

export const mcpManager = new McpManager()
