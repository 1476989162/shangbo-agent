import type { Message } from '@shared/types'
import type { BranchInfo } from '../stores/chat'

/**
 * 消息 parentId → 子消息索引。
 * ChatView 模板里每条消息都要算分支导航/有无回复，朴素写法是 O(N²) 线性扫描；
 * 这里一次建 Map，后续全是 O(1) 查表。key 仅含非空 parentId。
 */
export function buildChildrenByParentId(messages: Message[]): Map<string, Message[]> {
  const index = new Map<string, Message[]>()
  for (const message of messages) {
    if (!message.parentId) continue
    const list = index.get(message.parentId)
    if (list) list.push(message)
    else index.set(message.parentId, [message])
  }
  return index
}

/**
 * 某条助手消息的分支导航信息（同一用户消息下的多个助手回复按时间排序）。
 * 与旧版 store.messages.filter 语义一致：不足 2 个兄弟时返回 null。
 */
export function getBranchInfo(
  message: Message,
  childrenByParentId: Map<string, Message[]>
): BranchInfo | null {
  if (message.role !== 'assistant' || !message.parentId) return null
  const siblings = (childrenByParentId.get(message.parentId) ?? []).filter(
    (item) => item.role === 'assistant'
  )
  if (siblings.length < 2) return null
  const ordered = [...siblings].sort(
    (a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)
  )
  const position = ordered.findIndex((item) => item.id === message.id)
  if (position < 0) return null
  return {
    index: position + 1,
    total: ordered.length,
    prevId: position > 0 ? ordered[position - 1].id : null,
    nextId: position < ordered.length - 1 ? ordered[position + 1].id : null
  }
}

/**
 * 这条用户消息是否已有助手回复挂在下面。
 * 排队中的消息主进程尚未创建助手节点，用它区分「已发送、正在等回复」
 * 与「还在队列里没轮到」。
 */
export function hasAssistantReply(
  userMessageId: string,
  childrenByParentId: Map<string, Message[]>
): boolean {
  const children = childrenByParentId.get(userMessageId)
  if (!children) return false
  return children.some((item) => item.role === 'assistant')
}
