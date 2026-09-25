<script setup lang="ts">
import { computed } from 'vue'
import { renderMarkdown } from '../lib/markdown'
import { isDark } from '../lib/theme'

const props = defineProps<{
  source: string
  /** 流式过程中关闭语法高亮：每个增量都重新高亮代价过高。 */
  streaming?: boolean
}>()

const html = computed(() =>
  renderMarkdown(props.source, {
    highlight: !props.streaming,
    dark: isDark.value
  })
)
</script>

<template>
  <div class="markdown" v-html="html" />
</template>