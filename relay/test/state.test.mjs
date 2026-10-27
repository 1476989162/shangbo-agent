import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { RelayState, RateLimiter } from '../state.mjs'

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
