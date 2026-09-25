<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { useChatStore } from './stores/chat'
import { applyThemeValue } from './lib/theme'
import Sidebar from './components/Sidebar.vue'
import ChatView from './components/ChatView.vue'
import SettingsDialog from './components/SettingsDialog.vue'

type ThemeChoice = 'light' | 'dark' | 'system'

const store = useChatStore()
const settingsOpen = ref(false)
const settingsInitialTab = ref('preferences')
const theme = ref<ThemeChoice>('system')

function openSettings(tab = 'preferences'): void {
  settingsInitialTab.value = tab
  settingsOpen.value = true
}

const media = window.matchMedia('(prefers-color-scheme: dark)')

function applyTheme(): void {
  const resolved = theme.value === 'system' ? (media.matches ? 'dark' : 'light') : theme.value
  applyThemeValue(resolved)
}

function onSystemThemeChange(): void {
  if (theme.value === 'system') applyTheme()
}

async function setTheme(value: ThemeChoice): Promise<void> {
  theme.value = value
  applyTheme()
  await window.shangbo.settings.set('app.theme', value)
}

onMounted(async () => {
  media.addEventListener('change', onSystemThemeChange)

  const settings = await window.shangbo.settings.getAll()
  const saved = settings['app.theme'] as ThemeChoice | undefined
  if (saved) theme.value = saved
  applyTheme()

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
  <div class="app" :class="{ 'sidebar-collapsed': store.sidebarCollapsed }">
    <Sidebar @open-settings="openSettings" />
    <ChatView @open-settings="openSettings" />
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
  display: grid;
  grid-template-columns: var(--sidebar-width) minmax(0, 1fr);
  height: 100vh;
  overflow: hidden;
  transition: grid-template-columns 0.2s cubic-bezier(0.16, 1, 0.3, 1);
}

.app.sidebar-collapsed {
  grid-template-columns: 0px minmax(0, 1fr);
}
</style>