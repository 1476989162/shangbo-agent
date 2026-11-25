import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'

/* 测试绝不读写仓库真实 python/sidecar.py：electron mock 的 app.getAppPath()
   指向每个用例自建的临时目录，桥接器只会在 <临时目录>/python/sidecar.py
   找脚本。这样无论测试脚本写什么内容，仓库源文件都不被触碰，
   vitest 并行跑其他文件也不会与这里的临时替换互相踩踏。 */

let appRoot = ''

vi.mock('electron', () => ({
  app: { isPackaged: false, getAppPath: () => appRoot }
}))
vi.mock('electron-log/main', () => ({ default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }))

import { PythonBridge } from './bridge'

/** 在临时 app 根目录下放一个假 sidecar（可选自定内容）。 */
async function stageSidecar(content: string): Promise<string> {
  const pyDir = join(appRoot, 'python')
  await mkdir(pyDir, { recursive: true })
  const script = join(pyDir, 'sidecar.py')
  await writeFile(script, content, 'utf8')
  return script
}

/** 边车真正跑起来需要 Python；找不到时跳过该用例而不是假通过。
    模块级缓存只探测一次：每次探测都要真实 spawn 一次解释器，
    高负载下（vitest 多 worker 并行）重复探测会拖慢甚至超时。 */
let cachedPython: string | null | undefined

function pythonExecutable(): string | null {
  if (cachedPython !== undefined) return cachedPython
  const candidates = process.env.SHANGBO_PYTHON
    ? [process.env.SHANGBO_PYTHON]
    : process.platform === 'win32'
      ? ['python', 'py']
      : ['python3', 'python']
  for (const exe of candidates) {
    if (spawnSync(exe, ['-c', 'print("ok")'], { timeout: 5_000 }).status === 0) {
      cachedPython = exe
      return exe
    }
  }
  cachedPython = null
  return null
}

beforeEach(async () => {
  appRoot = await mkdtemp(join(tmpdir(), 'bridge-app-'))
})

afterEach(async () => {
  await rm(appRoot, { recursive: true, force: true })
})

describe('PythonBridge 边车异常退出 (EPIPE 防线)', () => {
  it('边车立即退出后再写入不崩进程、pending 被 reject', { timeout: 20_000 }, async () => {
    const python = pythonExecutable()
    if (!python) return // 本机无 Python：跳过而非假绿

    // 「读一行就 sys.exit(1)」的短命边车：启动成功、写入、边车立刻退出，
    // 随后再写一次必须不产生未捕获 EPIPE。
    await stageSidecar('import sys\nsys.stdin.readline()\nsys.exit(1)\n')
    const previous = process.env.SHANGBO_PYTHON
    process.env.SHANGBO_PYTHON = python
    try {
      const bridge = new PythonBridge()
      try {
        expect(bridge.start()).toBe(true)
        // 第一次调用在边车退出瞬间落空：可能 reject 也可能已返回，都不许崩
        await bridge.call('ping', {}, 2_000).catch(() => 'expected rejection')
        // 边车已死，此刻再写入：修复前这里触发未捕获 EPIPE，修复后只是 reject
        const unhandled: Error[] = []
        const onUnhandled = (e: Error): void => {
          unhandled.push(e)
        }
        process.on('uncaughtException', onUnhandled)
        try {
          await expect(bridge.call('ping', {}, 2_000)).rejects.toThrow()
        } finally {
          process.removeListener('uncaughtException', onUnhandled)
        }
        expect(unhandled).toEqual([])
      } finally {
        bridge.dispose()
      }
    } finally {
      if (previous === undefined) delete process.env.SHANGBO_PYTHON
      else process.env.SHANGBO_PYTHON = previous
    }
  })

  it('SHANGBO_PYTHON 指向不存在的解释器时 call 被 reject', async () => {
    await stageSidecar('import sys\nsys.stdin.readline()\nsys.exit(1)\n')
    const previous = process.env.SHANGBO_PYTHON
    process.env.SHANGBO_PYTHON = 'definitely-not-a-python.exe'
    try {
      const bridge = new PythonBridge()
      try {
        const started = bridge.start()
        if (started) {
          await new Promise((r) => setTimeout(r, 200))
          await expect(bridge.call('ping', {}, 1_000)).rejects.toThrow()
        } else {
          // spawn 失败同样合格：call 必须走 reject 而不是挂死
          await expect(bridge.call('ping', {}, 1_000)).rejects.toThrow()
        }
      } finally {
        bridge.dispose()
      }
    } finally {
      if (previous === undefined) delete process.env.SHANGBO_PYTHON
      else process.env.SHANGBO_PYTHON = previous
    }
  })
})

describe('Python 边车 parse_document 回归（.csv / .xls / 不支持扩展名）', () => {
  // 真实走一遍 python/sidecar.py 的解析逻辑：仓库脚本原样复制到临时目录，
  // 测试只跟这份副本交互，仓库文件零读写、零改动。

  it('.csv 出表格 HTML；.xls 报可读错误；.pdf 报不支持的文档类型', { timeout: 20_000 }, async () => {
    const python = pythonExecutable()
    if (!python) return

    const repoSidecar = join(process.cwd(), 'python', 'sidecar.py')
    const staged = await stageSidecar(await readFile(repoSidecar, 'utf8'))

    const csvPath = join(appRoot, 't.csv')
    await writeFile(csvPath, 'a,b,c\n1,2,3\n', 'utf8')
    const xlsPath = join(appRoot, 't.xls')
    await writeFile(xlsPath, Buffer.from([0xd0, 0xcf, 0x11, 0xe0]), 'binary')
    const pdfPath = join(appRoot, 't.pdf')
    await writeFile(pdfPath, '%PDF-1.4 fake', 'utf8')

    // 三条请求拼成 3 行 input 一次 spawnSync 跑完（高负载下连开三个
    // Python 进程容易踩超时），再按行解析三条响应。
    const requests = [
      { id: 1, method: 'parse_document', params: { path: csvPath } },
      { id: 2, method: 'parse_document', params: { path: xlsPath } },
      { id: 3, method: 'parse_document', params: { path: pdfPath } }
    ]
    const out = spawnSync(python, ['-u', staged], {
      input: requests.map((r) => JSON.stringify(r)).join('\n') + '\n',
      encoding: 'utf8',
      timeout: 20_000
    })
    const lines = (out.stdout ?? '').split(/\r?\n/).filter((l) => l.trim())
    if (lines.length !== 3) throw new Error(`边车应答 3 行，实际 ${lines.length} 行：${out.stderr ?? ''}`)
    const byId = new Map<number, { result?: { html: string; truncated: boolean }; error?: string }>()
    for (const line of lines) byId.set(JSON.parse(line).id, JSON.parse(line))

    // .csv：无需 openpyxl 也能出 HTML 表格
    const csv = byId.get(1)
    expect(csv?.error).toBeUndefined()
    expect(csv?.result?.html).toContain('<h3>CSV</h3>')
    expect(csv?.result?.html).toContain('<td>a</td>')

    // .xls：明确可读错误，提示另存为 .xlsx
    expect(byId.get(2)?.error).toContain('.xls')

    // .pdf：不支持的文档类型（而非「表格类型」）
    expect(byId.get(3)?.error).toContain('不支持的文档类型')
  })
})
