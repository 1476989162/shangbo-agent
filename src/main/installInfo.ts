import { app } from 'electron'
import log from 'electron-log/main'
import { accessSync, constants, unlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { AppInfo } from '../shared/types'

export const FEED_URL_ENV = 'SHANGBO_UPDATE_FEED_URL'

export type InstallInfo = Pick<
  AppInfo,
  'installPath' | 'installWritable' | 'logPath' | 'updateChannel'
>

/**
 * 安装目录可写检测（P0更新修复：E盘Program Files场景）。
 * 只做同步轻量探测：往安装根写一个临时文件试一次，失败即不可写。
 * 开发态 appPath 在 out/ 下，照常返回，便于设置页联调。
 */
export function getInstallInfo(): InstallInfo {
  let installPath = ''
  let installWritable = true
  try {
    const appPath = app.getAppPath()
    // 打包后 appPath=.../resources/app.asar，上两级即安装根；开发态为 out/main
    installPath = app.isPackaged ? dirname(dirname(appPath)) : dirname(appPath)
    const probe = join(installPath, '.shangbo-write-test')
    try {
      writeFileSync(probe, '1')
      // 删不掉也算可写（杀软锁文件常见），只看能不能建
      try {
        unlinkSync(probe)
      } catch {
        // 忽略清理失败
      }
      // 二次确认：文件建出来后还要求有写权限位
      accessSync(installPath, constants.W_OK)
      installWritable = true
    } catch {
      installWritable = false
    }
  } catch {
    installPath = ''
    installWritable = false
  }

  let logPath = ''
  try {
    logPath = log.transports.file.getFile()?.path ?? ''
  } catch {
    logPath = ''
  }

  const updateChannel: InstallInfo['updateChannel'] = !app.isPackaged
    ? 'none'
    : process.env[FEED_URL_ENV]
      ? 'generic'
      : 'github'

  return { installPath, installWritable, logPath, updateChannel }
}
