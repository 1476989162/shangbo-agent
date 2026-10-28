// 离线壳：缓存应用外壳，业务数据不缓存（永远走网络，保证审批实时性）。
const CACHE = 'shangbo-remote-v3'
// 版本化 JS 不在安装时预缓存；改为首次请求时缓存，升级后不会继续命中旧配对逻辑。
const SHELL = ['./', './index.html', './manifest.webmanifest']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  )
})

self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url)
  // 只缓存同源 GET 外壳；API/中转一律走网络
  if (event.request.method !== 'GET' || url.origin !== self.location.origin) return
  event.respondWith(
    caches.match(event.request).then((hit) => {
      if (hit) return hit
      return fetch(event.request).then((response) => {
        if (response.ok) {
          const copy = response.clone()
          void caches.open(CACHE).then((cache) => cache.put(event.request, copy))
        }
        return response
      })
    })
  )
})

// Web Push 底座（二期）：收到推送即显示审批提醒，由手机锁屏唤起
self.addEventListener('push', (event) => {
  let title = '尚搏远程'
  let body = '有新的待审批'
  try {
    const data = event.data?.json() ?? {}
    if (data.title) title = String(data.title)
    if (data.body) body = String(data.body)
  } catch {}
  event.waitUntil(self.registration.showNotification(title, { body }))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  event.waitUntil(self.clients.openWindow('./'))
})
