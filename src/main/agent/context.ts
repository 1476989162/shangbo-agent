import type { ContentBlock, Message } from '../../shared/types'
import type { LLMMessage } from '../providers/types'

/**
 * 粗粒度 token 估算：中日韩字符约 1 字 1 token，其余按 4 字符 1 token。
 * 这里不需要精确——它的用途是决定"何时开始裁剪上下文"，误差 20% 无影响。
 */
export function estimateTokens(text: string): number {
  let cjk = 0
  let other = 0
  for (const ch of text) {
    if ((ch.codePointAt(0) ?? 0) > 0x2e80) cjk++
    else other++
  }
  return Math.ceil(cjk + other / 4)
}

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
        total += estimateTokens(block.content) + 12
        break
      case 'image':
        // 图片按固定值粗估，模型侧实际开销远高于文本
        total += 800
        break
    }
  }
  return total
}

/**
 * 按"轮"分组：一轮从 user 消息开始，到下一个 user 消息之前结束。
 * 裁剪上下文必须以轮为单位——否则会出现 assistant 的 tool_use 还在、
 * 对应的 tool_result 被裁掉的非法序列，模型会直接报错。
 */
export function groupIntoTurns(messages: Message[]): Message[][] {
  const turns: Message[][] = []
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

export function buildContext(
  path: Message[],
  options: { system: string; budgetTokens: number }
): BuiltContext {
  const turns = groupIntoTurns(path)
  const systemTokens = estimateTokens(options.system)

  const kept: Message[][] = []
  let used = systemTokens

  for (let index = turns.length - 1; index >= 0; index--) {
    const turn = turns[index]
    const turnTokens = turn.reduce((sum, message) => sum + estimateBlocks(message.blocks) + 8, 0)

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