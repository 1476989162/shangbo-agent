import { describe, expect, it } from 'vitest'
import { parseSettingValue, SettingSchemas } from './settingsSchema'

/* A-4 settings:set 白名单：渲染层按威胁模型不可信，
   未知键、类型不符的值、伪造的自动批准名单都必须被拒。 */

describe('设置写入白名单 (parseSettingValue)', () => {
  it('白名单外的键直接抛错', () => {
    expect(() => parseSettingValue('agent.evilFlag', true)).toThrow('不在设置白名单')
    expect(() => parseSettingValue('renderer.arbitrary', { x: 1 })).toThrow()
  })

  it('布尔键写字符串抛错，写布尔通过', () => {
    expect(() => parseSettingValue('agent.readOnly', 'yes')).toThrow()
    expect(parseSettingValue('agent.readOnly', false)).toBe(false)
    expect(parseSettingValue('agent.computerUse', true)).toBe(true)
    expect(parseSettingValue('provider.anthropic.promptCache', false)).toBe(false)
    expect(() => parseSettingValue('provider.anthropic.promptCache', 'off')).toThrow()
  })

  it('数字键超出业务范围抛错', () => {
    expect(() => parseSettingValue('agent.maxSteps', 999)).toThrow('1–500')
    expect(() => parseSettingValue('agent.maxSteps', '50')).toThrow()
    expect(parseSettingValue('agent.maxSteps', 50)).toBe(50)
    expect(() => parseSettingValue('agent.contextBudgetTokens', 100)).toThrow()
    expect(parseSettingValue('agent.contextBudgetTokens', 32_000)).toBe(32_000)
  })

  it('自动批准名单的成员必须是已知工具名（MCP 工具按前缀放行）', () => {
    const known = ['run_command', 'write_file']
    expect(parseSettingValue('tools.autoApprove', ['run_command'], { knownToolNames: known })).toEqual([
      'run_command'
    ])
    expect(() => parseSettingValue('tools.autoApprove', ['format_c_disk'], { knownToolNames: known })).toThrow(
      '未知工具'
    )
    expect(
      parseSettingValue('tools.autoApprove', ['mcp__github__create_issue'], { knownToolNames: known })
    ).toEqual(['mcp__github__create_issue'])
  })

  it('结构化数组键的元素必须是对象', () => {
    expect(() => parseSettingValue('cowork.memories', ['不是对象'])).toThrow()
    expect(() => parseSettingValue('agent.mcp.servers', 'not-array')).toThrow()
  })

  it('Ticket 7A 下线的死设置不再可写（code.defaultShell 例外仍可写）', () => {
    for (const key of [
      'code.fontFamily',
      'code.fontSize',
      'code.lineNumbers',
      'code.wordWrap',
      'code.commitTemplate',
      'agent.wish.dailyRunLimit',
      'agent.reduceMotion',
      'agent.chatFont',
      'agent.workRole',
      'agent.browser.builtin',
      'agent.browser.external',
      'agent.browser.autoScreenshot',
      'agent.browser.default',
      'cowork.trustedFolders'
    ]) {
      expect(SettingSchemas[key], key).toBeUndefined()
      expect(() => parseSettingValue(key, 'x'), key).toThrow('不在设置白名单')
    }
    expect(parseSettingValue('code.defaultShell', 'powershell.exe')).toBe('powershell.exe')
  })

  it('渲染层实际使用的键都在白名单内', () => {
    // 一旦渲染层新增设置键而忘了登记白名单，这个用例会提醒补表
    // Ticket 7A 已下线 14 个死设置：这里只保留仍被业务消费的键
    for (const key of [
      'app.theme',
      'chat.hiddenModels',
      'chat.model',
      'chat.providerId',
      'cowork.filesPath',
      'cowork.globalInstructions',
      'cowork.memories',
      'cowork.useMemory',
      'agent.notifyCompletion',
      // 手机远程：中转准入密钥必须可写，否则设置页保存会抛错
      'remote.enabled',
      'remote.relayUrl',
      'remote.accessKey',
      'remote.approvalPolicy'
    ]) {
      expect(SettingSchemas[key], key).toBeDefined()
    }
  })

  it('许愿模式 MCP 键：布尔与字符串数组可写，类型不符被拒', () => {
    expect(parseSettingValue('agent.wish.allowMcp', true)).toBe(true)
    expect(() => parseSettingValue('agent.wish.allowMcp', 'yes')).toThrow()
    expect(parseSettingValue('agent.wish.mcpAutoApproveServers', ['playwright'])).toEqual([
      'playwright'
    ])
    expect(parseSettingValue('agent.wish.mcpAutoApproveServers', [])).toEqual([])
    expect(() => parseSettingValue('agent.wish.mcpAutoApproveServers', 'playwright')).toThrow()
    expect(() =>
      parseSettingValue('agent.wish.mcpAutoApproveServers', ['x'.repeat(101)])
    ).toThrow()
  })

  it('中转准入密钥：字符串可写、长度受限、非字符串被拒', () => {
    expect(parseSettingValue('remote.accessKey', 'abc123')).toBe('abc123')
    expect(parseSettingValue('remote.accessKey', '')).toBe('')
    expect(() => parseSettingValue('remote.accessKey', 123)).toThrow()
    expect(() => parseSettingValue('remote.accessKey', 'x'.repeat(201))).toThrow()
  })

  it('agent.toolConcurrency：1–16 整数可写，越界与非整数被拒', () => {
    expect(parseSettingValue('agent.toolConcurrency', 8)).toBe(8)
    expect(parseSettingValue('agent.toolConcurrency', 1)).toBe(1)
    expect(parseSettingValue('agent.toolConcurrency', 16)).toBe(16)
    expect(() => parseSettingValue('agent.toolConcurrency', 0)).toThrow('1–16')
    expect(() => parseSettingValue('agent.toolConcurrency', 17)).toThrow('1–16')
    expect(() => parseSettingValue('agent.toolConcurrency', 4.5)).toThrow()
    expect(() => parseSettingValue('agent.toolConcurrency', '8')).toThrow()
  })

  it('布尔开关三键：布尔可写，字符串/数字被拒', () => {
    for (const key of ['agent.proactive.enabled', 'agent.proactive.strictSkip', 'agent.tasks.wakeMetaOnDone']) {
      expect(parseSettingValue(key, true), key).toBe(true)
      expect(parseSettingValue(key, false), key).toBe(false)
      expect(() => parseSettingValue(key, 'true'), key).toThrow()
      expect(() => parseSettingValue(key, 1), key).toThrow()
    }
  })

  it('providers.reasoningPatterns：字符串数组可写，超长/超量/非数组被拒', () => {
    expect(parseSettingValue('providers.reasoningPatterns', ['high', 'medium'])).toEqual([
      'high',
      'medium'
    ])
    expect(parseSettingValue('providers.reasoningPatterns', [])).toEqual([])
    expect(() => parseSettingValue('providers.reasoningPatterns', 'high')).toThrow()
    expect(() => parseSettingValue('providers.reasoningPatterns', [123])).toThrow()
    expect(() => parseSettingValue('providers.reasoningPatterns', ['x'.repeat(201)])).toThrow()
    expect(() =>
      parseSettingValue('providers.reasoningPatterns', Array.from({ length: 101 }, () => 'p'))
    ).toThrow()
  })
})
