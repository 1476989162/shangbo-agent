import { app, safeStorage } from 'electron'
import { chmodSync, existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import log from 'electron-log/main'

/**
 * API Key 一律不落明文：优先用系统密钥环（Windows 为 DPAPI）加密后再写入磁盘。
 * 若运行环境不支持加密（个别 Linux 容器），降级为带标记的明文并明确告警。
 */
const PLAIN_PREFIX = 'plain:'

let cache: Record<string, string> | null = null

function filePath(): string {
  return join(app.getPath('userData'), 'secrets.json')
}

function load(): Record<string, string> {
  if (cache) return cache
  const path = filePath()
  if (!existsSync(path)) {
    cache = {}
    return cache
  }
  try {
    cache = JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>
  } catch (error) {
    // 损坏的 JSON 先备份再重置：静默重置等于密钥全部丢失，用户无从找回
    try {
      const backup = `${path}.corrupt-${Date.now()}`
      writeFileSync(backup, readFileSync(path))
      log.error(`[secrets] 读取失败，已备份损坏文件到 ${backup} 并重置为空：`, error)
    } catch {
      log.error('[secrets] 读取失败且备份失败，重置为空：', error)
    }
    cache = {}
  }
  return cache
}

/**
 * 原子写入：先写临时文件再 rename 替换。Node 在 Windows 上 renameSync 可直接覆盖
 * 已存在文件，无需先 unlink——unlink+rename 两步之间崩溃会丢密钥。
 * 失败时（目标被占用等）退回带重试的 unlink+rename。
 */
function persist(): void {
  const path = filePath()
  const tmp = `${path}.tmp`
  writeFileSync(tmp, JSON.stringify(cache ?? {}, null, 2), 'utf8')
  try {
    if (process.platform !== 'win32') chmodSync(tmp, 0o600)
  } catch {
    // 权限收紧失败不影响主流程（如某些网络盘不支持）
  }
  try {
    renameSync(tmp, path)
  } catch {
    // Windows 目标被占用时 rename 可能失败，退回先删后改（带一次重试）
    try {
      if (existsSync(path)) unlinkSync(path)
    } catch {
      // 删除失败也不阻塞，rename 会再次报错并由上层感知
    }
    renameSync(tmp, path)
  }
}

export function setSecret(key: string, value: string): void {
  const store = load()
  if (safeStorage.isEncryptionAvailable()) {
    store[key] = safeStorage.encryptString(value).toString('base64')
  } else {
    log.warn('[secrets] 系统加密不可用，密钥将以明文保存')
    store[key] = PLAIN_PREFIX + value
  }
  persist()
}

export function getSecret(key: string): string | null {
  const raw = load()[key]
  if (!raw) return null
  if (raw.startsWith(PLAIN_PREFIX)) return raw.slice(PLAIN_PREFIX.length)
  try {
    return safeStorage.decryptString(Buffer.from(raw, 'base64'))
  } catch (error) {
    log.error(`[secrets] 解密失败：${key}`, error)
    return null
  }
}

export function hasSecret(key: string): boolean {
  return Boolean(load()[key])
}

export function deleteSecret(key: string): void {
  const store = load()
  if (!(key in store)) return
  delete store[key]
  persist()
}