import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@main': resolve(__dirname, 'src/main'),
      '@renderer': resolve(__dirname, 'src/renderer/src')
    }
  },
  test: {
    include: ['src/**/*.test.ts'],
    // Windows 上 vitest 5 一次性拉起 74 个 worker 时，runner 会在 describe 阶段
    // 报 "Cannot read properties of undefined (reading 'config')"（并非用例失败）。
    // 固定并发上限后，文档里的 `npx vitest run` 验收命令可原样稳定跑全绿。
    maxWorkers: 4
  }
})
