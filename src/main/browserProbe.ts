import { existsSync, statSync } from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { spawn } from 'node:child_process'

/** 固定本机 CDP 端口；不接受渲染层传入 URL，避免把浏览器探测变成通用代理。 */
export const CHROME_DEBUG_VERSION_URL = 'http://127.0.0.1:9222/json/version'
const MAX_PROBE_BYTES = 16 * 1024

export function probeChromeDebugging(): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let request: http.ClientRequest | undefined
    const finish = (connected: boolean): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      request?.destroy()
      resolve(connected)
    }
    request = http.get(CHROME_DEBUG_VERSION_URL, {
      timeout: 1500,
      headers: { Accept: 'application/json', Connection: 'close' }
    }, (response) => {
      if (response.statusCode !== 200) {
        response.resume()
        finish(false)
        return
      }
      let bytes = 0
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => {
        bytes += Buffer.byteLength(chunk)
        if (bytes > MAX_PROBE_BYTES) {
          finish(false)
          return
        }
        body += chunk
      })
      response.on('end', () => {
        try {
          const parsed = JSON.parse(body) as { Browser?: unknown }
          finish(typeof parsed.Browser === 'string' && parsed.Browser.length > 0)
        } catch {
          finish(false)
        }
      })
      response.on('error', () => finish(false))
    })
    timer = setTimeout(() => finish(false), 2000)
    request.on('timeout', () => finish(false))
    request.on('error', () => finish(false))
  })
}

export interface ChromeDetails {
  connected: boolean
  browser?: string
  webSocketDebuggerUrl?: string
}

function fetchVersionJson(): Promise<{ Browser?: unknown; webSocketDebuggerUrl?: unknown } | null> {
  return new Promise((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let request: http.ClientRequest | undefined
    const finish = (value: { Browser?: unknown; webSocketDebuggerUrl?: unknown } | null): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      request?.destroy()
      resolve(value)
    }
    request = http.get(CHROME_DEBUG_VERSION_URL, {
      timeout: 1500,
      headers: { Accept: 'application/json', Connection: 'close' }
    }, (response) => {
      if (response.statusCode !== 200) {
        response.resume()
        finish(null)
        return
      }
      let bytes = 0
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => {
        bytes += Buffer.byteLength(chunk)
        if (bytes > MAX_PROBE_BYTES) {
          finish(null)
          return
        }
        body += chunk
      })
      response.on('end', () => {
        try {
          finish(JSON.parse(body) as { Browser?: unknown; webSocketDebuggerUrl?: unknown })
        } catch {
          finish(null)
        }
      })
      response.on('error', () => finish(null))
    })
    timer = setTimeout(() => finish(null), 2000)
    request.on('timeout', () => finish(null))
    request.on('error', () => finish(null))
  })
}

export async function probeChromeDetails(): Promise<ChromeDetails> {
  const parsed = await fetchVersionJson()
  if (
    parsed &&
    typeof parsed.Browser === 'string' &&
    parsed.Browser.length > 0
  ) {
    const out: ChromeDetails = { connected: true, browser: parsed.Browser }
    if (typeof parsed.webSocketDebuggerUrl === 'string' && parsed.webSocketDebuggerUrl.length > 0) {
      out.webSocketDebuggerUrl = parsed.webSocketDebuggerUrl
    }
    return out
  }
  return { connected: false }
}

function isRealFile(p: string): boolean {
  try {
    return existsSync(p) && statSync(p).isFile()
  } catch {
    return false
  }
}

export function findChromeExecutable(): string | null {
  const candidates: string[] = []
  if (process.platform === 'win32') {
    const programFiles = process.env['ProgramFiles'] ?? 'C:\\Program Files'
    const programFilesX86 = process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)'
    const localAppData =
      process.env['LOCALAPPDATA'] ??
      (process.env['USERPROFILE'] ? path.join(process.env['USERPROFILE'], 'AppData', 'Local') : null)
    candidates.push(path.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'))
    candidates.push(path.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'))
    if (localAppData) {
      candidates.push(path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'))
    }
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
  } else {
    candidates.push(
      '/usr/bin/google-chrome',
      '/usr/bin/google-chrome-stable',
      '/opt/google/chrome/chrome',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium'
    )
  }
  for (const candidate of candidates) {
    if (isRealFile(candidate)) return candidate
  }
  return null
}

export type LaunchChromeResult =
  | { ok: true; alreadyRunning: true; browser?: string; message: string }
  | { ok: true; alreadyRunning: false; profileDir: string; browser?: string }
  | { ok: false; error: string }

const LAUNCH_POLL_MS = 250
const LAUNCH_TIMEOUT_MS = 5000

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export async function launchChromeForDebugging(userDataDir: string): Promise<LaunchChromeResult> {
  const existing = await probeChromeDetails()
  if (existing.connected) {
    return { ok: true, alreadyRunning: true, browser: existing.browser, message: 'Chrome 9222 调试端口已在运行' }
  }
  const exe = findChromeExecutable()
  if (!exe) {
    return { ok: false, error: '未在本机找到 Google Chrome 可执行文件，请先安装 Chrome。' }
  }
  // Chrome 136+ 禁止在默认用户目录开远程调试：专用目录既合规又能长期保留登录态。
  const profileDir = path.join(userDataDir, 'chrome-debug-profile')
  const child = spawn(
    exe,
    ['--remote-debugging-port=9222', `--user-data-dir=${profileDir}`, '--no-first-run', '--no-default-browser-check'],
    { detached: true, stdio: 'ignore', windowsHide: false }
  )
  let spawnFailed: { error: Error | null } = { error: null }
  child.on('error', (err: unknown) => {
    spawnFailed.error = err instanceof Error ? err : new Error(String(err))
  })
  child.unref()
  const deadline = Date.now() + LAUNCH_TIMEOUT_MS
  while (Date.now() < deadline) {
    if (spawnFailed.error) {
      return { ok: false, error: `启动 Chrome 失败：${spawnFailed.error.message}` }
    }
    await sleep(LAUNCH_POLL_MS)
    const details = await probeChromeDetails()
    if (details.connected) {
      return { ok: true, alreadyRunning: false, profileDir, browser: details.browser }
    }
  }
  if (spawnFailed.error) {
    return { ok: false, error: `启动 Chrome 失败：${spawnFailed.error.message}` }
  }
  return { ok: false, error: 'Chrome 已启动，但 5 秒内未检测到 9222 调试端口就绪，请检查端口或独立配置目录是否被占用。' }
}
