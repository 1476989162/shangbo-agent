import { describe, expect, it } from 'vitest'
import { isDeepSeek, isMuseSpark, isSenseNova, resolveEffort } from './effort'

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

  it('支持 Claude 系列思考模型 (claude-3-7, claude-4, claude-sonnet-4)', () => {
    expect(resolveEffort('claude-3-7-sonnet-20250219', 'minimal').reasoningEffort).toBe('low')
    expect(resolveEffort('claude-3-7-sonnet-20250219', 'max').reasoningEffort).toBe('max')
    expect(resolveEffort('claude-sonnet-4', 'high').reasoningEffort).toBe('high')
    expect(resolveEffort('claude-3-7-sonnet', 'high').maxTokens).toBe(64000)
  })

  it('支持 Qwen 系列推理模型 (qwq, qwen3)', () => {
    expect(resolveEffort('qwq-32b', 'minimal').reasoningEffort).toBe('low')
    expect(resolveEffort('qwen3-72b-instruct', 'max').reasoningEffort).toBe('max')
    expect(resolveEffort('qwq-32b', 'high').maxTokens).toBe(32768)
  })

  it('支持 Gemini 系列思考模型 (gemini-2.5, gemini-3)', () => {
    expect(resolveEffort('gemini-2.5-pro', 'minimal').reasoningEffort).toBe('low')
    expect(resolveEffort('gemini-2.5-flash', 'medium').reasoningEffort).toBe('medium')
    expect(resolveEffort('gemini-3-pro', 'max').reasoningEffort).toBe('high')
    expect(resolveEffort('gemini-2.5-pro', 'high').maxTokens).toBe(65536)
  })

  it('非法档位回落到 high，不断流', () => {
    expect(resolveEffort('muse-spark-1.3', 'ultra' as never as string).reasoningEffort).toBe('high')
    expect(isMuseSpark('MUSE-SPARK-1.3')).toBe(true)
    expect(isDeepSeek('DeepSeek-Flash')).toBe(true)
  })
})
