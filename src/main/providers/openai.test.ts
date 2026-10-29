import { describe, expect, it } from 'vitest'
import { mergeUsage } from './openai'

/*
 * Token 统计失真回归测试。
 *
 * 线上症状：Token 用量页显示「累计输入 0 / 累计输出 859.7k」，
 * 总消耗恰好等于输出量。根因是 usage 逐帧整体覆盖——部分兼容网关
 * 先发 prompt_tokens、后续帧只发 completion_tokens，或末尾帧把
 * prompt_tokens 写回 0，覆盖后输入侧整段丢失。
 */

describe('mergeUsage 逐帧合并', () => {
  it('后帧把 prompt_tokens 写回 0 时，不覆盖已拿到的输入侧', () => {
    const first = mergeUsage(null, { prompt_tokens: 1200, completion_tokens: 10 })
    expect(first.promptTokens).toBe(1200)

    // 末尾帧只带输出，且把 prompt_tokens 写成 0（真实网关行为）
    const last = mergeUsage(first, { prompt_tokens: 0, completion_tokens: 240 })
    expect(last.promptTokens).toBe(1200) // 关键：不被 0 覆盖
    expect(last.completionTokens).toBe(240)
  })

  it('先发输入、后帧只发输出时，两侧都能留下', () => {
    let usage = mergeUsage(null, { prompt_tokens: 900 })
    usage = mergeUsage(usage, { completion_tokens: 50 })
    usage = mergeUsage(usage, { completion_tokens: 120 })
    expect(usage.promptTokens).toBe(900)
    expect(usage.completionTokens).toBe(120)
  })

  it('DeepSeek 只回缓存拆分时，用命中+未命中回填输入侧', () => {
    const usage = mergeUsage(null, {
      prompt_cache_hit_tokens: 800,
      prompt_cache_miss_tokens: 400,
      completion_tokens: 60
    })
    expect(usage.promptTokens).toBe(1200)
    expect(usage.cacheReadTokens).toBe(800)
    expect(usage.cacheWriteTokens).toBe(400)
  })

  it('显式 prompt_tokens 为 0 但缓存拆分有值，以派生值为准', () => {
    const usage = mergeUsage(null, {
      prompt_tokens: 0,
      prompt_cache_hit_tokens: 700,
      prompt_cache_miss_tokens: 300,
      completion_tokens: 30
    })
    expect(usage.promptTokens).toBe(1000)
  })

  it('确实空输入（全 0）时保持 0，不臆造数据', () => {
    const usage = mergeUsage(null, { prompt_tokens: 0, completion_tokens: 0 })
    expect(usage.promptTokens).toBe(0)
    expect(usage.completionTokens).toBe(0)
  })

  it('兼容 input_tokens / output_tokens 命名（部分网关如此）', () => {
    const usage = mergeUsage(null, { input_tokens: 500, output_tokens: 100 })
    expect(usage.promptTokens).toBe(500)
    expect(usage.completionTokens).toBe(100)
  })

  it('非法字段（null / 字符串 / NaN）视为缺失，不污染统计', () => {
    const usage = mergeUsage(null, {
      prompt_tokens: null,
      completion_tokens: 'abc',
      prompt_cache_hit_tokens: Number.NaN
    })
    expect(usage.promptTokens).toBe(0)
    expect(usage.completionTokens).toBe(0)
  })

  it('累计值单调不回退：中间帧出现更小的值时不采纳', () => {
    let usage = mergeUsage(null, { prompt_tokens: 1000, completion_tokens: 200 })
    usage = mergeUsage(usage, { prompt_tokens: 300, completion_tokens: 150 })
    expect(usage.promptTokens).toBe(1000)
    expect(usage.completionTokens).toBe(200)
  })
})
