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
  /** 轮内压缩发生时为 true：最新一轮的旧工具输出已被替换为占位符。 */
  compressedInTurn?: boolean
  /** 当前被裁掉的轮次；调用方据此判断摘要缓存是否仍然覆盖。 */
  omittedMessages?: Message[]
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
  options: {
    system: string
    budgetTokens: number
    extraTokens?: number
    toolResultMaxChars?: number
    /** 轮间摘要：放在历史最前面的一条 user 消息，不计入原始轮次。 */
    summary?: string
  }
): BuiltContext {
  const turns = groupIntoTurns(path)
  const maxChars = options.toolResultMaxChars ?? DEFAULT_TOOL_RESULT_MAX_CHARS
  // 工具 schema 等"历史之外但必发"的开销也要占预算，否则名义 32000 实际早超
  const summaryTokens = options.summary ? estimateTokens(options.summary) + 8 : 0
  const systemTokens =
    estimateTokens(options.system) + (options.extraTokens ?? 0) + summaryTokens

  const kept: Message[][] = []
  let used = systemTokens

  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index]
    const turnTokens = estimateTurn(turn, maxChars)

    // 最新一轮无论如何都保留，否则模型会看不到用户刚说的话
    if (kept.length > 0 && used + turnTokens > options.budgetTokens) break

    used += turnTokens
    kept.unshift(turn)
  }

  // 最新一轮单独就可能超预算（许愿模式一轮 120 步）：
  // 超过预算 60% 就先压缩轮内旧的工具输出，而不是把整轮丢掉。
  // tool_use 与 tool_result 成对保留。
  let compressedInTurn = false
  if (kept.length === 1 && used > options.budgetTokens * 0.6) {
    const compressed = compressTurnToolResults(kept[0], maxChars)
    if (compressed.changed) {
      kept[0] = compressed.turn
      used = systemTokens + estimateTurn(kept[0], maxChars)
      compressedInTurn = true
    }
  }

  const messages = toLLMMessages(kept.flat())
  if (options.summary) {
    messages.unshift({
      role: 'user',
      blocks: [{ type: 'text', text: `【此前对话摘要】\n${options.summary}` }]
    })
  }

  return {
    messages,
    omittedTurns: turns.length - kept.length,
    estimatedTokens: used,
    compressedInTurn,
    omittedMessages: turns.slice(0, turns.length - kept.length).flat()
  }
}

/** 单轮 token 估算：先按单条输出上限截断，再累计。 */
function estimateTurn(turn: Message[], maxChars: number): number {
  return turn.reduce((sum, message) => {
    const blocks = message.blocks.map((b) =>
      b.type === 'tool_result' && b.content.length > maxChars
        ? { ...b, content: truncateToolResult(b.content, maxChars) }
        : b
    )
    return sum + estimateBlocks(blocks) + 8
  }, 0)
}

/**
 * 轮内压缩：保留最近 N 组 tool_use/tool_result 的完整输出，
 * 更早的 tool_result 只留 `[已省略旧工具输出：<工具名> <前200字符>…]`。
 *
 * 只改 tool_result 的 content，不删任何块——tool_use 与 tool_result 必须成对，
 * 删掉一侧会让 Anthropic / Responses 协议直接报错。
 */
export const KEEP_RECENT_TOOL_RESULTS = 6
export const TOOL_RESULT_PREVIEW_CHARS = 200

