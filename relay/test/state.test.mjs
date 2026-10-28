import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { RelayState, RateLimiter, MAX_REVOKED_PHONES } from '../state.mjs'

/* 中转状态机：房间、配对码（过期/复用失败）、吊销。 */

describe('RelayState', () => {
  it('创建房间返回 roomId + deviceToken，凭 token 可重连认领', () => {
    const s = new RelayState()
    const { roomId, deviceToken } = s.createRoom()
    assert.ok(roomId && deviceToken)
    assert.equal(s.findRoomByDeviceToken(deviceToken)?.roomId, roomId)
  })

  it('配对码 5 分钟有效、只能用一次', () => {
    const s = new RelayState()
    const { roomId } = s.createRoom()
    const pairing = s.issuePairingCode(roomId)
    assert.ok(pairing?.code)
    const first = s.redeemPairingCode(pairing.code, 'pixel')
    assert.ok(first?.phoneToken)
    // 重复使用失败
    assert.equal(s.redeemPairingCode(pairing.code, 'pixel'), null)
  })

  it('过期配对码兑换失败', () => {
    const s = new RelayState()
    const { roomId } = s.createRoom()
    const pairing = s.issuePairingCode(roomId)
    assert.ok(pairing)
    pairing.expiresAt = Date.now() - 1
    assert.equal(s.redeemPairingCode(pairing.code, 'pixel'), null)
  })

  it('新配对码覆盖旧码（旧码作废）', () => {
    const s = new RelayState()
    const { roomId } = s.createRoom()
    const first = s.issuePairingCode(roomId)
    const second = s.issuePairingCode(roomId)
    assert.notEqual(first.code, second.code)
    assert.equal(s.redeemPairingCode(first.code, 'a'), null)
    assert.ok(s.redeemPairingCode(second.code, 'b'))
  })

  it('吊销手机后其 token 失效', () => {
    const s = new RelayState()
    const { roomId } = s.createRoom()
    const pairing = s.issuePairingCode(roomId)
    const redeemed = s.redeemPairingCode(pairing.code, 'pixel')
    assert.ok(redeemed)
    assert.equal(s.revokePhone(roomId, redeemed.phoneToken), true)
    assert.equal(s.isRevoked(redeemed.phoneToken), true)
    // 吊销不存在的返回 false
    assert.equal(s.revokePhone(roomId, 'nope'), false)
  })

  it('手机公钥等待桌面确认，确认后不再补发', () => {
    const s = new RelayState()
    const { roomId } = s.createRoom()
    const pairing = s.issuePairingCode(roomId)
    const redeemed = s.redeemPairingCode(pairing.code, 'pixel')
    assert.ok(redeemed)

    assert.equal(
      s.setPhonePairing(roomId, redeemed.phoneToken, 'phone-public-key', 'Pixel'),
      true
    )
    assert.deepEqual(s.listPendingPairings(roomId), [
      {
        phoneToken: redeemed.phoneToken,
        phonePub: 'phone-public-key',
        phoneName: 'Pixel'
      }
    ])

    assert.equal(s.markPhonePaired(roomId, redeemed.phoneToken), true)
    assert.deepEqual(s.listPendingPairings(roomId), [])
  })

  it('RateLimiter 每窗口限流', () => {
    const limiter = new RateLimiter(3, 1000)
    assert.equal(limiter.take(), true)
    assert.equal(limiter.take(), true)
    assert.equal(limiter.take(), true)
    assert.equal(limiter.take(), false)
  })
})

/* 公网资源上限：中转对全世界开放，房间与吊销表必须有界，
   否则任何人循环注册就能远程把内存吃光（无认证 OOM）。 */
describe('资源上限与回收', () => {
  it('房间数达到上限后拒绝新建（createRoom 返回 null）', () => {
    const s = new RelayState({ maxRooms: 2 })
    assert.ok(s.createRoom())
    assert.ok(s.createRoom())
    assert.equal(s.createRoom(), null)
    assert.equal(s.rooms.size, 2)
  })

  it('空闲空房间被回收，deviceToken 索引一并清理', () => {
    const s = new RelayState()
    const { roomId, deviceToken } = s.createRoom()
    assert.ok(s.findRoomByDeviceToken(deviceToken))
    // 桌面不在线、无手机，时间推到 TTL 之后
    const removed = s.sweepIdleRooms(Date.now() + 8 * 24 * 60 * 60 * 1000)
    assert.equal(removed, 1)
    assert.equal(s.getRoom(roomId), null)
    assert.equal(s.findRoomByDeviceToken(deviceToken), null)
    assert.equal(s.deviceTokens.size, 0)
  })

  it('有手机的房间不被回收', () => {
    const s = new RelayState()
    const { roomId } = s.createRoom()
    const pairing = s.issuePairingCode(roomId)
    assert.ok(s.redeemPairingCode(pairing.code, 'pixel'))
    const removed = s.sweepIdleRooms(Date.now() + 8 * 24 * 60 * 60 * 1000)
    assert.equal(removed, 0)
    assert.ok(s.getRoom(roomId))
  })

  it('吊销表有上限，超出淘汰最旧的', () => {
    const s = new RelayState()
    for (let i = 0; i < MAX_REVOKED_PHONES + 10; i++) s.rememberRevoked(`t${i}`)
    assert.equal(s.revokedPhones.size, MAX_REVOKED_PHONES)
    // 最旧的被淘汰，最新的保留
    assert.equal(s.isRevoked('t0'), false)
    assert.equal(s.isRevoked(`t${MAX_REVOKED_PHONES + 9}`), true)
  })

  it('phoneToken 索引 O(1) 定位房间，吊销后失效', () => {
    const s = new RelayState()
    const { roomId } = s.createRoom()
    const pairing = s.issuePairingCode(roomId)
    const { phoneToken } = s.redeemPairingCode(pairing.code, 'pixel')
    assert.equal(s.findRoomByPhoneToken(phoneToken)?.roomId, roomId)
    s.revokePhone(roomId, phoneToken)
    assert.equal(s.findRoomByPhoneToken(phoneToken), null)
    assert.equal(s.isRevoked(phoneToken), true)
  })
})
