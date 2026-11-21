import type { CapacitorConfig } from '@capacitor/cli'

/**
 * 尚搏远程 Android 壳（Capacitor）：把 dist-mobile 原样装进原生 WebView。
 * - 本地资源加载，无 Service Worker 缓存烦恼，随 App 更新。
 * - 网络只走 wss:// 中转，与 PWA 同源策略一致（见 src/mobile/index.html CSP）。
 * - 配对仍扫桌面二维码：用 App 内「粘贴配对链接」一键解析，无需跳浏览器。
 */
const config: CapacitorConfig = {
  appId: 'com.shangbo.remote',
  appName: '尚搏远程',
  webDir: 'dist-mobile',
  android: {
    allowMixedContent: false
  }
}

export default config
