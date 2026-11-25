#!/usr/bin/env node
/**
 * 跨平台 C-Core 构建入口（npm run build:c）。
 *
 * - Windows：vswhere.exe 动态定位 MSVC 安装路径 → vcvars64.bat → cl.exe
 *   编译 shangbo_agent.exe 与 test_runner.exe 并运行测试。
 *   优先复用 PATH 里已有的 cl（开发者命令行直接调用）；
 *   vswhere 兜底路径：C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe
 *   （含仅装 Build Tools 的机器；找不到就明确报错，绝不静默跳过编译）。
 * - Linux / macOS：make -C c-core all test（Makefile 已带 -D_GNU_SOURCE -pthread）。
 *
 * 任何一步失败都以非零码退出；C 代码有改动时本脚本必须真实编译并跑通测试。
 */

import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { arch, platform } from 'node:process'

const root = resolve(import.meta.dirname, '..')
const cCore = join(root, 'c-core')

function fail(message) {
  console.error(`[build-c] ${message}`)
  process.exit(1)
}

function run(cmd, args, opts = {}) {
  const result = spawnSync(cmd, args, {
    stdio: 'inherit',
    cwd: opts.cwd ?? root,
    shell: opts.shell ?? false,
    env: opts.env ?? process.env
  })
  if (result.error) fail(`无法启动 ${cmd}：${result.error.message}`)
  if (result.status !== 0) fail(`${cmd} ${args.join(' ')} 退出码 ${result.status}`)
  return result
}

/** 在 PATH 中找可执行文件（Windows 用 where，其他平台用 which）。 */
function which(tool) {
  const finder = platform === 'win32' ? 'where' : 'which'
  const found = spawnSync(finder, [tool], { encoding: 'utf8', shell: false })
  return found.status === 0 ? found.stdout.trim().split(/\r?\n/)[0] : null
}

/** vswhere 动态定位最新 MSVC 安装根目录；找不到返回 null。 */
function findVcvars64() {
  const candidates = [
    join(
      process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
      'Microsoft Visual Studio',
      'Installer',
      'vswhere.exe'
    ),
    join(
      process.env.ProgramFiles ?? 'C:\\Program Files',
      'Microsoft Visual Studio',
      'Installer',
      'vswhere.exe'
    )
  ]
  const vswhere = candidates.find((p) => existsSync(p))
  if (!vswhere) return null

  const found = spawnSync(
    vswhere,
    [
      '-latest',
      '-products',
      '*',
      '-requires',
      'Microsoft.VisualStudio.Component.VC.Tools.x86.x64',
      '-property',
      'installationPath'
    ],
    { encoding: 'utf8' }
  )
  const installPath = found.status === 0 ? found.stdout.trim() : ''
  if (!installPath) return null

  // Build Tools 与完整 IDE 的 vcvars 都在 <installPath>\VC\Auxiliary\Build 下
  const vcvars = join(installPath, 'VC', 'Auxiliary', 'Build', 'vcvars64.bat')
  return existsSync(vcvars) ? vcvars : null
}

function buildWindows() {
  const SRCS = [
    'src/safety.c',
    'src/command_guard.c',
    'src/injection_detector.c',
    'src/loop_guard.c',
    'src/stream_processor.c',
    'src/tools.c',
    'src/agent_runtime.c',
    'src/json_rpc.c',
    'src/native_process.c'
  ]
  const TESTS = [
    'tests/test_runner.c',
    'tests/test_safety.c',
    'tests/test_command_guard.c',
    'tests/test_injection.c',
    'tests/test_stream_processor.c',
    'tests/test_loop_guard.c',
    'tests/test_tools.c',
    'tests/test_agent_runtime.c',
    'tests/test_json_rpc.c'
  ]
  const CFLAGS = ['/nologo', '/O2', '/W3', '/D_CRT_SECURE_NO_WARNINGS', '/Iinclude', '/utf-8']

  const clInPath = which('cl')
  const vcvars = clInPath ? null : findVcvars64()
  if (!clInPath && !vcvars) {
    fail(
      '未找到 MSVC 编译器（cl 不在 PATH，vswhere 也未定位到任何含 VC.Tools 的安装）。' +
        '请安装 Visual Studio 2022+ 或 Build Tools，或在开发者命令行中重跑 npm run build:c。'
    )
  }

  // cl 必须在 vcvars 环境里跑；把整段构建写进一个 cmd 脚本一次性执行
  const lines = []
  if (vcvars) lines.push(`call "${vcvars}"`)
  lines.push('if not exist bin mkdir bin')
  lines.push('if not exist obj mkdir obj')
  lines.push(
    `cl ${CFLAGS.join(' ')} /Fe:bin\\shangbo_agent.exe src\\main.c ${SRCS.join(' ')} /Fo:obj\\`
  )
  lines.push('if errorlevel 1 exit /b 1')
  lines.push(
    `cl ${CFLAGS.join(' ')} /Fe:bin\\test_runner.exe ${TESTS.join(' ')} ${SRCS.join(' ')} /Fo:obj\\`
  )
  lines.push('if errorlevel 1 exit /b 1')
  lines.push('bin\\test_runner.exe')
  lines.push('if errorlevel 1 exit /b 1')

  const script = `${lines.join('\n')}\n`
  // cmd /s /c 对内层引号有剥离规则，含空格路径（如 d:\Program Files\...）会被吃掉；
  // 写成临时 .cmd 文件再以完整路径调用，绕开引号转义这一类问题。
  const tmp = mkdtempSync(join(tmpdir(), 'build-c-'))
  const scriptPath = join(tmp, 'build.cmd')
  writeFileSync(scriptPath, script, 'utf8')
  try {
    const result = spawnSync('cmd.exe', ['/d', '/c', scriptPath], { stdio: 'inherit', cwd: cCore })
    if (result.error) fail(`无法启动 cmd.exe：${result.error.message}`)
    if (result.status !== 0) fail(`C-Core 构建或测试失败（退出码 ${result.status}）`)
  } finally {
    rmSync(tmp, { recursive: true, force: true })
  }
  console.log('[build-c] Windows MSVC 构建与测试通过')
}

function buildUnix() {
  run('make', ['-C', cCore, 'clean'], { cwd: cCore })
  run('make', ['-C', cCore, 'all', 'test'], { cwd: cCore })
  console.log('[build-c] Linux/macOS 构建与测试通过')
}

if (platform === 'win32') {
  if (arch !== 'x64' && arch !== 'arm64') fail(`不支持的 Windows 架构：${arch}`)
  buildWindows()
} else {
  buildUnix()
}
