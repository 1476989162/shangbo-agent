import { describe, expect, it } from 'vitest'
import { commandStaysInsideWorkspace } from './runtime'
import { resolveWishPrompt } from './wish'
import type { AutonomousTask, Lesson } from '../../shared/types'

function task(): AutonomousTask {
  return {
    id: 't1',
    name: '修好构建',
    prompt: '让项目构建重新通过',
    acceptance: 'npm run build 成功',
    workingDir: 'G:\\repo',
    schedule: 'manual',
    intervalMinutes: null,
    verifyCommand: 'npm run build',
    maxVerifyAttempts: 2,
    enabled: true,
    conversationId: null,
    nextRunAt: null,
    lastRunAt: null,
    lastStatus: null,
    lastError: null,
    failureCount: 0,
    maxSteps: 80,
    maxRunsPerDay: 12,
    createdAt: 0,
    updatedAt: 0
  }
}

function lesson(): Lesson {
  return {
    id: 'l1',
    scope: 'project',
    projectPath: 'G:\\repo',
    title: '测试入口',
    content: '先运行 npm run typecheck，再运行 npm test。',
    sourceTaskId: null,
    sourceRunId: null,
    confidence: 0.8,
    useCount: 0,
    lastUsedAt: null,
    createdAt: 0,
    updatedAt: 0
  }
}

describe('许愿模式边界', () => {
  it('允许工作区内的命令', () => {
    expect(commandStaysInsideWorkspace('npm test', 'G:\\repo')).toBe(true)
    expect(commandStaysInsideWorkspace('node scripts/build.mjs', 'G:\\repo')).toBe(true)
    expect(commandStaysInsideWorkspace('git status', 'G:\\repo')).toBe(true)
    expect(commandStaysInsideWorkspace('type G:\\repo\\src\\a.ts', 'G:\\repo')).toBe(true)
  })

  it('拒绝父目录穿越与环境变量路径逃逸', () => {
    expect(commandStaysInsideWorkspace('cd .. && npm test', 'G:\\repo')).toBe(false)
    expect(commandStaysInsideWorkspace('cd ../other && npm test', 'G:\\repo')).toBe(false)
    expect(commandStaysInsideWorkspace('type %USERPROFILE%\\.ssh\\id_rsa', 'G:\\repo')).toBe(false)
    expect(commandStaysInsideWorkspace('type $env:USERPROFILE\\secret.txt', 'G:\\repo')).toBe(false)
  })

  it('拒绝工作区外绝对路径', () => {
    expect(commandStaysInsideWorkspace('type C:\\Users\\Administrator\\secret.txt', 'G:\\repo')).toBe(
      false
    )
    expect(commandStaysInsideWorkspace('type D:\\other\\file.txt', 'G:\\repo')).toBe(false)
  })
})

describe('许愿提示词', () => {
  it('包含目标、验收、经验与完成协议', () => {
    const prompt = resolveWishPrompt({ task: task(), lessons: [lesson()] })
    expect(prompt).toContain('让项目构建重新通过')
    expect(prompt).toContain('npm run build')
    expect(prompt).toContain('测试入口')
    expect(prompt).toContain('改动摘要')
  })

  it('自动修复提示带上上一轮验收错误', () => {
    const prompt = resolveWishPrompt({
      task: task(),
      lessons: [],
      retry: { attempt: 1, output: 'TypeScript error TS1005' }
    })
    expect(prompt).toContain('自动修复第 1 次')
    expect(prompt).toContain('TS1005')
  })
})
