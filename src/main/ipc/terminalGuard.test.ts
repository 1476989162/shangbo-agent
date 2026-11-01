import { describe, expect, it } from 'vitest'
import { checkTerminalCommand } from './terminalGuard'

/**
 * 工作台终端护栏回归测试。
 *
 * 背景：`app:execCommand` 是渲染进程直连的通道，渲染进程里同时渲染模型输出。
 * 如果不复用工具层的护栏，这里就成了「绕过审批读密钥」的后门。
 */
describe('工作台终端护栏', () => {
  it('拒绝读取密钥文件（这是绕过审批的后门）', () => {
    expect(checkTerminalCommand('type %APPDATA%\\shangbo-agent\\secrets.json').blocked).toBe(true)
    expect(checkTerminalCommand('cat ~/AppData/Roaming/shangbo-agent/secrets.json').blocked).toBe(true)
  })

  it('拒绝触碰会话数据库及其伴生文件', () => {
    expect(checkTerminalCommand('copy shangbo-agent.db C:\\temp\\x.db').blocked).toBe(true)
    expect(checkTerminalCommand('sqlite3 shangbo-agent.db-wal .dump').blocked).toBe(true)
  })

  it('拒绝 CRITICAL 级擦盘命令', () => {
    expect(checkTerminalCommand('rm -rf /').blocked).toBe(true)
    expect(checkTerminalCommand('rd /s /q C:\\').blocked).toBe(true)
  })

  it('放行日常命令：终端由用户自己敲，不因删子目录被拦死', () => {
    expect(checkTerminalCommand('npm test').blocked).toBe(false)
    expect(checkTerminalCommand('git status').blocked).toBe(false)
    expect(checkTerminalCommand('rm -rf ./dist').blocked).toBe(false)
    expect(checkTerminalCommand('del /q *.tmp').blocked).toBe(false)
  })

  it('拦截时给出可读原因，不静默失败', () => {
    const result = checkTerminalCommand('type secrets.json')
    expect(result.blocked).toBe(true)
    expect(result.reason).toBeTruthy()
    expect(result.reason).toContain('私有数据')
  })
})
