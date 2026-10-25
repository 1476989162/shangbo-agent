import type { ContentBlock, Message } from '../../shared/types'
import type { LLMMessage } from '../providers/types'
import { hydrateImages } from '../storage/images'

/**
 * 粗粒度 token 估算：中日韩字符约 1 字 1 token，其余按 4 字符 1 token。
 * 这里不需要精确——它的用途是决定"何时开始裁剪上下文"，误差 20% 无影响。
 */

/** CJK 统一表意（含扩展 A）、假名、谚文、兼容表意：按 1 字 1 token 计。 */
export const CJK_RANGES: [number, number][] = [
  [0x3040, 0x30ff], // 平假名/片假名
  [0x3400, 0x4dbf], // CJK 扩展 A
  [0x4e00, 0x9fff], // CJK 统一表意
  [0xac00, 0xd7af], // 谚文音节
  [0xf900, 0xfaff] // CJK 兼容表意
]

export function isCjk(codePoint: number): boolean {
  return CJK_RANGES.some(([lo, hi]) => codePoint >= lo && codePoint <= hi)
}

export function estimateTokens(text: string): number {
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if (isCjk(ch.codePointAt(0) ?? 0)) cjk++
    else other++
  }
  return Math.ceil(cjk + other / 4)
}

/** 单张图片的本地估算 token 数：截图实际开销常在 765-1500，按 1200 估并留余量。 */
export const IMAGE_TOKEN_ESTIMATE = 1200

export function estimateBlocks(blocks: ContentBlock[]): number {
  let total = 0
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
      case 'reasoning':
        total += estimateTokens(block.text)
        break
      case 'tool_use':
        total += estimateTokens(JSON.stringify(block.input ?? {})) + 24
        break
      case 'tool_result':
        total += estimateTokens(block.content) + 12 + (block.image ? IMAGE_TOKEN_ESTIMATE : 0)
        break
      case 'image':
        // 图片按固定值粗估，模型侧实际开销远高于文本
        total += IMAGE_TOKEN_ESTIMATE
        break
    }
  }
  return total
}

/**
 * 单条 tool_result 计入预算前的最大字符数：超长输出先截断再计，避免一条日志
 * 吞掉整轮预算。保留头尾各一半并注明省略字符数，模型需要时可再调工具分页读。
 */
export const DEFAULT_TOOL_RESULT_MAX_CHARS = 4000

export function truncateToolResult(content: string, maxChars = DEFAULT_TOOL_RESULT_MAX_CHARS): string {
  if (content.length <= maxChars) return content
  const half = Math.floor(maxChars / 2)
  const omitted = content.length - maxChars
  return `${content.slice(0, half)}\n…（工具输出过长，已截断前 ${half} + 后 ${maxChars - half} 字符，共省略 ${omitted} 字符）\n${content.slice(content.length - (maxChars - half))}`
}

/**
 * 按"轮"分组：一轮从 user 消息开始，到下一个 user 消息之前结束。
 * 裁剪上下文必须以轮为单位——否则会出现 assistant 的 tool_use 还在、
 * 对应的 tool_result 被裁掉的非法序列，模型会直接报错。
 */
export function groupIntoTurns(messages: Message[]): Message[][] {  const turns: Message[][] = []
  let current: Message[] | null = null

  for (const message of messages) {
    if (message.role === 'user' || current === null) {
      current = []
      turns.push(current)
    }
    current.push(message)
  }

  return turns
}

/**
 * 领域消息 → 厂商无关消息。
 * 一条持久化的助手消息内部混合了 text / tool_use / tool_result 块，
 * 这里按块类型拆回 assistant 与 tool 两种角色，保证回传历史时协议合法。
 * 另外会剔除 reasoning 块：思考内容不应回传给模型。
 */
export function toLLMMessages(messages: Message[]): LLMMessage[] {
  const out: LLMMessage[] = []

  for (const message of messages) {
    if (message.role !== 'assistant') {
      const blocks = message.blocks.filter((b) => b.type !== 'reasoning')
      if (blocks.length > 0) out.push({ role: message.role, blocks })
      continue
    }

    let current: LLMMessage | null = null
    for (const block of message.blocks) {
      if (block.type === 'reasoning') continue
      const role: 'assistant' | 'tool' = block.type === 'tool_result' ? 'tool' : 'assistant'
      if (!current || current.role !== role) {
        current = { role, blocks: [] }
        out.push(current)
      }
      current.blocks.push(block)
    }
  }

  return out
}

export interface BuiltContext {
  messages: LLMMessage[]
  omittedTurns: number
  estimatedTokens: number
}

/**
 * 把落盘的图片补成 base64，仅在即将发往模型时调用。
 *
 * 刻意与 buildContext 分开：buildContext 是同步的纯函数，只按 token 预算
 * 做块级裁剪，完全不碰磁盘；水合必须发生在裁剪之后，这样被裁掉的历史轮次
 * 里的图片永远不会被读进内存。
 */
export async function hydrateContextImages(context: BuiltContext): Promise<BuiltContext> {
  for (const message of context.messages) {
    await hydrateImages(message.blocks)
  }
  return context
}

export function buildContext(
  path: Message[],
  options: { system: string; budgetTokens: number; extraTokens?: number; toolResultMaxChars?: number }
): BuiltContext {
  const turns = groupIntoTurns(path)
  const maxChars = options.toolResultMaxChars ?? DEFAULT_TOOL_RESULT_MAX_CHARS
  // 工具 schema 等"历史之外但必发"的开销也要占预算，否则名义 32000 实际早超
  const systemTokens = estimateTokens(options.system) + (options.extraTokens ?? 0)

  const kept: Message[][] = []
  let used = systemTokens

  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index]
    const turnTokens = turn.reduce((sum, message) => {
      const blocks = message.blocks.map((b) =>
        b.type === 'tool_result' && b.content.length > maxChars
          ? { ...b, content: truncateToolResult(b.content, maxChars) }
          : b
      )
      return sum + estimateBlocks(blocks) + 8
    }, 0)

    // 最新一轮无论如何都保留，否则模型会看不到用户刚说的话
    if (kept.length > 0 && used + turnTokens > options.budgetTokens) break

    used += turnTokens
    kept.unshift(turn)
  }

  return {
    messages: toLLMMessages(kept.flat()),
    omittedTurns: turns.length - kept.length,
    estimatedTokens: used
  }
}