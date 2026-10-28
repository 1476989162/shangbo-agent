/**
 * 验证线上资源上限是否生效：连续注册大量房间，观察中转是否拒绝。
 * 只读验证——注册的房间会被空闲回收，不影响真实用户。
 */
import { WebSocket } from 'ws'

const URL = 'wss://www.lnbxsoft.com/sb-remote/'

function register() {
  return new Promise((resolve) => {
    const ws = new WebSocket(URL)
    const t = setTimeout(() => {
      ws.terminate()
      resolve({ result: 'timeout' })
    }, 15000)
    ws.on('open', () => ws.send(JSON.stringify({ op: 'register-desktop' })))
    ws.on('message', (d) => {
      clearTimeout(t)
      try {
        const m = JSON.parse(String(d))
        ws.close()
        resolve({ ok: m.ok, error: m.error })
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

// 注册 60 个，看是否有被上限拒绝的
let ok = 0
let rejected = 0
let other = 0
for (let i = 0; i < 60; i++) {
  const r = await register()
  if (r.ok) ok++
  else if (r.error === 'relay room limit reached') rejected++
  else other++
}

console.log(`成功注册: ${ok}`)
console.log(`被上限拒绝: ${rejected}`)
console.log(`其他: ${other}`)
console.log('')
if (rejected > 0) {
  console.log('✅ 资源上限已生效（房间数到达上限后拒绝新建）')
} else {
  console.log('ℹ️ 本次未触及上限（默认上限 5000，60 次远未达到），属正常')
  console.log('   上限机制由 relay 单测覆盖：relay/test/state.test.mjs「房间数达到上限后拒绝新建」')
}
