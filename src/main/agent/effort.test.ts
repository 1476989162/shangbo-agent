import { describe, expect, it } from 'vitest'
import { isDeepSeek, isMuseSpark, isOpenAIReasoning, isSenseNova, resolveEffort } from './effort'

describe('思考强度真旋钮 (resolveEffort)', () => {
  it('muse-spark 走 Responses 线制，档位直通', () => {
    expect(resolveEffort('muse-spark-1.3', 'max')).toMatchObject({ reasoningEffort: 'max' })
    expect(resolveEffort('muse-spark-1.3', 'medium')).toMatchObject({ reasoningEffort: 'medium' })
    expect(resolveEffort('muse-spark-1.3', 'minimal')).toMatchObject({ reasoningEffort: 'minimal' })
    // 输出上限必须远大于 8192，否则思考与正文抢预算
    expect(resolveEffort('muse-spark-1.3', 'max').maxTokens).toBeGreaterThan(8192)
  })

  it('DeepSeek 按官方兼容映射到 none/low/high/max', () => {
    expect(resolveEffort('deepseek-flash', 'minimal').reasoningEffort).toBe('low')
    expect(resolveEffort('deepseek-flash', 'low').reasoningEffort).toBe('low')
    expect(resolveEffort('deepseek-flash', 'medium').reasoningEffort).toBe('high')
    expect(resolveEffort('deepseek-flash', 'high').reasoningEffort).toBe('high')
    expect(resolveEffort('deepseek-v4-pro', 'max').reasoningEffort).toBe('max')
    expect(resolveEffort('deepseek-flash', 'high').maxTokens).toBeGreaterThan(8192)
  })

  it('sensenova 自家模型：上限远大于 8192，max 收敛到 high', () => {
    expect(resolveEffort('sensenova-6.8-flash-lite', 'minimal').reasoningEffort).toBe('low')
    expect(resolveEffort('sensenova-6.8-flash-lite', 'medium').reasoningEffort).toBe('medium')
    expect(resolveEffort('sensenova-6.8-flash-lite', 'high').reasoningEffort).toBe('high')
    expect(resolveEffort('sensenova-6.8-flash-lite', 'max').reasoningEffort).toBe('high')
    expect(resolveEffort('sensenova-6.8-flash-lite', 'max').maxTokens).toBeGreaterThan(8192)
    expect(isSenseNova('SenseNova-6.8-Flash-Lite')).toBe(true)
  })

  it('未知模型不发送参数，保持旧上限与提示词约束', () => {
    const res = resolveEffort('qwen-plus', 'max')
    expect(res.reasoningEffort).toBeUndefined()
    expect(res.maxTokens).toBe(8192)
    expect(res.hint).toContain('300字')
  })

  it('支持 OpenAI 系列思考模型 (o1, o3, o4, gpt-5)', () => {
    expect(resolveEffort('o1-preview', 'minimal').reasoningEffort).toBe('low')
    expect(resolveEffort('o3-mini', 'medium').reasoningEffort).toBe('medium')
    expect(resolveEffort('o4-preview', 'max').reasoningEffort).toBe('high')
    expect(resolveEffort('gpt-5', 'high').reasoningEffort).toBe('high')
    expect(resolveEffort('o3-mini', 'high').maxTokens).toBe(65536)
  })

  it('Claude / Qwen / Gemini 系列不下发 reasoningEffort（适配器不消费，禁止虚假配置），只保留 maxTokens 与提示', () => {
    // Claude 思考需要 thinking+budget_tokens 形态，Qwen/Gemini 走各自兼容字段，
    // 未经网关验证不虚构参数：reasoningEffort 必须为 undefined
    expect(resolveEffort('claude-3-7-sonnet-20250219', 'minimal').reasoningEffort).toBeUndefined()
    expect(resolveEffort('claude-3-7-sonnet-20250219', 'max').reasoningEffort).toBeUndefined()
    expect(resolveEffort('claude-sonnet-4', 'high').reasoningEffort).toBeUndefined()
    expect(resolveEffort('claude-sonnet-4', 'high').maxTokens).toBe(64000)
    expect(resolveEffort('qwq-32b', 'minimal').reasoningEffort).toBeUndefined()
    expect(resolveEffort('qwen3-72b-instruct', 'max').reasoningEffort).toBeUndefined()
    expect(resolveEffort('qwq-32b', 'high').reasoningEffort).toBeUndefined()
    expect(resolveEffort('qwq-32b', 'high').maxTokens).toBe(32768)
    expect(resolveEffort('gemini-2.5-pro', 'minimal').reasoningEffort).toBeUndefined()
    expect(resolveEffort('gemini-2.5-flash', 'medium').reasoningEffort).toBeUndefined()
    expect(resolveEffort('gemini-3-pro', 'max').reasoningEffort).toBeUndefined()
    expect(resolveEffort('gemini-2.5-pro', 'high').maxTokens).toBe(65536)
  })

  it('非法档位回落到 high，不断流', () => {
    expect(resolveEffort('muse-spark-1.3', 'ultra' as never as string).reasoningEffort).toBe('high')
    expect(isMuseSpark('MUSE-SPARK-1.3')).toBe(true)
    expect(isDeepSeek('DeepSeek-Flash')).toBe(true)
  })

  it('o1/o3/o4/gpt-5 用词边界匹配：不误伤 pro3/turbo4/audio1 等普通模型', () => {
    expect(isOpenAIReasoning('o1-preview')).toBe(true)
    expect(isOpenAIReasoning('o3-mini')).toBe(true)
    expect(isOpenAIReasoning('gpt-5')).toBe(true)
    expect(isOpenAIReasoning('my-gpt-5-mini')).toBe(true)
    expect(isOpenAIReasoning('pro3-turbo')).toBe(false)
    expect(isOpenAIReasoning('turbo4')).toBe(false)
    expect(isOpenAIReasoning('audio1-preview')).toBe(false)
    // 独立 o1 词元（如 qwen-o1-distill）视为显式 o1 血统声明，允许匹配
    expect(isOpenAIReasoning('qwen-o1-distill')).toBe(true)
    // 误伤模型走未知分支：不下发 reasoningEffort
    expect(resolveEffort('pro3-turbo', 'high').reasoningEffort).toBeUndefined()
    expect(resolveEffort('audio1-preview', 'high').reasoningEffort).toBeUndefined()
  })
})
