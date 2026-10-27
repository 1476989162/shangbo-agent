import type { ContentBlock } from '../../shared/types'
import { routingOrder } from '../providers/store'
import { DEFAULT_MAX_OUTPUT_TOKENS } from './effort'

/** 思考过程只用于界面展示，不回传模型；封顶避免超长思考撑爆落库与界面。 */
const MAX_REASONING_CHARS = 8_000
/** 上轮思考耗尽预算后的续写指令：本轮不再思考，直接输出。 */
export const SKIP_THINKING_SUFFIX =
  '\n\n（上轮思考过长被截断：本轮不要再思考，直接输出正文或工具调用。）'
export const BUDGET_KEY = 'agent.contextBudgetTokens'
export const DEFAULT_BUDGET_TOKENS = 32_000
export const MAX_OUTPUT_TOKENS = DEFAULT_MAX_OUTPUT_TOKENS

export const DEFAULT_SYSTEM_PROMPT = `你是「尚搏 Agent」，运行在用户本机的个人助理，用中文回答，先给结论。

硬规则：
- 先读再改：改现有文件前先 read_file，优先 patch_file 局部改，一次只写一个文件。
- 先找再翻：定位文件/代码优先 search_files，不要逐层 list_directory。
- 不猜不重复：缺信息就调工具；用户拒绝的操作不再试同一种。`

export function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 合并相邻的同类块，使流式增量落库后仍是一段完整文本而不是上千个碎片。 */
export function appendBlock(blocks: ContentBlock[], block: ContentBlock): void {
  const last = blocks[blocks.length - 1]
  if (block.type === 'text' && last?.type === 'text') {
    last.text += block.text
    return
  }
  if (block.type === 'reasoning' && last?.type === 'reasoning') {
    if (last.text.length >= MAX_REASONING_CHARS) return
    const merged = last.text + block.text
    last.text =
      merged.length > MAX_REASONING_CHARS
        ? `${merged.slice(0, MAX_REASONING_CHARS)}…（思考过长，显示已截断）`
        : merged
    return
  }
  blocks.push(block)
}

/**
 * 流式增量归一化。
 *
 * 除了标准“真增量”网关，还有一些兼容网关会把累计全文当 delta 重发；
 * 如果直接 append，就会出现“结论：是结论：是我的问题…”这种结巴。
 * 该函数把累计快照转成真实新增后缀，并保留正常重复字词。
 */
export function normalizeIncomingDelta(
  incoming: string,
  previous: string
): { delta: string; snapshot: string } {
  if (!incoming) return { delta: '', snapshot: previous }
  if (!previous) return { delta: incoming, snapshot: incoming }
  if (incoming === previous) return { delta: '', snapshot: previous }
  if (incoming.startsWith(previous)) {
    return { delta: incoming.slice(previous.length), snapshot: incoming }
  }
  return { delta: incoming, snapshot: previous + incoming }
}

export function resolveTarget(
  preferredProviderId: string | null | undefined,
  preferredModel: string | null | undefined
): { providerId: string; model: string; providerName: string } {
  const order = routingOrder(preferredProviderId)
  if (order.length === 0) {
    throw new Error('没有可用的模型供应商：请到「设置 → 模型供应商」填入 API Key 并启用。')
  }
  const provider = order[0]
  const model = preferredModel?.trim() || provider.models[0]
  if (!model) {
    throw new Error(`供应商「${provider.name}」还没有配置模型名，请在设置中补充或点击「拉取模型列表」。`)
  }
  return { providerId: provider.id, model, providerName: provider.name }
}
