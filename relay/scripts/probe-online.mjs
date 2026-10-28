/**
 * 探测线上中转的准入状态（只读，不修改任何数据）。
 * 发一条 register-desktop，看它是否受理：
 * - 返回 roomId  → 线上仍开放（任何人可建房间）
 * - 返回错误      → 已加固
 */
import { WebSocket } from 'ws'

const URL = 'wss://www.lnbxsoft.com/sb-remote/'

function probe(payload, label) {
  return new Promise((resolve) => {
    const ws = new WebSocket(URL)
    const timer = setTimeout(() => {
      ws.terminate()
      resolve({ label, result: 'timeout' })
    }, 15000)
    ws.on('open', () => ws.send(JSON.stringify(payload)))
    ws.on('message', (d) => {
      clearTimeout(timer)
      try {
        const msg = JSON.parse(String(d))
        ws.close()
        resolve({ label, ok: msg.ok, error: msg.error, roomId: msg.data?.roomId })
      } catch {
        ws.close()
        resolve({ label, result: 'unparsable' })
      }
    })
    ws.on('error', (e) => {
      clearTimeout(timer)
      resolve({ label, result: 'error: ' + e.message })
    })
  })
}

const a = await probe({ op: 'register-desktop' }, '匿名注册（无任何身份）')
console.log('匿名注册        →', a.roomId ? `❌ 被受理，拿到 room ${a.roomId.slice(0, 8)}…` : `✅ 被拒 ${a.error ?? a.result}`)

const b = await probe({ op: 'register-desktop', accessKey: 'definitely-wrong' }, '错误准入密钥')
console.log('错误准入密钥    →', b.roomId ? `❌ 被受理（说明未设准入密钥）` : `✅ 被拒 ${b.error ?? b.result}`)

const c = await probe({ op: 'register-desktop', pubKey: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' }, '伪造身份公钥')
console.log('伪造身份公钥    →', c.roomId ? `❌ 被受理（说明未设白名单）` : `✅ 被拒 ${c.error ?? c.result}`)

console.log('')
const hardened = !a.roomId && !b.roomId && !c.roomId
console.log(hardened ? '✅ 线上已加固' : '❌ 线上仍是旧行为：任何人可注册建房间')
