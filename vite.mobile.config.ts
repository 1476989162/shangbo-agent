import { resolve } from 'node:path'
import { defineConfig } from 'vite'

// 手机 PWA 独立构建（不进 Electron）：部署到用户云服务器，手机浏览器打开即可。
// 构建产物为纯静态文件，可直接由 Caddy/Nginx 托管（与中转同机或分开均可）。
export default defineConfig({
  root: resolve(__dirname, 'src/mobile'),
  base: './',
  publicDir: resolve(__dirname, 'src/mobile/public'),
  resolve: {
    alias: {
      '@shared': resolve('src/shared')
    }
  },
  build: {
    outDir: resolve('dist-mobile'),
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve('src/mobile/index.html')
      }
    }
  },
  server: {
    port: 5174
  }
})
