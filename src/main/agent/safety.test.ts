import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { auditHardLines, classifyToolCall, isAutoAllowed } from './safety'

const tempDirs: string[] = []

function workspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'shangbo-safety-'))
  tempDirs.push(dir)
  writeFileSync(join(dir, 'a.ts'), 'export const a = 1\n')
  return dir
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('硬红线：磁盘格式化永久拒绝', () => {
  it('格式化/分区/擦盘命令一律 blocked', () => {
    for (const command of [
      'format D:',
      'diskpart',
      'mkfs.ext4 /dev/sda1',
      'rm -rf /',
      'rm -rf C:\\',
      'del /f /s /q C:\\*',
      'Remove-Item -Recurse -Force C:\\'
    ]) {
      const verdict = auditHardLines(command)
      expect(verdict?.tier, command).toBe('blocked')
      expect(verdict?.category, command).toBe('disk')
    }
  })

  it('普通子目录清理不误判', () => {
    expect(auditHardLines('rm -rf ./dist')).toBeNull()
    expect(auditHardLines('rm -rf node_modules')).toBeNull()
    expect(auditHardLines('del /q *.tmp')).toBeNull()
  })
})

describe('硬红线：git 仓库与数据库必须人工确认', () => {
  it('删除 .git 目录为 hard', () => {
    for (const command of [
      'rm -rf .git',
      'rm -rf C:\\repo\\.git',
      'Remove-Item -Recurse -Force .git',
      'move .git D:\\backup'
    ]) {
      const verdict = auditHardLines(command)
      expect(verdict?.tier, command).toBe('hard')
      expect(verdict?.category, command).toBe('git')
    }
  })

  it('重写 git 历史为 hard', () => {
    for (const command of ['git push --force', 'git reset --hard HEAD~1', 'git clean -fdx', 'git branch -D main']) {
      expect(auditHardLines(command)?.tier, command).toBe('hard')
    }
  })

  it('删库/清表/无 WHERE 删除/删库文件为 hard', () => {
    for (const command of [
      'mysql -e "drop database prod"',
      'DROP TABLE users',
      'TRUNCATE TABLE orders',
      'DELETE FROM users',
      'rm data/app.db',
      'redis-cli flushall'
    ]) {
      const verdict = auditHardLines(command)
      expect(verdict?.tier, command).toBe('hard')
      expect(verdict?.category, command).toBe('database')
    }
  })

  it('带 WHERE 的 DELETE 不算硬红线', () => {
    expect(auditHardLines('DELETE FROM users WHERE id = 1')).toBeNull()
  })

  it('提交信息、搜索词里的危险字样不误触发', () => {
    expect(auditHardLines('git commit -m "fix: drop database docs"')).toBeNull()
    expect(auditHardLines('grep "rm -rf .git" notes.md')).toBeNull()
    expect(auditHardLines('echo "format c: is dangerous" > note.txt')).toBeNull()
  })

  it('解释器里执行的删除仍按硬红线处理', () => {
    expect(auditHardLines('powershell -Command "Remove-Item -Recurse -Force .git"')?.tier).toBe('hard')
  })
})

describe('工作区自治与自动放行', () => {
  it('工作区内写入在智能自治下自动放行', () => {
    const dir = workspace()
    const verdict = classifyToolCall('write_file', { path: 'src/b.ts' }, {
      workingDirectory: dir,
      autonomy: 'balanced'
    })
    expect(verdict.tier).toBe('auto')
    expect(isAutoAllowed(verdict, 'balanced')).toBe(true)
  })

  it('严格模式下工作区写入仍需确认', () => {
    const dir = workspace()
    const verdict = classifyToolCall('patch_file', { path: 'a.ts' }, {
      workingDirectory: dir,
      autonomy: 'strict'
    })
    expect(verdict.tier).toBe('soft')
    expect(isAutoAllowed(verdict, 'strict')).toBe(false)
  })

  it('工作区外写入默认仍需确认', () => {
    const dir = workspace()
    const outside = workspace()
    const verdict = classifyToolCall('write_file', { path: join(outside, 'x.txt') }, {
      workingDirectory: dir,
      autonomy: 'balanced'
    })
    expect(verdict.tier).toBe('soft')
    expect(isAutoAllowed(verdict, 'balanced')).toBe(false)
  })

  it('工作区内安全命令自动放行，未绑定工作区则需确认', () => {
    const dir = workspace()
    expect(
      classifyToolCall('run_command', { command: 'npm test' }, {
        workingDirectory: dir,
        autonomy: 'balanced'
      }).tier
    ).toBe('auto')
    expect(
      classifyToolCall('run_command', { command: 'npm test' }, {
        workingDirectory: null,
        autonomy: 'balanced'
      }).tier
    ).toBe('soft')
  })

  it('硬红线即使完全信任也不自动放行', () => {
    const dir = workspace()
    const verdict = classifyToolCall('run_command', { command: 'rm -rf .git' }, {
      workingDirectory: dir,
      autonomy: 'trusted'
    })
    expect(verdict.tier).toBe('hard')
    expect(isAutoAllowed(verdict, 'trusted')).toBe(false)
  })

  it('递归删除工作区外绝对路径必须确认，完全信任也不放行', () => {
    const dir = workspace()
    for (const command of [
      'rm -rf C:\\Users',
      'rd /s /q D:\\Data',
      'Remove-Item -Recurse -Force C:\\Windows\\Temp'
    ]) {
      const verdict = classifyToolCall('run_command', { command }, {
        workingDirectory: dir,
        autonomy: 'trusted'
      })
      expect(verdict.tier, command).toBe('hard')
      expect(isAutoAllowed(verdict, 'trusted'), command).toBe(false)
    }
  })

  it('触碰私有数据直接 blocked', () => {
    const verdict = classifyToolCall('run_command', { command: 'type secrets.json' }, {
      workingDirectory: workspace(),
      autonomy: 'trusted'
    })
    expect(verdict.tier).toBe('blocked')
    expect(verdict.category).toBe('private-data')
  })

  it('键鼠控制永不自动放行', () => {
    const verdict = classifyToolCall('computer_click', { x: 10, y: 20 }, {
      workingDirectory: null,
      autonomy: 'trusted'
    })
    expect(verdict.tier).toBe('soft')
    expect(isAutoAllowed(verdict, 'trusted')).toBe(false)
  })
})
