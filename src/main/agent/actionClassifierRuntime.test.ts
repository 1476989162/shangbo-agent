import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ToolOutcome } from './toolOutcome'

/* 回归测试：actionClassifierLlm 开关的真实接线（方案 A：保留开关、让它真干活）。
 * - fastClassifyAction 对 soft 返回 null（规则通道不再直接放行）；
 * - 开关打开时 runtime.ts 走 runActionClassifierLlm 提示性复核并记日志，
 *   仅硬红线才拦截执行，普通动作继续放行；
 * - 开关关闭时不触发 LLM，走常规审批链（v0.9.5 低打断口径）。
 * 注意：不触碰 versionDrift / safety / cCoreRuntimePath 既有断言。
 */

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/shangbo-test' },
  protocol: { handle: () => {}, registerSchemesAsPrivileged: () => {} }
}))

vi.mock('electron-log/main', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

const settingsMap: Record<string, unknown> = {}
vi.mock('../settings', () => ({
  getSetting: (key: string, fallback: unknown) =>
    key in settingsMap ? settingsMap[key] : fallback
}))

vi.mock('../db/repo', () => ({
  getConversation: () => ({ id: 'c1', mode: 'chat' })
}))

vi.mock('../tools', () => ({
  auditCommandSecurity: () => ({ isDangerous: false as boolean }),
  toolRegistry: {
    get: (name: string) => {
      if (name === 'probe_tool' || name === 'run_command') {
        return {
          name,
          requiresApproval: false,
          execute: async () => ({ content: 'PROBE-OK', isError: false })
        }
      }
      return undefined
    },
    all: () => []
  }
}))
vi.mock('../tools/todo', () => ({
  clearTodoItems: () => {},
  getTodoItems: () => []
}))
vi.mock('../mcp/manager', () => ({
  mcpManager: { toolSchemas: async () => [] },
  parseMcpToolName: (name: string) => name
}))
vi.mock('./subagent', () => ({
  runSubagent: async () => ({ content: '', isError: false }),
  SPAWN_SUBAGENT_SCHEMA: {},
  SPAWN_TOOL_NAME: 'spawn_subagent'
}))
vi.mock('../providers/gateway', () => ({
  // agentLoop 统一走网关真源判定推理模型；单测默认非推理模型
  isReasoningModel: () => false,
  streamWithFallback: (async function* () {}) as unknown as (...args: unknown[]) => AsyncGenerator<never>
}))
vi.mock('./cCoreBridge', () => ({
  cCoreBridge: {
    isAvailable: () => false,
    classifyToolCall: async () => null
  }
}))
vi.mock('./safety', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./safety')>()
  return {
    ...actual,
    // 统一用 soft verdict 走到复核分支；硬红线仅由 auditHardLines 判定
    classifyToolCall: () => ({ tier: 'soft', category: 'workspace', reason: 'soft 提示', autoApprovable: true }),
    auditHardLines: (cmd: unknown) =>
      typeof cmd === 'string' && cmd.includes('HARDLINE')
        ? { tier: 'hard', category: 'workspace', reason: '硬红线', autoApprovable: false }
        : actual.auditHardLines(String(cmd ?? '')),
    isAutoAllowed: () => true
  }
})
vi.mock('./injectionDetector', () => ({
  scanInjectionRules: async () => ({ level: 'none', reason: '', via: 'rule' }),
  scanInjection: async () => ({ level: 'none', reason: '', via: 'rule' })
}))
vi.mock('../skills/loader', () => ({
  getCachedSkillRouterPrompt: () => null,
  buildSkillRouterPrompt: async () => '',
  scanAllSkillPacks: async () => []
}))

const llmCalls: Array<{ toolName: string; input: unknown }> = []
vi.mock('./actionClassifier', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./actionClassifier')>()
  return {
    ...actual,
    runActionClassifierLlm: vi.fn(async (toolName: string, input: unknown) => {
      llmCalls.push({ toolName, input })
      return { decision: 'block', reason: 'LLM 认为可疑', via: 'llm' as const }
    })
  }
})

import { AgentRuntime } from './runtime'
import { runActionClassifierLlm } from './actionClassifier'

const emit = () => {}

function softCall(command: string) {
  return { id: 't1', name: 'probe_tool', input: { command } }
}

function softRunCommand(command: string) {
  return { id: 't1', name: 'run_command', input: { command } }
}

beforeEach(() => {
  for (const k of Object.keys(settingsMap)) delete settingsMap[k]
  llmCalls.length = 0
  vi.mocked(runActionClassifierLlm).mockClear()
})

describe('actionClassifierLlm 开关接线（方案 A）', () => {
  it('开关打开 + soft：触发 LLM 提示性复核；非硬红线不拦截，工具照常执行', async () => {
    settingsMap['agent.safety.actionClassifierLlm'] = true
    settingsMap['agent.autonomy'] = 'balanced'
    const rt = new AgentRuntime()
    const out: ToolOutcome = await (rt as unknown as Record<string, (...args: unknown[]) => Promise<ToolOutcome>>).invokeTool(
      'r1',
      'm1',
      softCall('echo hi'),
      'c1',
      null,
      emit,
      new AbortController()
    )
    // LLM 复核真实发生了（审的是同一个工具调用）
    expect(runActionClassifierLlm).toHaveBeenCalledTimes(1)
    expect(llmCalls[0].toolName).toBe('probe_tool')
    // 非硬红线：只记日志，不拦截，工具正常执行
    expect(out.isError).toBe(false)
    expect(out.content).toBe('PROBE-OK')
  })

  it('开关关闭：不触发 LLM，走常规链（低打断口径不变）', async () => {
    settingsMap['agent.safety.actionClassifierLlm'] = false
    settingsMap['agent.autonomy'] = 'balanced'
    const rt = new AgentRuntime()
    const out: ToolOutcome = await (rt as unknown as Record<string, (...args: unknown[]) => Promise<ToolOutcome>>).invokeTool(
      'r1',
      'm1',
      softCall('echo hi'),
      'c1',
      null,
      emit,
      new AbortController()
    )
    expect(runActionClassifierLlm).not.toHaveBeenCalled()
    expect(out.isError).toBe(false)
    expect(out.content).toBe('PROBE-OK')
  })

  it('LLM 判 block 且命中硬红线：拦截执行并返回复核理由', async () => {
    settingsMap['agent.safety.actionClassifierLlm'] = true
    settingsMap['agent.autonomy'] = 'balanced'
    const rt = new AgentRuntime()
    // 红线检查只看 run_command 的命令串，因此这里必须用 run_command 工具
    const out: ToolOutcome = await (rt as unknown as Record<string, (...args: unknown[]) => Promise<ToolOutcome>>).invokeTool(
      'r1',
      'm1',
      softRunCommand('do-evil HARDLINE'),
      'c1',
      null,
      emit,
      new AbortController()
    )
    expect(runActionClassifierLlm).toHaveBeenCalledTimes(1)
    expect(out.isError).toBe(true)
    expect(out.content).toContain('LLM 认为可疑')
  })
})
