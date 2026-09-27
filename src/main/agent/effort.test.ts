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

  it('非法档位回落到 high，不断流', () => {
    expect(resolveEffort('muse-spark-1.3', 'ultra' as never as string).reasoningEffort).toBe('high')
    expect(isMuseSpark('MUSE-SPARK-1.3')).toBe(true)
    expect(isDeepSeek('DeepSeek-Flash')).toBe(true)
  })
})
