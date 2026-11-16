import { describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/shangbo-test' }
}))
vi.mock('../settings', () => ({
  getSetting: (_key: string, fallback: unknown) => fallback
}))
const bridge = vi.hoisted(() => ({
  classifyToolCall: vi.fn(),
  scanInjectionRules: vi.fn(),
  executeTool: vi.fn()
}))
vi.mock('./cCoreBridge', () => ({
  cCoreBridge: {
    isAvailable: () => true,
    classifyToolCall: bridge.classifyToolCall,
    scanInjectionRules: bridge.scanInjectionRules,
    executeTool: bridge.executeTool
  }
}))

describe('运行时 C 主通道真实调用证据', () => {
  it('安全分级与注入扫描均先经过 C RPC', async () => {
    bridge.classifyToolCall.mockResolvedValue({ tier: 'auto', category: 'read', autoApprovable: true })
    bridge.scanInjectionRules.mockResolvedValue({ level: 'high', reason: 'C 检出高危。', via: 'rule' })
    const { toolRegistry } = await import('../tools')
    vi.spyOn(toolRegistry, 'get').mockReturnValue({
      name: 'read_file',
      description: '测试只读工具',
      parameters: { type: 'object', properties: {}, required: [] },
      requiresApproval: false,
      execute: async () => 'untrusted tool output'
    } as ReturnType<typeof toolRegistry.get>)
    const { AgentRuntime } = await import('./runtime')
    const runtime = new AgentRuntime() as unknown as {
      invokeTool: (...args: unknown[]) => Promise<{ content: string; isError: boolean }>
    }
    const result = await runtime.invokeTool(
      'run-1', 'message-1', { id: 'call-1', name: 'read_file', input: {} },
      'conversation-1', process.cwd(), () => {}, new AbortController()
    )
    expect(bridge.classifyToolCall).toHaveBeenCalledTimes(1)
    expect(bridge.scanInjectionRules).toHaveBeenCalledTimes(1)
    expect(result.content).toContain('C 检出高危。')
  })

  it('C 判 soft 而 TS 判 blocked 时仍拒绝执行，且 C 已被调用', async () => {
    bridge.classifyToolCall.mockResolvedValue({ tier: 'soft', category: 'system', autoApprovable: false })
    const { toolRegistry } = await import('../tools')
    const getTool = vi.spyOn(toolRegistry, 'get').mockReturnValue({
      name: 'run_command',
      description: '测试命令工具',
      parameters: { type: 'object', properties: {}, required: [] },
      requiresApproval: true,
      execute: async () => 'must not execute'
    } as ReturnType<typeof toolRegistry.get>)
    const { AgentRuntime } = await import('./runtime')
    const runtime = new AgentRuntime() as unknown as {
      invokeTool: (...args: unknown[]) => Promise<{ content: string; isError: boolean }>
    }
    const result = await runtime.invokeTool(
      'run-2', 'message-2', { id: 'call-2', name: 'run_command', input: { command: `rmdir /s /q ${process.cwd()}` } },
      'conversation-2', process.cwd(), () => {}, new AbortController()
    )
    expect(bridge.classifyToolCall).toHaveBeenCalledTimes(1)
    expect(result.isError).toBe(true)
    expect(result.content).toContain('已拒绝未执行')
    expect(result.content).not.toContain('must not execute')
    expect(getTool).toHaveBeenCalledWith('run_command')
    expect(bridge.scanInjectionRules).not.toHaveBeenCalled()
  })

  it('普通命令和子目录递归删除不弹审批，直接交给 C 执行', async () => {
    const originalVitest = process.env.VITEST
    process.env.CCORE_TOOL_DELEGATION = 'true'
    try {
      bridge.classifyToolCall.mockResolvedValue({ tier: 'soft', category: 'system', autoApprovable: false })
      bridge.scanInjectionRules.mockResolvedValue({ level: 'none', reason: '无注入特征。', via: 'rule' })
      bridge.executeTool.mockResolvedValue({ content: 'C 已执行', isError: false })
      const { toolRegistry } = await import('../tools')
      vi.spyOn(toolRegistry, 'get').mockReturnValue({
        name: 'run_command',
        description: '测试命令工具',
        parameters: { type: 'object', properties: {}, required: [] },
        requiresApproval: true,
        execute: async () => { throw new Error('不应回退到 TS 执行') }
      } as ReturnType<typeof toolRegistry.get>)
      const { AgentRuntime } = await import('./runtime')
      const runtime = new AgentRuntime() as unknown as {
        invokeTool: (...args: unknown[]) => Promise<{ content: string; isError: boolean }>
      }
      for (const [index, command] of [
        'dir K:\\ && echo current_files',
        'python -X utf8 tools\\\\probe8se.py',
        'wmic process where "name=\'chrome.exe\'" get ProcessId,ExecutablePath',
        'rmdir /s /q tools\\\\verify8se'
      ].entries()) {
        const events: unknown[] = []
        const result = await runtime.invokeTool(
          `run-normal-${index}`, `message-${index}`,
          { id: `call-${index}`, name: 'run_command', input: { command, cwd: 'G:\\网站克隆1.0', timeoutMs: 40000 } },
          'conversation-normal', 'G:\\网站克隆1.0', (event: unknown) => events.push(event), new AbortController()
        )
        expect(result.isError).toBe(false)
        expect(events).toEqual([])
      }
      expect(bridge.executeTool).toHaveBeenCalledTimes(4)
    } finally {
      delete process.env.CCORE_TOOL_DELEGATION
      if (originalVitest === undefined) delete process.env.VITEST
      else process.env.VITEST = originalVitest
    }
  })
})
