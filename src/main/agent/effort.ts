/**
 * 思考强度真旋钮：把 UI 的 5 档映射到各家模型真正吃的 API 参数。
 *
 * - muse-spark（Responses 协议）：`reasoning: { effort }`，梯子
 *   minimal/low/medium/high/xhigh/max，用 `reasoning_effort` 会 400。
 * - DeepSeek V4（OpenAI 兼容 chat）：顶层 `reasoning_effort`，
 *   取值 none/low/high/max，官方兼容映射 minimal→low、medium→high。
 * - 其他模型：不发送未知参数（严格网关如 Ollama 会 400），
 *   只保留轻量提示词约束，行为与以前一致。
 */

export type EffortSetting = 'minimal' | 'low' | 'medium' | 'high' | 'max'

export interface ResolvedEffort {
  /** 传给 adapter 的原始值，各 adapter 按自家线制转发；undefined 表示不发送。 */
  reasoningEffort?: string
  /** 本轮单次请求的输出上限（含思考）。思考与正文共用该预算时必须留足。 */
  maxTokens: number
  /** 拼进 system 的轻量后缀（自带前导换行）。API 参数接管深度后不再限字数。 */
  hint: string
}

/** 单轮默认上限：沿用旧值，只用于未知模型。 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 8_192

export function isMuseSpark(model: string): boolean {
  return /muse/i.test(model)
}

export function isDeepSeek(model: string): boolean {
  return /deepseek/i.test(model)
}

export function isSenseNova(model: string): boolean {
  return /sensenova/i.test(model)
}

function normalizeEffort(effort: string): EffortSetting {
  if (effort === 'minimal' || effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'max') {
    return effort
  }
  return 'high'
}

export function resolveEffort(model: string, effort: string): ResolvedEffort {
  const level = normalizeEffort(effort)

  if (isMuseSpark(model)) {
    // Responses 输出上限 131K；思考最低需要 16K floor，32K 兼顾余量与上下文回传成本。
    return {
      reasoningEffort: level,
      maxTokens: 32_768,
      hint:
        level === 'minimal'
          ? '\n\n【极速】直接给核心结果。'
          : level === 'max'
            ? '\n\n【极限】推理深度已由 reasoning max 接管，直接给结论与工具调用。'
            : ''
    }
  }

  if (isDeepSeek(model)) {
    // 官方兼容映射：minimal→low、medium/high→high；思考模式服务端默认 64K 输出。
    const mapped = level === 'minimal' || level === 'low' ? 'low' : level === 'max' ? 'max' : 'high'
    return {
      reasoningEffort: mapped,
      maxTokens: 65_536,
      hint:
        level === 'minimal'
          ? '\n\n【极速】直接给核心结果。'
          : level === 'max'
            ? '\n\n【极限】推理深度已由 reasoning_effort=max 接管，直接给结论与工具调用。'
            : ''
    }
  }

  if (isSenseNova(model)) {
    // 日日新自家模型默认思考：reasoning 先出、content 在后，max_tokens 把思考也算进去，
    // 简单问答都要 ~450 tokens，小上限必撞 length。网关白名单接受 reasoning_effort，
    // 但官方未写明自家模型认哪些值：max 暂收敛到 high（错值会 400 且报错无意义）。
    const mapped = level === 'minimal' || level === 'low' ? 'low' : level === 'medium' ? 'medium' : 'high'
    return {
      reasoningEffort: mapped,
      maxTokens: 32_768,
      hint:
        level === 'minimal'
          ? '\n\n【极速】直接给核心结果。'
          : level === 'max' || level === 'high'
            ? '\n\n【极限】推理深度已由 reasoning_effort=high 接管，直接给结论与工具调用。'
            : ''
    }
  }

  // 未知模型：不发参数，只用提示词约束；max 保留字数上限防止思考吃光 8192。
  if (level === 'minimal') return { maxTokens: DEFAULT_MAX_OUTPUT_TOKENS, hint: '\n\n【极速】直接给核心结果，思考过程限100字内。' }
  if (level === 'low') return { maxTokens: DEFAULT_MAX_OUTPUT_TOKENS, hint: '\n\n【快速】给关键步骤，思考过程限200字内。' }
  if (level === 'medium') return { maxTokens: DEFAULT_MAX_OUTPUT_TOKENS, hint: '\n\n【标准】兼顾速度与质量。' }
  if (level === 'max') return { maxTokens: DEFAULT_MAX_OUTPUT_TOKENS, hint: '\n\n【深思】先给结论和工具调用，思考过程限300字内，不要长篇推导。' }
  return { maxTokens: DEFAULT_MAX_OUTPUT_TOKENS, hint: '\n\n【高】深度思考，先给结论。' }
}
