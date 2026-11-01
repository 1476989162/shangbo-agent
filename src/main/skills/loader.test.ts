import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('electron-log/main', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

const skillDirsMock = vi.hoisted(() => ({ dirs: [] as string[] }))

vi.mock('../settings', () => ({
  getSetting: (key: string, fallback: unknown) => {
    if (key === 'agent.skillDirs') return skillDirsMock.dirs
    return fallback
  }
}))

import { scanSkillPack, scanAllSkillPacks, readSkillEntry, buildSkillRouterPrompt } from './loader'

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'skill-test-'))
  skillDirsMock.dirs = [root]
})

describe('外部技能加载器', () => {
  it('扫描技能包：路由器+子技能全读出', async () => {
    await writeFile(join(root, 'SKILL.md'), '---\nname: Demo Pack\ndescription: demo router\n---\n# 路由', 'utf8')
    await mkdir(join(root, 'DataTable'), { recursive: true })
    await writeFile(join(root, 'DataTable', 'SKILL.md'), '---\nname: DataTable\ndescription: 数据表\n---\n# 内容', 'utf8')
    const pack = await scanSkillPack(root)
    expect(pack?.name).toBe('Demo Pack')
    expect(pack?.skills).toHaveLength(1)
    expect(pack?.skills[0].id).toBe('DataTable')
    await rm(root, { recursive: true, force: true })
  })

  it('无 SKILL.md 的目录返回 null', async () => {
    const pack = await scanSkillPack(root)
    expect(pack).toBeNull()
    await rm(root, { recursive: true, force: true })
  })

  it('读技能越界被拦', async () => {
    await expect(readSkillEntry('C:\\Windows\\secret.md', root)).rejects.toThrow('越界')
    await rm(root, { recursive: true, force: true })
  })

  it('空目录扫描返回空', async () => {
    skillDirsMock.dirs = ['C:\\definitely-not-exist-xyz']
    const packs = await scanAllSkillPacks()
    expect(packs).toHaveLength(0)
  })

  it('路由器提示词只放索引不放全文', () => {
    const prompt = buildSkillRouterPrompt([
      { root, name: 'P', router: '路由全文', skills: [{ id: 'A', name: 'A', description: 'd', entry: 'e', packRoot: root }] }
    ])
    expect(prompt).toContain('路由全文')
    expect(prompt).not.toContain('子技能全文')
  })
})