export function compressTurnToolResults(
  turn: Message[],
  maxChars = DEFAULT_TOOL_RESULT_MAX_CHARS,
  keepRecent = KEEP_RECENT_TOOL_RESULTS
): { turn: Message[]; changed: boolean } {
  // 工具名从对应的 tool_use 块取；同一轮里 tool_result 只按顺序编号
  const toolNames = new Map<string, string>()
  const resultOrder: { messageIndex: number; blockIndex: number; toolUseId: string }[] = []

  turn.forEach((message, messageIndex) => {
    message.blocks.forEach((block, blockIndex) => {
      if (block.type === 'tool_use') toolNames.set(block.id, block.name)
      if (block.type === 'tool_result') {
        resultOrder.push({ messageIndex, blockIndex, toolUseId: block.toolUseId })
      }
    })
  })

  if (resultOrder.length <= keepRecent) return { turn, changed: false }

  const replaceBefore = resultOrder.length - keepRecent
  const compressed: Message[] = turn.map((message) => ({ ...message, blocks: [...message.blocks] }))
  let changed = false

  for (let index = 0; index < replaceBefore; index++) {
    const { messageIndex, blockIndex, toolUseId } = resultOrder[index]
    const block = compressed[messageIndex].blocks[blockIndex]
    if (block.type !== 'tool_result') continue
    const preview = block.content.replace(/\s+/g, ' ').trim().slice(0, TOOL_RESULT_PREVIEW_CHARS)
    const name = toolNames.get(toolUseId) ?? 'tool'
    const placeholder = `[已省略旧工具输出：${name} ${preview}${block.content.length > TOOL_RESULT_PREVIEW_CHARS ? '…' : ''}]`
    if (placeholder.length >= block.content.length) continue
    compressed[messageIndex].blocks[blockIndex] = {
      ...block,
      content: placeholder,
      // 图片同样不再回传：旧截图对模型已无价值，保留会继续占预算
      image: undefined
    }
    changed = true
  }

  // maxChars 仍要生效：最近几组过长的输出照旧截断
  if (changed) {
    for (const message of compressed) {
      message.blocks = message.blocks.map((block) =>
        block.type === 'tool_result' && block.content.length > maxChars
          ? { ...block, content: truncateToolResult(block.content, maxChars) }
          : block
      )
    }
  }

  return { turn: compressed, changed }
}

/** 轮间摘要：被裁掉的轮次（从最旧开始数 omittedTurns 轮）。 */
export function turnsToSummarize(path: Message[], omittedTurns: number): Message[] {
  if (omittedTurns <= 0) return []
  const turns = groupIntoTurns(path)
  return turns.slice(0, omittedTurns).flat()
}

/**
 * 把被裁掉的轮次压成一段供模型做摘要的纯文本。
 * 工具输出只保留前 400 字符：摘要不需要完整日志，原文仍在 DB 里。
 */
export function buildSummaryTranscript(messages: Message[], maxChars = 12_000): string {
  const lines: string[] = []
  for (const message of messages) {
    const role = message.role === 'user' ? '用户' : message.role === 'assistant' ? '助手' : message.role
    const parts: string[] = []
    for (const block of message.blocks) {
      if (block.type === 'text' && block.text.trim()) parts.push(block.text.trim())
      else if (block.type === 'tool_use') parts.push(`[调用工具 ${block.name}]`)
      else if (block.type === 'tool_result') {
        const preview = block.content.replace(/\s+/g, ' ').trim().slice(0, 400)
        parts.push(`[工具结果] ${preview}${block.content.length > 400 ? '…' : ''}`)
      }
    }
    if (parts.length > 0) lines.push(`${role}：${parts.join(' / ')}`)
  }
  const text = lines.join('\n')
  return text.length > maxChars ? `${text.slice(0, maxChars)}\n…（更早内容已省略）` : text
}

/**
 * 缓存的摘要是否仍覆盖当前被裁掉的轮次。
 * 覆盖点必须恰好落在被裁轮次的最后一条消息上：会话继续增长后需要重新摘要。
 */
export function summaryCovers(
  path: Message[],
  coveredMessageId: string,
  omittedTurns: number
): boolean {
  if (omittedTurns <= 0) return false
  const omitted = turnsToSummarize(path, omittedTurns)
  return omitted.length > 0 && omitted[omitted.length - 1].id === coveredMessageId
}

/** 摘要正文按任务书要求压到 400 字以内。 */
export function clampSummary(text: string): string {
  const trimmed = text.trim()
  return trimmed.length > 400 ? trimmed.slice(0, 400) : trimmed
}
