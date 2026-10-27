/**
 * 把桌面中转地址转换成手机可直接打开的 PWA 配对链接。
 *
 * 中转与 PWA 默认同源托管，因此 wss://host/path/ 对应 https://host/path/。
 * 配对码和桌面公钥都放在 URL 参数中，手机扫码后即可自动预填。
 */
export function buildPairingUrl(
  relayUrl: string,
  code: string,
  desktopPublicKey: string,
  fingerprint: string,
  phoneName = ''
): string {
  const url = new URL(relayUrl)
  if (url.protocol !== 'wss:') throw new Error('中转地址必须为 wss://')
  url.protocol = 'https:'
  url.search = ''
  url.hash = ''
  url.searchParams.set('v', '1')
  url.searchParams.set('relay', relayUrl)
  url.searchParams.set('code', code)
  url.searchParams.set('pub', desktopPublicKey)
  url.searchParams.set('fp', fingerprint)
  if (phoneName) url.searchParams.set('name', phoneName)
  return url.toString()
}
