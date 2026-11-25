import { describe, expect, it, vi, beforeEach } from 'vitest'
import { SessionCipher } from './crypto'

/* 桌面待确认配对队列：暂存→确认→拒绝→过期清理。重模块全部 mock，只测 service 逻辑。 */

const secretStore = new Map<string, string>()

vi.mock('../secrets', () => ({
  getSecret: (k: string) => secretStore.get(k) ?? null,
  setSecret: (k: string, v: string) => {
    secretStore.set(k, v)
  },
  deleteSecret: (k: string) => {
    secretStore.delete(k)
  }
}))

vi.mock('../settings', () => ({
  getSetting: (_k: string, fallback: unknown) => fallback,
  setSetting: () => {}
}))

const deviceRows: { id: string; name: string }[] = []
let deviceSeq = 0
vi.mock('./devices', () => ({
  addPairedDevice: (name: string, _pub: string) => {
    deviceSeq++
    const d = { id: `d${deviceSeq}`, name }
    deviceRows.push(d)
    return { ...d, createdAt: Date.now(), lastSeenAt: null, revokedAt: null }
  },
  getPairedDevice: () => null,
  listPairedDevices: () => [...deviceRows],
  revokePairedDevice: () => false
}))

vi.mock('./client', () => ({
  RemoteClient: class {
    constructor(..._args: unknown[]) {}
  }
}))

import { remoteService } from './service'

function phonePub(): string {
  const b = new Uint8Array(32)
  crypto.getRandomValues(b)
  return Buffer.from(b).toString('base64url')
}

beforeEach(() => {
  secretStore.clear()
  deviceRows.length = 0
  deviceSeq = 0
  // 上一个用例的待确认不能漏到下一个
  for (const p of remoteService.listPendingPairings()) {
    void remoteService.denyPendingPairing(p.phoneToken)
  }
})

describe('桌面待确认配对队列', () => {
  it('手机扫码后进入待确认，桌面有点确认按钮要的数据（指纹/时间）', () => {
    remoteService.handlePairingHello('我的手机', phonePub(), 'tok-1')
    const list = remoteService.listPendingPairings()
    expect(list).toHaveLength(1)
    expect(list[0].deviceName).toBe('我的手机')
    expect(list[0].fingerprint).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/)
  })

  it('非法公钥直接忽略，不会卡出确认按钮', () => {
    remoteService.handlePairingHello('坏手机', '!!!not-base64!!!', 'tok-bad')
    expect(remoteService.listPendingPairings()).toHaveLength(0)
  })

  it('同一手机重连覆盖旧请求不堆积', () => {
    const pub = phonePub()
    remoteService.handlePairingHello('手机', pub, 'tok-dup')
    remoteService.handlePairingHello('手机', pub, 'tok-dup')
    expect(remoteService.listPendingPairings()).toHaveLength(1)
  })

  it('确认配对后手机入库存会话密钥，重复确认报错', async () => {
    remoteService.ensureDeviceKeys()
    remoteService.handlePairingHello('我的手机', phonePub(), 'tok-ok')
    const res = await remoteService.confirmPendingPairing('tok-ok')
    expect(res.deviceId).toBeTruthy()
    expect(deviceRows).toHaveLength(1)
    expect(remoteService.listPendingPairings()).toHaveLength(0)
    await expect(remoteService.confirmPendingPairing('tok-ok')).rejects.toThrow()
  })

  it('拒绝配对后请求消失，未知 token 返回 false', async () => {
    remoteService.handlePairingHello('陌生手机', phonePub(), 'tok-no')
    expect(await remoteService.denyPendingPairing('tok-no')).toBe(true)
    expect(remoteService.listPendingPairings()).toHaveLength(0)
    expect(await remoteService.denyPendingPairing('tok-no')).toBe(false)
  })

  it('5 分钟过期自动清理不会一直占着按钮', () => {
    const nowSpy = vi.spyOn(Date, 'now')
    nowSpy.mockReturnValue(1_000_000)
    remoteService.handlePairingHello('手机', phonePub(), 'tok-old')
    expect(remoteService.listPendingPairings()).toHaveLength(1)
    nowSpy.mockReturnValue(1_000_000 + 6 * 60 * 1000)
    expect(remoteService.listPendingPairings()).toHaveLength(0)
    nowSpy.mockRestore()
  })

  it('桌面重启后内存会话丢失也能从 secrets 恢复不断连', async () => {
    remoteService.ensureDeviceKeys()
    remoteService.handlePairingHello('我的手机', phonePub(), 'tok-reboot')
    const { deviceId } = await remoteService.confirmPendingPairing('tok-reboot')
    const svc = remoteService as unknown as {
      sessions: Map<string, SessionCipher>
      currentDeviceId: string | null
      ensureSessionLoaded(): void
    }
    // 模拟重启：内存全丢但 secrets 还在
    svc.sessions.clear()
    svc.currentDeviceId = null
    svc.ensureSessionLoaded()
    expect(svc.currentDeviceId).toBe(deviceId)
    expect(svc.sessions.has(deviceId)).toBe(true)
    // 恢复出的密钥能正常加解密
    const raw = secretStore.get(`remote.session.${deviceId}`)
    expect(raw).toBeTruthy()
    const probe = new SessionCipher(Buffer.from(raw!, 'base64url'))
    const frame = probe.seal('重启后第一帧')
    expect(svc.sessions.get(deviceId)!.open(frame)).toBe('重启后第一帧')
  })

  it('重启后发送序号从持久化水位继续，而不是归零重发（手机刷新自封根因）', async () => {
    remoteService.ensureDeviceKeys()
    remoteService.handlePairingHello('我的手机2', phonePub(), 'tok-seq')
    const { deviceId } = await remoteService.confirmPendingPairing('tok-seq')
    const svc = remoteService as unknown as {
      sessions: Map<string, SessionCipher>
      currentDeviceId: string | null
      ensureSessionLoaded(): void
    }
    // 模拟已发到序号 42（若干轮对话后崩溃/重启）
    secretStore.set(`remote.sendSeq.${deviceId}`, '42')
    svc.sessions.clear()
    svc.currentDeviceId = null
    svc.ensureSessionLoaded()
    const restored = svc.sessions.get(deviceId)
    expect(restored).toBeTruthy()
    expect(restored!.getSendSeq()).toBe(42)
    // 下一帧序号必须 > 42：归零会让手机端把新帧判成重放并累计解密失败封禁
    const next = restored!.seal('重启后第一帧')
    expect(next.seq).toBe(42)
    expect(restored!.getSendSeq()).toBe(43)
  })
})
