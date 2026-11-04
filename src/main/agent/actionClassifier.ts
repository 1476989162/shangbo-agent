import { streamWithFallback } from '../providers/gateway'
import { resolveTarget } from './modelRuntime'
import type { SafetyVerdict } from './safety'

/**
 * LLM 后台动作分类器（对标 Claude Desktop auto 模式的后台复核）。
 *
 * 分两档，简单优先：
 * 1. fastClassify 纯规则、零成本：read/auto 直接放，blocked/hard 沿用 safety，
 *    删除动词、外部跳板一律落回确认；
 * 2. 需要语义判断时才调 LLM（默认关闭，由 `agent.safety.actionClassifierLlm` 开启），
 *    失败一律按 ask 处理（fail-closed），绝不因分类器故障而自动放行。
 */

export type ActionDecision = 'allow' | 'ask' | 'block'

export interface ActionReview {
  decision: ActionDecision
  reason: string
  via: 'rule' | 'llm'
}

/** 快速通道：不需要 LLM 也能判的直接出结果，需要语义时返回 null 让调用方决定是否调 LLM。 */
export function fastClassifyAction(verdict: SafetyVerdict, command?: string): ActionReview | null {
  if (verdict.tier === 'blocked') return { decision: 'block', reason: verdict.reason ?? '命中安全红线。', via: 'rule' }
  if (verdict.tier === 'hard') return { decision: 'ask', reason: verdict.reason ?? '硬红线需人工确认。', via: 'rule' }
  // 删除永不免审批的纵深兜底（与 safety.isAutoAllowed 呼应）。
  if (command && /\b(?:rm|rmdir|rd|del|erase|remove-item|ri|unlink|shred)\b/i.test(command)) {
    return { decision: 'ask', reason: '删除类操作即使判定可放行也需人工确认。', via: 'rule' }
  }
  if (verdict.tier === 'auto') return { decision: 'allow', reason: verdict.reason ?? '工作区内安全操作。', via: 'rule' }
  // soft 且不可自动放行：规则上必须问，LLM 也只能在 ask/block 之间收紧，不能放宽为 allow。
  return null
}

const MAX_INPUT_CHARS = 1000

export function buildActionPrompt(
  toolName: string,
  input: unknown,
  verdict: SafetyVerdict
): { system: string; user: string } {
  const raw = JSON.stringify(input ?? {}).slice(0, MAX_INPUT_CHARS)
  return {
    system: '你是安全复核器。只看动作本身是否安全，不猜用户意图。只能回 JSON：{"decision":"ask"|"block","reason":"一句话"}。允许放行时回 {"decision":"allow","reason":"一句话"}，但删除、格式化、密钥外发、凭据上传一律不许 allow。',
    user: `工具：${toolName}\n分级：${verdict.tier}/${verdict.category} ${verdict.reason ?? ''}\n参数：${raw}`
  }
}

/** 解析 LLM 输出：只认 JSON 里的 decision，非法一律按 ask 处理。 */
export function parseActionLlmOutput(text: string): ActionReview {
  const fallback: ActionReview = { decision: 'ask', reason: '分类器输出无法解析，默认要问。', via: 'llm' }
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end <= start) return fallback
  try {
    const parsed = JSON.parse(text.slice(start, end + 1)) as { decision?: unknown; reason?: unknown }
    if (parsed.decision === 'allow' || parsed.decision === 'ask' || parsed.decision === 'block') {
      // LLM 不许把 safety 已判 blocked/hard 的放宽为 allow，调用方会再兜底；这里只做格式校验。
      const reason = typeof parsed.reason === 'string' && parsed.reason.trim()
        ? parsed.reason.trim().slice(0, 200)
        : 'LLM 复核结论。'
      return { decision: parsed.decision, reason, via: 'llm' }
    }
    return fallback
  } catch {
    return fallback
  }
}

type StreamFn = typeof streamWithFallback

/** 调 LLM 做一次复核；失败/超时一律返回 ask，绝不自动放行。 */
export async function runActionClassifierLlm(
  toolName: string,
  input: unknown,
  verdict: SafetyVerdict,
  opts: { providerId?: string | null; signal: AbortSignal; stream?: StreamFn; firstByteTimeoutMs?: number }
): Promise<ActionReview> {
  const { system, user } = buildActionPrompt(toolName, input, verdict)
  try {
    const stream = opts.stream ?? streamWithFallback
    let text = ''
    const model = resolveTarget(opts.providerId ?? null, null).model
    for await (const chunk of stream(
      { model, system, messages: [{ role: 'user', blocks: [{ type: 'text', text: user }] }], maxTokens: 200 },
      opts.signal,
      opts.providerId ?? undefined,
      opts.firstByteTimeoutMs !== undefined ? { firstByteTimeoutMs: opts.firstByteTimeoutMs } : undefined
    )) {
      if (chunk.type === 'text') text += chunk.text
    }
    const parsed = parseActionLlmOutput(text)
    // 纵深兜底：LLM 不许放宽 safety 的 hard/blocked。
    if (verdict.tier === 'blocked') return { decision: 'block', reason: verdict.reason ?? parsed.reason, via: 'llm' }
    if (verdict.tier === 'hard' && parsed.decision === 'allow') {
      return { decision: 'ask', reason: verdict.reason ?? parsed.reason, via: 'llm' }
    }
    return parsed
  } catch (error) {
    return { decision: 'ask', reason: `后台复核失败，默认要问：${error instanceof Error ? error.message : String(error)}`, via: 'llm' }
  }
}
