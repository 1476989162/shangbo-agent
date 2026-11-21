import type { ContentBlock } from '../../shared/types'
import type { LLMMessage } from '../providers/types'

/**
 * 记忆 Note 的运行时拼接（纯内存、无 DB / 无 IO）。
 *
 * 为什么要从 system 移出来：Anthropic / OpenAI 的 Prompt Cache 以「恒定前缀」为键，
 * 动态记忆（经验库、用户确认的背景、Wiki 索引）一旦拼进 system，任何一条新经验都会
 * 让缓存前缀整体失效。改成在运行时附加到首条 user 消息的文本块末尾后，system 与工具
 * 清单在跨轮次间保持恒定，缓存命中率不再被记忆更新击穿。
 *
 * 注意：这里只在内存里 clone 消息对象，绝不改写 DB 中的原始用户消息。
 */
export const MEMORY_CONTEXT_OPEN = '<memory_context>'
export const MEMORY_CONTEXT_CLOSE = '</memory_context>'

export interface WikiIndexEntry {
  id: string
  kind: string
  title: string
  updatedAt: number
}

/** 进程内 Wiki 索引缓存：由后台提取任务刷新，主路径永远不读磁盘。 */
let wikiIndexCache: WikiIndexEntry[] = []
let wikiIndexLoaded = false

export function setWikiIndex(entries: WikiIndexEntry[]): void {
  wikiIndexCache = [...entries].sort((a, b) => b.updatedAt - a.updatedAt)
  wikiIndexLoaded = true
}

export function getWikiIndex(): WikiIndexEntry[] {
  return wikiIndexCache
}

export function isWikiIndexLoaded(): boolean {
  return wikiIndexLoaded
}

export interface MemoryNoteParts {
  /** 用户在设置里确认过的长期背景 */
  coworkMemories?: string[]
  /** 已验证的经验库条目 */
  lessons?: string[]
  /** Wiki 实体页索引；不传时用进程内缓存 */
  wikiIndex?: WikiIndexEntry[]
  /** 注入上限，防止记忆膨胀把上下文吃光 */
  maxChars?: number
}

/** 组装 `<memory_context>` 块；没有任何内容时返回空串（不注入空标签）。 */
export function buildMemoryNote(parts: MemoryNoteParts = {}): string {
  const sections: string[] = []
  const maxChars = parts.maxChars ?? 4000

  const memories = (parts.coworkMemories ?? []).map((s) => s.trim()).filter(Boolean)
  if (memories.length > 0) {
    sections.push(`【长期记忆（用户已确认的背景，可作为默认前提）】\n${memories.slice(0, 8).map((s) => `- ${s}`).join('\n')}`)
  }

  const lessons = (parts.lessons ?? []).map((s) => s.trim()).filter(Boolean)
  if (lessons.length > 0) {
    sections.push(`【已验证的经验库（优先复用）】\n${lessons.slice(0, 12).map((s, i) => `${i + 1}. ${s}`).join('\n')}`)
  }

  const index = parts.wikiIndex ?? getWikiIndex()
  if (index.length > 0) {
    sections.push(
      `【Personal Wiki 索引（需要细节请调 wiki_search）】\n${index
        .slice(0, 12)
        .map((e) => `- [${e.kind}] ${e.title} (${e.id})`)
        .join('\n')}`
    )
  }

  if (sections.length === 0) return ''
  const body = sections.join('\n\n')
  return `${MEMORY_CONTEXT_OPEN}\n${body.length > maxChars ? `${body.slice(0, maxChars)}\n…（记忆已截断）` : body}\n${MEMORY_CONTEXT_CLOSE}`
}

/**
 * 把 Note 附加到首条 user 消息的文本块末尾（运行时 clone，幂等）。
 * 若首条 user 消息没有文本块（纯图片），则追加一个文本块。
 */
export function attachMemoryNote(messages: LLMMessage[], note: string): LLMMessage[] {
  if (!note) return messages
  const index = messages.findIndex((m) => m.role === 'user')
  if (index < 0) return messages
  const target = messages[index]
  if (target.blocks.some((b) => b.type === 'text' && b.text.includes(MEMORY_CONTEXT_OPEN))) {
    return messages
  }

  const blocks: ContentBlock[] = target.blocks.map((b) => ({ ...b }))
  const textIndex = blocks.findIndex((b) => b.type === 'text')
  if (textIndex >= 0) {
    const block = blocks[textIndex]
    if (block.type === 'text') {
      blocks[textIndex] = { ...block, text: `${block.text}\n\n${note}` }
    }
  } else {
    blocks.push({ type: 'text', text: note })
  }

  const next = messages.slice()
  next[index] = { ...target, blocks }
  return next
}
