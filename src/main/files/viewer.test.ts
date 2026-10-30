import { describe, expect, it, vi, beforeEach } from 'vitest'
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

vi.mock('electron', () => ({ app: { getPath: () => 'C:\\UserData\\shangbo-agent' }, shell: { openPath: vi.fn() } }))
vi.mock('electron-log/main', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

const convoDirs = new Map<string, string>()

vi.mock('../db/repo', () => ({
  getConversation: (id: string) => {
    const dir = convoDirs.get(id)
    return dir ? { workingDir: dir } : null
  }
}))

vi.mock('../py/bridge', () => ({
  pythonBridge: { call: vi.fn(async () => ({ html: '<p>doc</p>', truncated: false })) }
}))

import { resolveViewerPath, readViewerFile, listViewerDir } from './viewer'

let root = ''

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'viewer-test-'))
  convoDirs.set('conv-1', root)
})

describe('右侧查看器文件通道', () => {
  it('无绑定会话直接拒绝', async () => {
    await expect(readViewerFile('no-such-convo', 'a.txt')).rejects.toThrow('未绑定')
  })

  it('../ 越界被拦', () => {
    expect(() => resolveViewerPath('conv-1', '../outside.txt')).toThrow('越界')
  })

  it('读文本文件正常', async () => {
    await writeFile(join(root, 'hello.txt'), 'hi there', 'utf8')
    const file = await readViewerFile('conv-1', 'hello.txt')
    expect(file.text).toContain('hi there')
    expect(file.mime).toBe('text/plain')
  })

  it('列目录正常', async () => {
    await mkdir(join(root, 'sub'), { recursive: true })
    await writeFile(join(root, 'a.txt'), 'x', 'utf8')
    const result = await listViewerDir('conv-1', '.')
    expect(result.entries.map((e) => e.name)).toContain('a.txt')
    expect(result.entries.find((e) => e.name === 'sub')?.isDirectory).toBe(true)
  })

  it('二进制文件拒绝文本预览', async () => {
    await writeFile(join(root, 'bin.dat'), Buffer.from([0x00, 0x01, 0x02]))
    await expect(readViewerFile('conv-1', 'bin.dat')).rejects.toThrow()
  })

  it('用完清理', async () => {
    await rm(root, { recursive: true, force: true })
  })
})
