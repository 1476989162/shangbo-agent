import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { generateKeyPairSync, sign } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { WebSocket } from 'ws'
import { identityFingerprint } from '../identity.mjs'

/**
 * 中转进程级测试：真实起 server.mjs，验证
 * - 准入密钥能挡住不知道密钥的人
 * - 身份白名单下别人抄到公钥也伪造不了签名（只有我能用）
 * - 房间数上限生效
 */

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVER = join(HERE, '..', 'server.mjs')
const ACCESS_KEY = 'test-access-key-123'
const PORT = 18787 + Math.floor(Math.random() * 500)
const BASE = `ws://127.0.0.1:${PORT}`

let child = null

/** 造一个 Ed25519 身份：裸公钥 base64url + 展示指纹 + 签名函数。 */
function makeIdentity() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const spki = publicKey.export({ format: 'der', type: 'spki' })
  const raw = spki.subarray(spki.length - 32)
  const pubB64 = Buffer.from(raw).toString('base64url')
  return {
    pubB64,
    fingerprint: identityFingerprint(pubB64),
    sign: (message) => sign(null, Buffer.from(message, 'utf8'), privateKey).toString('base64url')
  }
}

function startServer(env = {}) {
  return new Promise((resolve, reject) => {
    child = spawn(process.execPath, [SERVER], {
      env: { ...process.env, RELAY_PORT: String(PORT), RELAY_HOST: '127.0.0.1', ...env },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    const timer = setTimeout(() => reject(new Error('server start timeout')), 10_000)
    child.stdout.on('data', (d) => {
      if (String(d).includes('listening on')) {
        clearTimeout(timer)
        resolve()
      }
    })
    child.stderr.on('data', (d) => {
      clearTimeout(timer)
      reject(new Error(String(d)))
    })
    child.on('exit', (code) => {
      clearTimeout(timer)
      if (code !== 0) reject(new Error(`server exited ${code}`))
    })
  })
}

function stopServer() {
  if (child && !child.killed) child.kill()
  child = null
}

/** 连中转发一条控制消息，返回回包。 */
function control(payload, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    // 中转要求 X-Forwarded-Proto（生产在 TLS 反代后），测试直连需要补这个头
    const ws = new WebSocket(BASE, { headers: { 'x-forwarded-proto': 'https' } })
    const timer = setTimeout(() => {
      ws.close()
      reject(new Error('no reply'))
    }, timeoutMs)
    ws.on('open', () => ws.send(JSON.stringify(payload)))
    ws.on('message', (data) => {
      clearTimeout(timer)
      const msg = JSON.parse(String(data))
      ws.close()
      resolve(msg)
    })
    ws.on('error', (error) => {
      clearTimeout(timer)
      reject(error)
    })
    ws.on('close', () => {
      clearTimeout(timer)
      resolve({ closed: true })
    })
  })
}

/** 完整走一次"挑战 → 签名 → 注册"，返回回包。 */
async function registerWithIdentity(identity, extra = {}) {
  const first = await control({ op: 'register-desktop', pubKey: identity.pubB64, ...extra })
  if (!first.ok || !first.data?.challenge) return first
  const challenge = first.data.challenge
  return control({
    op: 'register-desktop',
    pubKey: identity.pubB64,
    challenge,
    signature: identity.sign(`${challenge}|${identity.pubB64}`),
    ...extra
  })
}

describe('中转准入控制（进程级）', () => {
  after(() => stopServer())

  it('设了 RELAY_ACCESS_KEY：陌生人无密钥注册被拒', async () => {
    stopServer()
    await startServer({ RELAY_ACCESS_KEY: ACCESS_KEY })
    const reply = await control({ op: 'register-desktop' })
    assert.equal(reply.ok, false)
    assert.equal(reply.error, 'access denied')
  })

  it('设了 RELAY_ACCESS_KEY：密钥错误被拒', async () => {
    const reply = await control({ op: 'register-desktop', accessKey: 'wrong-key' })
    assert.equal(reply.ok, false)
    assert.equal(reply.error, 'access denied')
  })

  it('设了 RELAY_ACCESS_KEY：密钥正确可注册，拿到 roomId 与 deviceToken', async () => {
    const reply = await control({ op: 'register-desktop', accessKey: ACCESS_KEY })
    assert.equal(reply.ok, true)
    assert.ok(reply.data.roomId)
    assert.ok(reply.data.deviceToken)
  })

  it('房间数上限：超限注册被拒（防止远程 OOM）', async () => {
    stopServer()
    await startServer({ RELAY_MAX_ROOMS: '1' })
    const first = await control({ op: 'register-desktop' })
    assert.equal(first.ok, true)
    const second = await control({ op: 'register-desktop' })
    assert.equal(second.ok, false)
    assert.equal(second.error, 'relay room limit reached')
  })

  it('未设准入密钥时保持向后兼容：任何人可注册（开放模式）', async () => {
    stopServer()
    await startServer({ RELAY_ACCESS_KEY: '' })
    const reply = await control({ op: 'register-desktop' })
    assert.equal(reply.ok, true)
    assert.ok(reply.data.roomId)
  })
})

