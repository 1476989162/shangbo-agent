import http from 'node:http'

/** 固定本机 CDP 端点；不接受渲染层传入 URL，避免把浏览器探测变成通用代理。 */
export const CHROME_DEBUG_VERSION_URL = 'http://127.0.0.1:9222/json/version'
const MAX_PROBE_BYTES = 16 * 1024

export function probeChromeDebugging(): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    let request: http.ClientRequest | undefined
    const finish = (connected: boolean): void => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      request?.destroy()
      resolve(connected)
    }
    request = http.get(CHROME_DEBUG_VERSION_URL, {
      timeout: 1500,
      headers: { Accept: 'application/json', Connection: 'close' }
    }, (response) => {
      if (response.statusCode !== 200) {
        response.resume()
        finish(false)
        return
      }
      let bytes = 0
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk: string) => {
        bytes += Buffer.byteLength(chunk)
        if (bytes > MAX_PROBE_BYTES) {
          finish(false)
          return
        }
        body += chunk
      })
      response.on('end', () => {
        try {
          const parsed = JSON.parse(body) as { Browser?: unknown }
          finish(typeof parsed.Browser === 'string' && parsed.Browser.length > 0)
        } catch {
          finish(false)
        }
      })
      response.on('error', () => finish(false))
    })
    timer = setTimeout(() => finish(false), 2000)
    request.on('timeout', () => finish(false))
    request.on('error', () => finish(false))
  })
}
