import { ref } from 'vue'

/**
 * 当前是否为深色主题。
 * 单独抽成模块级响应式值，是因为 Markdown 里的代码高亮需要在主题切换时重新渲染；
 * 直接读 document.documentElement.dataset.theme 不会触发 Vue 的依赖追踪。
 */
export const isDark = ref(false)

export function applyThemeValue(resolved: 'light' | 'dark'): void {
  document.documentElement.dataset.theme = resolved
  isDark.value = resolved === 'dark'
}