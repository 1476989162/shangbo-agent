import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/shangbo-test' }
}))
vi.mock('../settings', () => ({
  getSetting: (_key: string, fallback: unknown) => fallback
}))

const bridge = vi.hoisted(() => ({
  available: false,
  classifyToolCall: vi.fn(),
  scanInjectionRules: vi.fn()
}))
vi.mock('./cCoreBridge', () => ({
  cCoreBridge: {
    isAvailable: () => bridge.available,
    classifyToolCall: bridge.classifyToolCall,
    scanInjectionRules: bridge.scanInjectionRules
  }
}))
vi.mock('./injectionDetector', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./injectionDetector')>()
  return {
    ...actual,
    scanInjectionRules: () => { throw new Error('forced_scan_failure') }
  }
})

describe('运行时 C 主通道与扫描故障', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    bridge.available = false
    bridge.classifyToolCall.mockRejectedValue(new Error('c_unavailable'))
    bridge.scanInjectionRules.mockRejectedValue(new Error('c_unavailable'))
  })

  function mockTool(): void {
    void (async () => {
      const { toolRegistry } = await import('../tools')
      vi.spyOn(toolRegistry, 'get').mockReturnValue({
        name: 'read_file',
        description: '测试只读工具',
        parameters: { type: 'object', properties: {}, required: [] },
        requiresApproval: false,
        execute: async () => 'untrusted tool output'
      } as ReturnType<typeof toolRegistry.get>)
    })()
  }

  it('工具回包扫描异常时明确告警，不静默按无风险处理', async () => {
    mockTool()
    const { AgentRuntime } = await import('./runtime')
    const runtime = new AgentRuntime() as unknown as {
      invokeTool: (...args: unknown[]) => Promise<{ content: string; isError: boolean }>
    }
    const result = await runtime.invokeTool(
      'run-1', 'message-1', { id: 'call-1', name: 'read_file', input: {} },
      'conversation-1', process.cwd(), () => {}, new AbortController()
    )
    expect(result.isError).toBe(false)
    expect(result.content).toContain('外部内容扫描未完成')
    expect(result.content).toContain('forced_scan_failure')
    expect(result.content).toContain('untrusted tool output')
  })

})
