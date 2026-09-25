import { describe, expect, it } from 'vitest'
import { auditCommandSecurity, toolRegistry } from './index'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('Freebuff 安全护栏审计 (auditCommandSecurity)', () => {
  it('应准确拦截高危全盘删除指令', () => {
    const res1 = auditCommandSecurity('rm -rf /')
    expect(res1.isDangerous).toBe(true)
    expect(res1.severity).toBe('CRITICAL')

    const res2 = auditCommandSecurity('rmdir /s /q c:\\')
    expect(res2.isDangerous).toBe(true)
    expect(res2.severity).toBe('CRITICAL')
  })

  it('应准确拦截磁盘格式化与删库命令', () => {
    const res1 = auditCommandSecurity('format c:')
    expect(res1.isDangerous).toBe(true)

    const res2 = auditCommandSecurity('DROP DATABASE production_db;')
    expect(res2.isDangerous).toBe(true)
    expect(res2.severity).toBe('HIGH')
  })

  it('对普通命令应正常放行', () => {
    const res1 = auditCommandSecurity('git status')
    expect(res1.isDangerous).toBe(false)

    const res2 = auditCommandSecurity('npm test')
    expect(res2.isDangerous).toBe(false)
  })
})

describe('Cursor / Cline 级代码补丁工具 (patch_file)', () => {
  it('应注册 patch_file 工具', () => {
    const tool = toolRegistry.get('patch_file')
    expect(tool).toBeDefined()
    expect(tool?.name).toBe('patch_file')
  })

  it('能够进行局部精确替换', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'shangbo-patch-test-'))
    const testFile = join(dir, 'example.txt')
    try {
      await writeFile(testFile, 'line 1\nline 2: old content\nline 3', 'utf8')
      const tool = toolRegistry.get('patch_file')!
      const res = await tool.execute(
        {
          path: testFile,
          targetContent: 'line 2: old content',
          replacementContent: 'line 2: newly patched'
        },
        {
          conversationId: 'test',
          workingDirectory: dir,
          signal: new AbortController().signal
        }
      )

      expect(res).toContain('局部精确补丁更新')
      const updated = await readFile(testFile, 'utf8')
      expect(updated).toBe('line 1\nline 2: newly patched\nline 3')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
