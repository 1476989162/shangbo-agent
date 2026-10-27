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
    expect(parseSettingValue('cowork.trustedFolders', ['G:\\projects'])).toEqual(['G:\\projects'])
  })

  it('渲染层实际使用的键都在白名单内', () => {
    // 一旦渲染层新增设置键而忘了登记白名单，这个用例会提醒补表
    for (const key of [
      'agent.browser.builtin',
      'agent.browser.external',
      'agent.browser.default',
      'agent.browser.autoScreenshot',
      'agent.chatFont',
      'agent.workRole',
      'app.theme',
      'chat.hiddenModels',
      'chat.model',
      'chat.providerId',
      'cowork.filesPath',
      'cowork.globalInstructions',
      'cowork.memories',
      'cowork.trustedFolders',
      'cowork.useMemory',
      'agent.notifyCompletion',
      'agent.reduceMotion'
    ]) {
      expect(SettingSchemas[key], key).toBeDefined()
    }
  })
})
