import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import http from 'node:http'
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

/* Ticket 2：静态文件校验与手机重连覆盖 */
describe('静态文件校验与手机重连 (Ticket 2)', () => {
  before(async () => {
    stopServer()
    await startServer({ RELAY_ACCESS_KEY: '' })
  })
  after(() => stopServer())

  /** HTTP GET 静态路径，返回 { status, body }。 */
  function httpGet(path, timeoutMs = 5000) {
    return new Promise((resolve, reject) => {
      const req = http.request(
        { host: '127.0.0.1', port: PORT, path, method: 'GET' },
        (res) => {
          const chunks = []
          res.on('data', (c) => chunks.push(c))
          res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }))
        }
      )
      req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error('http timeout')) })
      req.on('error', reject)
      req.end()
    })
  }

  it('非法百分号编码的静态路径返回 400', async () => {
    const res = await httpGet('/%zz-bad-encoding')
    assert.equal(res.status, 400)
    assert.equal(res.body, 'bad encoding')
  })

  it('..穿越（反斜杠与裸写）返回 403', async () => {
    // new URL() 会把 /%2e%2e%2f 规范化成 /，所以用反斜杠形态与裸 .. 测真穿越：
    // normalize 前文件路径若逃出 PUBLIC_DIR 必须在 readFile 之前就拒 403
    const bs = await httpGet('/..%5cserver.mjs')
    assert.equal(bs.status, 403)
    assert.equal(bs.body, 'forbidden')
    const raw = await httpGet('/..%2fserver.mjs')
    assert.equal(raw.status, 403)
  })

  it('..%2f 穿越（编码点段）返回 403', async () => {
    // %2f 解码后是 /：join 前把 .. 提到 PUBLIC_DIR 之上，normalize 收敛后必在界外 → 403
    const res = await httpGet('/..%2f..%2fserver.mjs')
    assert.equal(res.status, 403)
    assert.equal(res.body, 'forbidden')
  })

  it('手机重连时旧连接被关闭，新连接接管索引', async () => {
    // register 与 pair-issue 必须在同一条连接上（pair-issue 校验 peer 是 desktop）
    const code = await new Promise((resolve, reject) => {
      const ws = new WebSocket(BASE, { headers: { 'x-forwarded-proto': 'https' } })
      const timer = setTimeout(() => reject(new Error('pair flow timeout')), 8000)
      ws.on('open', () => ws.send(JSON.stringify({ op: 'register-desktop' })))
      ws.on('message', (d) => {
        const m = JSON.parse(String(d))
        if (m.ok && m.data?.roomId) ws.send(JSON.stringify({ op: 'pair-issue' }))
        else if (m.ok && m.data?.code) { clearTimeout(timer); ws.close(); resolve(m.data.code) }
        else { clearTimeout(timer); ws.close(); reject(new Error(`unexpected: ${JSON.stringify(m)}`)) }
      })
      ws.on('error', reject)
    })
    assert.ok(code)
    const redeem = await control({ op: 'pair-redeem', code })
    assert.equal(redeem.ok, true)
    const phoneToken = redeem.data.phoneToken

    // 第一条手机连接：保持打开
    const ws1 = new WebSocket(BASE, { headers: { 'x-forwarded-proto': 'https' } })
    await new Promise((resolve, reject) => {
      ws1.on('open', () => ws1.send(JSON.stringify({ op: 'join-phone', phoneToken })))
      ws1.on('message', (d) => { if (JSON.parse(String(d)).ok) resolve() })
      ws1.on('error', reject)
    })

    let ws1Closed = false
    const closed1 = new Promise((resolve) => ws1.on('close', (code, reason) => {
      ws1Closed = true
      resolve({ code, reason: String(reason) })
    }))

    // 第二条同 token 连接：应顶替第一条
    const ws2 = new WebSocket(BASE, { headers: { 'x-forwarded-proto': 'https' } })
    await new Promise((resolve, reject) => {
      ws2.on('open', () => ws2.send(JSON.stringify({ op: 'join-phone', phoneToken })))
      ws2.on('message', (d) => { if (JSON.parse(String(d)).ok) resolve() })
      ws2.on('error', reject)
    })

    // 旧连接被服务端以 1000/replaced 关掉
    const closeInfo = await closed1
    assert.equal(ws1Closed, true)
    assert.equal(closeInfo.code, 1000)
    assert.equal(closeInfo.reason, 'replaced')

    // 新连接仍活着，服务进程没崩：再发一次 join-phone 仍能正常应答
    const again = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('ws2 no reply')), 5000)
      ws2.once('message', (d) => { clearTimeout(timer); resolve(JSON.parse(String(d))) })
      ws2.send(JSON.stringify({ op: 'join-phone', phoneToken }))
    })
    assert.equal(again.ok, true)
    ws2.close()
  })
})
