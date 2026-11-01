<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useChatStore } from './stores/chat'
import { useViewerStore } from './stores/viewer'
import { applyThemeValue } from './lib/theme'
import { setLanguage, type SupportedLanguage } from './i18n'
import Sidebar from './components/Sidebar.vue'
import ChatView from './components/ChatView.vue'
import FileViewer from './components/FileViewer.vue'
import SettingsDialog from './components/SettingsDialog.vue'

type ThemeChoice = 'light' | 'dark' | 'system'

const store = useChatStore()
const viewer = useViewerStore()
const settingsOpen = ref(false)
const settingsInitialTab = ref('preferences')
const theme = ref<ThemeChoice>('system')
const viewerWidth = ref(460)
const isResizing = ref(false)

function openSettings(tab = 'preferences'): void {
  settingsInitialTab.value = tab
  settingsOpen.value = true
}

const media = window.matchMedia('(prefers-color-scheme: dark)')

function applyTheme(): void {
  const resolved = theme.value === 'system' ? (media.matches ? 'dark' : 'light') : theme.value
  applyThemeValue(resolved)
  void window.shangbo.app.setWindowTheme(resolved)
}

function onSystemThemeChange(): void {
  if (theme.value === 'system') applyTheme()
}

async function setTheme(value: ThemeChoice): Promise<void> {
  theme.value = value
  applyTheme()
  await window.shangbo.settings.set('app.theme', value)
}

function startResize(e: MouseEvent): void {
  isResizing.value = true
  const startX = e.clientX
  const startW = viewerWidth.value
  const onMouseMove = (ev: MouseEvent) => {
    const delta = startX - ev.clientX
    viewerWidth.value = Math.max(320, Math.min(820, startW + delta))
  }
  const onMouseUp = () => {
    isResizing.value = false
    window.removeEventListener('mousemove', onMouseMove)
    window.removeEventListener('mouseup', onMouseUp)
  }
  window.addEventListener('mousemove', onMouseMove)
  window.addEventListener('mouseup', onMouseUp)
}

onMounted(async () => {
  media.addEventListener('change', onSystemThemeChange)

  const settings = await window.shangbo.settings.getAll()
  const saved = settings['app.theme'] as ThemeChoice | undefined
  if (saved) theme.value = saved
  applyTheme()

  const lang = settings['ui.language'] as SupportedLanguage | undefined
  if (lang) setLanguage(lang)

  try {
    await store.bootstrap()
  } catch (error) {
    console.error('[app] 初始化失败', error)
  }
})

onBeforeUnmount(() => {
  media.removeEventListener('change', onSystemThemeChange)
  window.shangbo.chat.offEvent()
})
</script>

<template>
  <div
    class="app"
    :class="{
      'sidebar-collapsed': store.sidebarCollapsed,
      'viewer-open': viewer.open && !viewer.collapsed,
      'viewer-collapsed': viewer.open && viewer.collapsed,
      'is-resizing': isResizing
    }"
    :style="{ '--viewer-width': `${viewerWidth}px` }"
  >
    <Sidebar @open-settings="openSettings" />
    <ChatView @open-settings="openSettings" />
    <div
      v-if="viewer.open && !viewer.collapsed"
      class="viewer-resize-handle"
      title="拖拽调节工作台宽度"
      @mousedown.prevent="startResize"
    />
    <FileViewer v-if="viewer.open" />
    <SettingsDialog
      v-model:open="settingsOpen"
      :initial-tab="settingsInitialTab"
      :theme="theme"
      @update:theme="setTheme"
    />
  </div>
</template>

<style scoped>
.app {
  --viewer-width: 460px;
  display: grid;
  grid-template-columns: var(--sidebar-width) minmax(0, 1fr) 0px;
  height: 100vh;
  overflow: hidden;
  position: relative;
  transition: grid-template-columns 0.2s cubic-bezier(0.16, 1, 0.3, 1);
}

.app.is-resizing {
  transition: none;
  user-select: none;
}

.app.viewer-open {
  grid-template-columns: var(--sidebar-width) minmax(0, 1fr) var(--viewer-width);
}

.app.viewer-collapsed {
  grid-template-columns: var(--sidebar-width) minmax(0, 1fr) 40px;
}

.app.sidebar-collapsed {
  grid-template-columns: 0px minmax(0, 1fr) 0px;
}

.app.sidebar-collapsed.viewer-open {
  grid-template-columns: 0px minmax(0, 1fr) var(--viewer-width);
}

.app.sidebar-collapsed.viewer-collapsed {
  grid-template-columns: 0px minmax(0, 1fr) 40px;
}

.viewer-resize-handle {
  position: absolute;
  top: 0;
  bottom: 0;
  right: var(--viewer-width);
  width: 6px;
  cursor: col-resize;
  z-index: 50;
  transition: background-color 0.15s;
}

.viewer-resize-handle:hover,
.app.is-resizing .viewer-resize-handle {
  background-color: var(--accent, #b45309);
}
</style>