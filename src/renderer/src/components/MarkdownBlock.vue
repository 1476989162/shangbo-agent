<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { handleViewerLinkClick, highlighterReady, renderMarkdown } from '../lib/markdown'
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

/**
 * 高亮器异步就绪后，已渲染的代码块还是纯文本态——递增该 key 强制重渲染一次。
 * renderMarkdown 内部是幂等的，重复渲染只多一次 markdown-it + sanitize 开销。
 */
const refreshKey = ref(0)
watch(highlighterReady, (ready) => {
  if (ready) refreshKey.value++
})

const html = computed(() => {
  // 显式依赖：highlighterReady 翻转时 refreshKey 递增，触发重高亮。
  void refreshKey.value
  return renderMarkdown(props.source, {
    highlight: !props.streaming,
    dark: isDark.value
  })
})

function onClick(event: MouseEvent): void {
  const handled = handleViewerLinkClick(
    event,
    { openWeb: (url) => viewer.openWeb(url), openFile: (id, rel) => viewer.openFile(id, rel) },
    chat.activeConversationId,
    chat.activeConversation?.workingDir ?? null
  )
  if (handled) event.preventDefault()
}
</script>

<template>
  <div ref="root" class="markdown" v-html="html" @click="onClick" />
</template>
