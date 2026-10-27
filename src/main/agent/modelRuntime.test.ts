import { beforeEach, describe, expect, it, vi } from 'vitest'

const providers = vi.hoisted(() => ({
  order: [] as { id: string; name: string; models: string[] }[]
}))

vi.mock('../providers/store', () => ({
  routingOrder: () => providers.order
}))

import {
  appendBlock,
  normalizeIncomingDelta,
  resolveTarget,
  MAX_OUTPUT_TOKENS
} from './modelRuntime'
import type { ContentBlock } from '../../shared/types'

describe('流式增量归一化', () => {
  it('累计快照只追加新增后缀', () => {
    expect(normalizeIncomingDelta('结论：你好', '结论：')).toEqual({
      delta: '你好',
      snapshot: '结论：你好'
    })
  })

  it('正常重复字词不会被吞掉', () => {
    expect(normalizeIncomingDelta('好好', '好')).toEqual({
      delta: '好',
      snapshot: '好好'
    })
  })

  it('相同快照不重复追加', () => {
    expect(normalizeIncomingDelta('完成', '完成')).toEqual({
      delta: '',
      snapshot: '完成'
    })
  })
})

describe('内容块合并', () => {
  it('相邻文本块合并，思考块超过上限后截断', () => {
    const blocks: ContentBlock[] = []
    appendBlock(blocks, { type: 'text', text: '你' })
    appendBlock(blocks, { type: 'text', text: '好' })
    expect(blocks).toEqual([{ type: 'text', text: '你好' }])

    appendBlock(blocks, { type: 'reasoning', text: 'a'.repeat(7_999) })
    appendBlock(blocks, { type: 'reasoning', text: 'bb' })
    const reasoning = blocks[1]
    expect(reasoning?.type).toBe('reasoning')
    if (reasoning?.type === 'reasoning') {
      expect(reasoning.text).toContain('思考过长，显示已截断')
    }
  })
})

describe('模型目标解析', () => {
  beforeEach(() => {
    providers.order = [{ id: 'p1', name: '测试供应商', models: ['m1'] }]
  })

  it('保留未知模型时的默认输出上限常量', () => {
    expect(MAX_OUTPUT_TOKENS).toBeGreaterThan(0)
  })

  it('优先使用指定模型，缺省时回落到供应商首个模型', () => {
    expect(resolveTarget('p1', 'm2')).toEqual({
      providerId: 'p1',
      model: 'm2',
      providerName: '测试供应商'
    })
    expect(resolveTarget('p1', '')).toEqual({
      providerId: 'p1',
      model: 'm1',
      providerName: '测试供应商'
    })
  })

  it('没有可用供应商时抛出可读错误', () => {
    providers.order = []
    expect(() => resolveTarget(null, null)).toThrow('没有可用的模型供应商')
  })
})
