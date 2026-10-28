/**
 * 验证线上准入密钥。密钥从环境变量读取，避免 shell 引号污染。
 * 用法：RELAY_KEY=xxx node relay/scripts/verify-access-key.mjs
 */
import { WebSocket } from 'ws'

const URL = 'wss://www.lnbxsoft.com/sb-remote/'
const KEY = (process.env.RELAY_KEY ?? '').trim()

if (!KEY) {
  console.error('请设置环境变量 RELAY_KEY')
  process.exit(1)
}
console.log(`密钥长度: ${KEY.length}（应为 40）`)

function register(payload) {
  return new Promise((resolve) => {
    const ws = new WebSocket(URL)
    const t = setTimeout(() => {
      ws.terminate()
      resolve({ result: 'timeout' })
    }, 15000)
    ws.on('open', () => ws.send(JSON.stringify(payload)))
    ws.on('message', (d) => {
      clearTimeout(t)
      try {
        const m = JSON.parse(String(d))
        ws.close()
        resolve({ ok: m.ok, error: m.error, roomId: m.data?.roomId })
      } catch {
        ws.close()
        resolve({ result: 'unparsable' })
      }
    })
    ws.on('error', (e) => {
      clearTimeout(t)
      resolve({ result: e.message })
    })
  })
}

const good = await register({ op: 'register-desktop', accessKey: KEY })
console.log('正确密钥 →', good.roomId ? `✅ 注册成功 room ${good.roomId.slice(0, 8)}…` : `❌ 被拒 ${good.error ?? good.result}`)

const bad = await register({ op: 'register-desktop', accessKey: KEY + 'x' })
console.log('错误密钥 →', bad.roomId ? `❌ 居然通过` : `✅ 被拒 ${bad.error ?? bad.result}`)

const none = await register({ op: 'register-desktop' })
console.log('无密钥   →', none.roomId ? `❌ 居然通过` : `✅ 被拒 ${none.error ?? none.result}`)

console.log('')
const pass = Boolean(good.roomId) && !bad.roomId && !none.roomId
console.log(pass ? '✅ 准入密钥工作正常：只有持有密钥的桌面能连' : '❌ 验证失败')
process.exit(pass ? 0 : 1)
