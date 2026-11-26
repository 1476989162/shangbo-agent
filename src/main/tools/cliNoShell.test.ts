import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest'
import { mkdtemp, mkdir, rm, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'

/* Ticket 3：CLI 无 shell 启动器回归。
   直接 import tools/index.ts 的真实 parseCmdShim / resolveCliNoShell 做端到端验证：
   恶意 prompt 含 & echo PWNED、%APPDATA%、\r\n 换行时，
   经 resolveCliNoShell → execFile(node, [entryJs, ..., prompt], { shell: false }) 传递，
   入口脚本收到的 argv 原样保留这些字符——绝无 cmd.exe 二次解析（PWNED 不执行、
   %APPDATA% 不展开、换行只是换行）。 */

vi.mock('electron', () => ({
  app: { getPath: () => 'C:\\UserData\\shangbo-agent' }
}))

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { parseCmdShim, resolveCliNoShell } from './index'

const execFileAsync = promisify(execFile)

describe('CLI 无 shell 启动器 (Ticket 3 命令注入回归)', () => {
  let fakeNpmDir = ''
  let entryJs = ''
  let entryCjs = ''
  let entryExe = ''
  let resultFile = ''
  let resultCjsFile = ''

  beforeAll(async () => {
    fakeNpmDir = await mkdtemp(join(tmpdir(), 'cli-noshell-'))
    // npm shim 模板内容（与 %APPDATA%\npm\*.cmd 同构）
    await mkdir(join(fakeNpmDir, 'node_modules', '@fake', 'cli', 'bin'), { recursive: true })
    await mkdir(join(fakeNpmDir, 'node_modules', '@fake', 'cjs', 'bin'), { recursive: true })
    await mkdir(join(fakeNpmDir, 'node_modules', '@fake', 'exe', 'bin'), { recursive: true })
    entryJs = join(fakeNpmDir, 'node_modules', '@fake', 'cli', 'bin', 'cli.js')
    entryCjs = join(fakeNpmDir, 'node_modules', '@fake', 'cjs', 'bin', 'run.cjs')
    entryExe = join(fakeNpmDir, 'node_modules', '@fake', 'exe', 'bin', 'tool.exe')
    resultFile = join(fakeNpmDir, 'argv-dump.json')
    resultCjsFile = join(fakeNpmDir, 'argv-dump-cjs.json')
    // 假 CLI 入口：把 argv 原样 JSON 落盘，证明「参数只是数据」
    const dumpScript = (out: string): string =>
      ["const fs = require('node:fs')", 'const out = process.argv.slice(2)', `fs.writeFileSync(${JSON.stringify(out)}, JSON.stringify(out))`].join('\n')
    await writeFile(entryJs, dumpScript(resultFile), 'utf8')
    await writeFile(entryCjs, dumpScript(resultCjsFile), 'utf8')
    // .exe shim 指向的真实 .exe：只验证解析存在性，不执行
    await writeFile(entryExe, 'MZ-fake', 'utf8')
    const shimOf = (target: string): string =>
      [
        '@ECHO off',
        'GOTO start',
        ':find_dp0',
        'SET dp0=%~dp0',
        'EXIT /b',
        ':start',
        'SETLOCAL',
        'CALL :find_dp0',
        'IF EXIST "%dp0%\\node.exe" (',
        '  SET "_prog=%dp0%\\node.exe"',
        ') ELSE (',
        '  SET "_prog=node"',
        ')',
        `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & set PATHEXT=%PATHEXT:;.JS;=;% & "%_prog%"  "%dp0%\\${target}" %*`
      ].join('\r\n')
    await writeFile(join(fakeNpmDir, 'fakecli.cmd'), shimOf('node_modules\\@fake\\cli\\bin\\cli.js'), 'utf8')
    await writeFile(join(fakeNpmDir, 'fakecjs.cmd'), shimOf('node_modules\\@fake\\cjs\\bin\\run.cjs'), 'utf8')
    await writeFile(join(fakeNpmDir, 'fakeexe.cmd'), shimOf('node_modules\\@fake\\exe\\bin\\tool.exe'), 'utf8')
  })

  afterAll(async () => {
    await rm(fakeNpmDir, { recursive: true, force: true })
  })

  it('shim 解析出 node 入口（无 shell 直调）', () => {
    const parsed = parseCmdShim(join(fakeNpmDir, 'fakecli.cmd'), fakeNpmDir)
    expect(parsed).not.toBeNull()
    // 跨平台：Windows 是 node.exe，Linux 是 node
    expect(parsed!.file).toMatch(/node(\.exe)?$/i)
    expect(parsed!.entryArg).toBe(entryJs)
  })

  it('.exe shim 直接返回真实 .exe（entryArg 为 null）', () => {
    const parsed = parseCmdShim(join(fakeNpmDir, 'fakeexe.cmd'), fakeNpmDir)
    expect(parsed).not.toBeNull()
    expect(parsed!.file).toBe(entryExe)
    expect(parsed!.entryArg).toBeNull()
  })

  it('.cjs dispatcher 走 node 载体（如 qoder 真实形态）', () => {
    const parsed = parseCmdShim(join(fakeNpmDir, 'fakecjs.cmd'), fakeNpmDir)
    expect(parsed).not.toBeNull()
    expect(parsed!.file).toMatch(/node(\.exe)?$/i)
    expect(parsed!.entryArg).toBe(entryCjs)
  })

  it('未知 shim 名回退裸名（仍无 shell，找不到如实 ENOENT）', () => {
    const resolved = resolveCliNoShell('definitely-not-a-cli-xyz' as never)
    expect(resolved).toEqual({ file: 'definitely-not-a-cli-xyz', entryArg: null })
  })

  it.each([
    ['& echo PWNED', 'cmd 元字符 & 必须原样保留'],
    ['%APPDATA%', '环境变量引用必须原样保留'],
    ['line1\r\nline2 & echo PWNED', 'CRLF 与元字符混合必须原样保留'],
    ['hello "world" | whoami', '引号与管道符必须原样保留'],
    ['`; rm -rf / #', '分号与注释符必须原样保留']
  ])('恶意 prompt %j 不被 shell 解析执行', async (evil, _why) => {
    const parsed = parseCmdShim(join(fakeNpmDir, 'fakecli.cmd'), fakeNpmDir)
    expect(parsed).not.toBeNull()
    // 与 execCliFileAsync 完全同构：execFile(node, [entryJs, ..., prompt], { shell: false })
    await execFileAsync(parsed!.file, [parsed!.entryArg as string, '-p', evil], {
      shell: false,
      windowsHide: true,
      timeout: 15_000
    })
    const argv = JSON.parse(await readFile(resultFile, 'utf8')) as string[]
    // 最后一个 argv 元素与恶意 prompt 逐字节一致：没有 shell 把它拆开执行
    expect(argv[argv.length - 1]).toBe(evil)
    // PWNED 从未作为独立命令执行：没有额外 argv 元素出现
    expect(argv.some((a) => a === 'PWNED' || a === 'echo')).toBe(false)
  })

  it.runIf(process.platform === 'win32')('对照实验：旧 shell 路径 argv 不保真，无 shell 路径保真', async () => {
    // 实测旧路径（spawnSync + shell:'cmd.exe'）：cmd 的引号塌缩会把 prompt 重新分组，
    // node 收到的 argv 已经不是原始字符串。无 shell 路径则逐字节保真。
    // 仅 Windows 有 cmd.exe，Linux 下跳过。
    const evil = 'say "hi" & echo PWNED'
    const cmdline = `node "${entryJs}" -p "${evil}"`
    spawnSync(cmdline, { shell: 'cmd.exe', windowsHide: true, timeout: 15_000 })
    const argvShell = JSON.parse(await readFile(resultFile, 'utf8')) as string[]
    // cmd 路径：引号被吃掉、内容重分组，不再是原始 prompt
    expect(argvShell[argvShell.length - 1]).not.toBe(evil)

    // 无 shell 路径：逐字节一致
    await execFileAsync(process.execPath, [entryJs, '-p', evil], { shell: false, timeout: 15_000 })
    const argvNoShell = JSON.parse(await readFile(resultFile, 'utf8')) as string[]
    expect(argvNoShell[argvNoShell.length - 1]).toBe(evil)
  })
})
