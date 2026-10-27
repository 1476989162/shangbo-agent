import { describe, expect, it } from 'vitest'
import {
  deriveSessionKey,
  deriveSharedSecret,
  generateKeyPair
} from '../main/remote/crypto'
import { createPairingSession } from './pairing'

describe('手机 X25519 配对', () => {
  it('手机与桌面派生完全相同的会话密钥', () => {
    const desktop = generateKeyPair()
    const mobile = createPairingSession(desktop.publicKey.toString('base64url'))
    const phonePublic = Buffer.from(mobile.phonePublicKeyB64, 'base64url')
    const shared = deriveSharedSecret(desktop.privateKey, phonePublic)
    const desktopSessionKey = deriveSessionKey(shared, desktop.publicKey, phonePublic)
    expect(mobile.sessionKeyB64).toBe(desktopSessionKey.toString('base64url'))
  })

  it('桌面公钥长度错误时拒绝配对', () => {
    expect(() => createPairingSession('dG9vLXNob3J0')).toThrow('桌面公钥长度非法')
  })
})
