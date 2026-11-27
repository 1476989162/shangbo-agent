import { globalShortcut } from 'electron'
import log from 'electron-log/main'
import { availability } from './agentDesktop'
import { loadNut } from './index'

/**
 * 电脑控制双通道自检 + 全局急停热键。
 *
 * 红线：
 * - 禁止注册裸 Escape（会劫持全系统软件）与 Ctrl+Shift+Esc（任务管理器冲突）。
 * - 探测失败如实返回错误文本，绝不伪装可用。
 */

// 全局急停：切到其他窗口也能中止自动化。Ctrl+Alt+X 无系统冲突、可单手按。
export const EMERGENCY_STOP_ACCELERATOR = 'CommandOrControl+Alt+X'

export function getEmergencyStopDisplayLabel(): string {
  return process.platform === 'darwin' ? 'Cmd+Option+X' : 'Ctrl+Alt+X'
}

let emergencyStopRegistered = false

function globalShortcutSafe(): typeof globalShortcut | null {
  try {
    // 单测环境下 electron 桩里没有 globalShortcut：按不可用处理，不抛错
    const gs = globalShortcut as unknown as typeof globalShortcut | undefined
    if (!gs || typeof gs.isRegistered !== 'function') return null
    return gs
  } catch {
    return null
  }
}

export function getEmergencyStopState(): {
  accelerator: string
  displayLabel: string
  registered: boolean
} {
  const gs = globalShortcutSafe()
  if (gs) {
    try {
      emergencyStopRegistered = gs.isRegistered(EMERGENCY_STOP_ACCELERATOR)
    } catch {
      // 查询失败保持本地标记，不伪装
    }
  }
  return {
    accelerator: EMERGENCY_STOP_ACCELERATOR,
    displayLabel: getEmergencyStopDisplayLabel(),
    registered: emergencyStopRegistered
  }
}

export function registerEmergencyStop(onTrigger: () => void): boolean {
  const gs = globalShortcutSafe()
  if (!gs) {
    emergencyStopRegistered = false
    return false
  }
  try {
    if (gs.isRegistered(EMERGENCY_STOP_ACCELERATOR)) {
      emergencyStopRegistered = true
      return true
    }
    const ok = gs.register(EMERGENCY_STOP_ACCELERATOR, onTrigger)
    emergencyStopRegistered = ok
    if (!ok) log.warn('[computer] 全局急停热键注册失败（可能被其他程序占用）')
    return ok
  } catch (error) {
    log.warn('[computer] 全局急停热键注册异常', error)
    emergencyStopRegistered = false
    return false
  }
}

export function unregisterEmergencyStop(): void {
  try {
    globalShortcutSafe()?.unregister(EMERGENCY_STOP_ACCELERATOR)
  } catch {
    // 退出路径不抛错
  } finally {
    emergencyStopRegistered = false
  }
}

export interface ComputerProbeResult {
  agentDesktop: { available: boolean; binary: string | null; reason?: string }
  nutJs: { available: boolean; error?: string }
  emergencyStop: { accelerator: string; displayLabel: string; registered: boolean }
}

/** 双通道真实自检：agent-desktop 看二进制，nut-js 真实 import，急停看实际注册态。 */
export async function probeComputerStatus(): Promise<ComputerProbeResult> {
  const agentDesktop = availability()
  let nutJs: ComputerProbeResult['nutJs']
  try {
    await loadNut()
    nutJs = { available: true }
  } catch (error) {
    nutJs = { available: false, error: error instanceof Error ? error.message : String(error) }
  }
  return {
    agentDesktop: {
      available: agentDesktop.available,
      binary: agentDesktop.binary,
      ...(agentDesktop.reason ? { reason: agentDesktop.reason } : {})
    },
    nutJs,
    emergencyStop: getEmergencyStopState()
  }
}
