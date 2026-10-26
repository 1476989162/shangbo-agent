import { describe, expect, it } from 'vitest'
import {
  canCheckAgain,
  canDownload,
  canInstall,
  initialUpdateState,
  reduceUpdateEvent,
  unsupportedState
} from './state'
import { SettingSchemas } from '../settingsSchema'
import type { UpdateState } from '../../shared/types'

/* 自更新的状态机是唯一真源：主进程与渲染层都不再各自判断"现在能不能装"，
   所以迁移表必须在没有 Electron 的情况下被测全。 */

function at(status: UpdateState['status'], extra: Partial<UpdateState> = {}): UpdateState {
  return { status, currentVersion: '0.2.2', updatedAt: Date.now(), ...extra }
}

describe('更新状态机 (reduceUpdateEvent)', () => {
  it('正常链路：checking → available → downloading → ready → installing', () => {
    let s = initialUpdateState('0.2.2')
    s = reduceUpdateEvent(s, { type: 'checking-for-update' })
    expect(s.status).toBe('checking')

    s = reduceUpdateEvent(s, { type: 'update-available', version: '0.3.0', releaseNotes: 'x' })
    expect(s.status).toBe('available')
    expect(s.newVersion).toBe('0.3.0')

    s = reduceUpdateEvent(s, { type: 'download-progress', percent: 42.567, transferred: 1, total: 2 })
    expect(s.status).toBe('downloading')
    expect(s.percent).toBe(42.6)

    s = reduceUpdateEvent(s, { type: 'update-downloaded', version: '0.3.0' })
    expect(s.status).toBe('ready')
    expect(s.percent).toBe(100)

    s = reduceUpdateEvent(s, { type: 'install-requested' })
    expect(s.status).toBe('installing')
  })

  it('进度事件不能把 notAvailable 变成 downloading', () => {
    const s = at('notAvailable')
    const next = reduceUpdateEvent(s, { type: 'download-progress', percent: 10, transferred: 1, total: 10 })
    expect(next).toBe(s)
  })

  it('未下载完成时拒绝安装请求', () => {
    const s = at('available', { newVersion: '0.3.0' })
    expect(reduceUpdateEvent(s, { type: 'install-requested' })).toBe(s)
    expect(canInstall(s)).toBe(false)
    expect(canInstall(at('ready', { newVersion: '0.3.0' }))).toBe(true)
  })

  it('下载出错停在 error，且带着版本号可重试；取消下载回到 available', () => {
    let s = reduceUpdateEvent(at('available', { newVersion: '0.3.0' }), {
      type: 'error',
      message: 'net::ERR_CONNECTION_RESET'
    })
    expect(s.status).toBe('error')
    expect(s.error).toBe('net::ERR_CONNECTION_RESET')
    expect(canDownload(s)).toBe(true)

    s = reduceUpdateEvent(s, { type: 'checking-for-update' })
    expect(s.status).toBe('checking')
    expect(s.error).toBeUndefined()

    const cancelled = reduceUpdateEvent(at('downloading', { newVersion: '0.3.0' }), {
      type: 'update-cancelled'
    })
    expect(cancelled.status).toBe('available')
    expect(cancelled.percent).toBeUndefined()
  })

  it('没有版本号的 error 不允许直接下载', () => {
    expect(canDownload(at('error', { error: '404' }))).toBe(false)
  })

  it('unsupported 与 installing 是终态，不再接受任何事件', () => {
    const u = unsupportedState('0.2.2', '开发环境不启用自动更新')
    expect(reduceUpdateEvent(u, { type: 'update-available', version: '0.3.0' })).toBe(u)
    expect(canCheckAgain(u)).toBe(false)

    const i = at('installing', { newVersion: '0.3.0' })
    expect(reduceUpdateEvent(i, { type: 'error', message: 'boom' })).toBe(i)
    expect(canCheckAgain(i)).toBe(false)
  })

  it('非法百分比被夹到 0–100，NaN 归零', () => {
    const s = at('downloading')
    expect(reduceUpdateEvent(s, { type: 'download-progress', percent: 137, transferred: 0, total: 1 }).percent).toBe(
      100
    )
    expect(reduceUpdateEvent(s, { type: 'download-progress', percent: NaN, transferred: 0, total: 1 }).percent).toBe(0)
    expect(reduceUpdateEvent(s, { type: 'download-progress', percent: -5, transferred: 0, total: 1 }).percent).toBe(0)
  })

  it('每次迁移都刷新 updatedAt，且不改写传入的状态对象', () => {
    const s: UpdateState = { status: 'idle', currentVersion: '0.2.2', updatedAt: 1 }
    const next = reduceUpdateEvent(s, { type: 'checking-for-update' })
    expect(next).not.toBe(s)
    expect(next.updatedAt).toBeGreaterThanOrEqual(1)
    expect(s.status).toBe('idle')
  })

  it('两个更新开关必须已登记进设置白名单，否则渲染层无法持久化', () => {
    expect(SettingSchemas['app.update.check']).toBeTruthy()
    expect(SettingSchemas['app.update.autoDownload']).toBeTruthy()
  })
})
