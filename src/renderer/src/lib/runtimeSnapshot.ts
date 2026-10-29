import type { ContentBlock, ConversationRuntimeState } from '@shared/types'

/**
 * 会话切换后的运行态对账。
 *
 * 背景（这是一个真实 bug）：某会话在跑时新建/切到别的会话，再切回来，
 * 原会话就「没有进度」了。原因有三层：
 *  1. 渲染层切走后把后台会话的流式增量事件全丢弃了（只留「在跑」这个粗状态）；
 *  2. 流式正文在主进程只在工具批次边界落库，DB 里可能还是空块；
 *  3. 助手消息要等本轮结束才被指为 activeLeaf，切回时视图路径里根本没有它。
 * 所以只靠 `conversation.messages` 重建必然看不到内容，必须与主进程内存态对账。
 */

/** 取最后一个文本块的正文，用于判断两份块序列谁更完整。 */
export function tailText(blocks: ContentBlock[]): string {
  for (let index = blocks.length - 1; index >= 0; index--) {
    const block = blocks[index]
    if (block.type === 'text') return block.text
  }
  return ''
}

/**
 * 合并「主进程内存快照」与「渲染层本地块」。
 *
 * 快照是权威且完整的（截至生成时刻）；本地可能已经收到快照之后才到达的增量，
 * 表现为「本地文本 = 快照文本 + 更多内容」。此时保留本地，避免切换瞬间丢字。
 * 其余情况一律采用快照——本地更旧，甚至可能是上一个工具批次落库的残缺版本。
 */
export function mergeLiveBlocks(live: ContentBlock[], local: ContentBlock[]): ContentBlock[] {
  if (live.length === 0) return local
  if (local.length === 0) return live
  const liveText = tailText(live)
  const localText = tailText(local)
  if (liveText && localText.length > liveText.length && localText.startsWith(liveText)) {
    return local
  }
  return live
}

/**
 * 切回会话后，是否应把视图推进到这条仍在流式输出的助手消息。
 *
 * 只有当前叶子正好是它的父消息时才推进：用户在生成期间手动切到别的分支的话，
 * 不能因为「后台在跑」就把他的选择拽回来（与主进程对 activeLeaf 的保护同语义）。
 */
export function shouldAdoptStreamingLeaf(
  state: Pick<ConversationRuntimeState, 'streamingMessageId'>,
  localLeafId: string | null,
  streamingParentId: string | null | undefined
): boolean {
  if (!state.streamingMessageId) return false
  if (!streamingParentId) return false
  return localLeafId === streamingParentId
}
