<script setup lang="ts">
import { computed, ref } from 'vue'
import { handleViewerLinkClick, renderMarkdown } from '../lib/markdown'
import { isDark } from '../lib/theme'
import { useChatStore } from '../stores/chat'
import { useViewerStore } from '../stores/viewer'

const props = defineProps<{
  source: string
  /** 流式过程中关闭语法高亮：每个增量都重新高亮代价过高。 */
  streaming?: boolean
}>()

const chat = useChatStore()
const viewer = useViewerStore()
const root = ref<HTMLElement | null>(null)

const html = computed(() =>
  renderMarkdown(props.source, {
    highlight: !props.streaming,
    dark: isDark.value
  })
)

function onClick(event: MouseEvent): void {
  const handled = handleViewerLinkClick(
    event,
    { openWeb: (url) => viewer.openWeb(url), openFile: (id, rel) => viewer.openFile(id, rel) },
    chat.activeConversationId
  )
  if (handled) event.preventDefault()
}
</script>

<template>
  <div ref="root" class="markdown" v-html="html" @click="onClick" />
</template>