/* 身份白名单：只有我。服务器只存公钥，别人抄到公钥也伪造不了签名。 */
describe('身份白名单：只有我能用（进程级）', () => {
  // 全块共享同一台服务器与同一批身份：否则每个用例新建身份都不在白名单里
  const mine = makeIdentity()
  const other = makeIdentity()
  const stranger = makeIdentity()

  before(async () => {
    stopServer()
    await startServer({ RELAY_ALLOWED_DESKTOPS: `${mine.fingerprint},${other.fingerprint}` })
  })
  after(() => stopServer())

  it('陌生身份（不在白名单）连注册都过不去', async () => {
    const reply = await control({ op: 'register-desktop', pubKey: stranger.pubB64 })
    assert.equal(reply.ok, false)
    assert.equal(reply.error, 'desktop not allowed')
  })

  it('不带任何身份信息的注册被拒', async () => {
    const reply = await control({ op: 'register-desktop' })
    assert.equal(reply.ok, false)
    assert.equal(reply.error, 'desktop identity required')
  })

  it('抄到我的公钥但没私钥：挑战签名过不了', async () => {
    // 攻击者用我的公钥申请挑战（公钥是公开信息，他能抄到）
    const first = await control({ op: 'register-desktop', pubKey: mine.pubB64 })
    assert.equal(first.ok, true)
    assert.ok(first.data.challenge)
    // 但他只能用自己的私钥签 → bad signature
    const forged = await control({
      op: 'register-desktop',
      pubKey: mine.pubB64,
      challenge: first.data.challenge,
      signature: stranger.sign(`${first.data.challenge}|${mine.pubB64}`)
    })
    assert.equal(forged.ok, false)
    assert.equal(forged.error, 'bad signature')
  })

  it('我本人：挑战 → 签名 → 注册成功', async () => {
    const reply = await registerWithIdentity(mine)
    assert.equal(reply.ok, true)
    assert.ok(reply.data.roomId)
    assert.ok(reply.data.deviceToken)
  })

  it('挑战一次性：同一挑战不能重放注册第二个房间', async () => {
    const first = await control({ op: 'register-desktop', pubKey: mine.pubB64 })
    const challenge = first.data.challenge
    const signature = mine.sign(`${challenge}|${mine.pubB64}`)
    const ok = await control({ op: 'register-desktop', pubKey: mine.pubB64, challenge, signature })
    assert.equal(ok.ok, true)
    const replay = await control({ op: 'register-desktop', pubKey: mine.pubB64, challenge, signature })
    assert.equal(replay.ok, false)
    assert.equal(replay.error, 'challenge expired')
  })

  it('用别人的 deviceToken 顶替房间被拒', async () => {
    // 我先正常注册，拿到自己的 deviceToken
    const reg = await registerWithIdentity(mine)
    assert.equal(reg.ok, true)
    const deviceToken = reg.data.deviceToken
    assert.ok(deviceToken)
    // 另一个白名单身份（合法但不是我）带完整签名 + 我的 token，想认领我的房间
    const stolen = await registerWithIdentity(other, { deviceToken })
    assert.equal(stolen.ok, false)
    assert.equal(stolen.error, 'desktop not allowed')
  })

  it('白名单启用时默认不再强制准入密钥（白名单本身更严格）', async () => {
    stopServer()
    await startServer({ RELAY_ALLOWED_DESKTOPS: mine.fingerprint, RELAY_ACCESS_KEY: ACCESS_KEY })
    // 不带 accessKey，只靠身份签名即可
    const reply = await registerWithIdentity(mine)
    assert.equal(reply.ok, true)
    assert.ok(reply.data.roomId)
  })

  it('RELAY_REQUIRE_ACCESS_KEY=1 时两者都要满足', async () => {
    stopServer()
    await startServer({
      RELAY_ALLOWED_DESKTOPS: mine.fingerprint,
      RELAY_ACCESS_KEY: ACCESS_KEY,
      RELAY_REQUIRE_ACCESS_KEY: '1'
    })
    // 只有身份签名、没有准入密钥 → 被拒
    const noKey = await registerWithIdentity(mine)
    assert.equal(noKey.ok, false)
    assert.equal(noKey.error, 'access denied')
    // 两者都有 → 通过
    const both = await registerWithIdentity(mine, { accessKey: ACCESS_KEY })
    assert.equal(both.ok, true)
    assert.ok(both.data.roomId)
  })
})
