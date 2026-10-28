/**
 * 端到端验证：模拟"我的桌面"与"陌生人的桌面"分别连真实中转，
 * 确认白名单下只有我能上线。
 *
 * 直接 node 跑：node relay/scripts/verify-only-me.mjs
 */
import { spawn } from 'node:child_process'
import { generateKeyPairSync, sign } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { WebSocket } from 'ws'
import { identityFingerprint } from '../identity.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const SERVER = join(HERE, '..', 'server.mjs')
const PORT = 19400 + Math.floor(Math.random() * 300)
const BASE = `ws://127.0.0.1:${PORT}`

function makeIdentity(name) {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  const spki = publicKey.export({ format: 'der', type: 'spki' })
  const raw = spki.subarray(spki.length - 32)
  const pubB64 = Buffer.from(raw).toString('base64url')
  return {
    name,
    pubB64,
    fingerprint: identityFingerprint(pubB64),
    sign: (m) => sign(null, Buffer.from(m, 'utf8'), privateKey).toString('base64url')
  }
}

function control(payload) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(BASE, { headers: { 'x-forwarded-proto': 'https' } })
    const timer = setTimeout(() => {
      ws.close()
      reject(new Error('timeout'))
    }, 5000)
    ws.on('open', () => ws.send(JSON.stringify(payload)))
    ws.on('message', (d) => {
      clearTimeout(timer)
      ws.close()
      resolve(JSON.parse(String(d)))
    })
    ws.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
  })
}

async function tryRegister(id) {
  const first = await control({ op: 'register-desktop', pubKey: id.pubB64 })
  if (!first.ok) return first
  const ch = first.data.challenge
  return control({
    op: 'register-desktop',
    pubKey: id.pubB64,
    challenge: ch,
    signature: id.sign(`${ch}|${id.pubB64}`)
  })
}

const me = makeIdentity('我的桌面')
const stranger = makeIdentity('陌生人的桌面')

const child = spawn(process.execPath, [SERVER], {
  env: {
    ...process.env,
    RELAY_PORT: String(PORT),
    RELAY_HOST: '127.0.0.1',
    RELAY_ALLOWED_DESKTOPS: me.fingerprint
  },
  stdio: ['ignore', 'pipe', 'pipe']
})

await new Promise((resolve, reject) => {
  const t = setTimeout(() => reject(new Error('server start timeout')), 10_000)
  child.stdout.on('data', (d) => {
    if (String(d).includes('listening on')) {
      clearTimeout(t)
      resolve()
    }
  })
  child.stderr.on('data', (d) => reject(new Error(String(d))))
})

console.log('白名单中只有：', me.fingerprint)
console.log('')

const mineResult = await tryRegister(me)
console.log(`[我的桌面]   注册结果：${mineResult.ok ? '✅ 成功' : '❌ 被拒'} ${mineResult.error ?? ''}`)

const strangerResult = await tryRegister(stranger)
console.log(
  `[陌生人桌面] 注册结果：${strangerResult.ok ? '❌ 居然成功了（有漏洞）' : '✅ 被拒'} ${strangerResult.error ?? ''}`
)

// 攻击者抄走我的公钥，用自己的私钥签名
const stealFirst = await control({ op: 'register-desktop', pubKey: me.pubB64 })
const forged = await control({
  op: 'register-desktop',
  pubKey: me.pubB64,
  challenge: stealFirst.data.challenge,
  signature: stranger.sign(`${stealFirst.data.challenge}|${me.pubB64}`)
})
console.log(
  `[抄我公钥伪造] 注册结果：${forged.ok ? '❌ 居然成功了（有漏洞）' : '✅ 被拒'} ${forged.error ?? ''}`
)

child.kill()

const pass = mineResult.ok && !strangerResult.ok && !forged.ok
console.log('')
console.log(pass ? '✅ 结论：只有我能用这个中转' : '❌ 结论：验证失败')
process.exit(pass ? 0 : 1)
