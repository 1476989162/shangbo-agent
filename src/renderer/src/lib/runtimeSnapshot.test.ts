import { describe, expect, it } from 'vitest'
import type { ContentBlock } from '@shared/types'
import { mergeLiveBlocks, shouldAdoptStreamingLeaf, tailText } from './runtimeSnapshot'

const text = (value: string): ContentBlock => ({ type: 'text', text: value })

describe('tailText', () => {
  it('取最后一个文本块', () => {
    expect(tailText([text('a'), { type: 'tool_use', id: 't', name: 'n', input: {} }, text('b')])).toBe('b')
  })

  it('没有文本块时返回空串', () => {
    expect(tailText([{ type: 'reasoning', text: '想' }])).toBe('')
  })
})

describe('mergeLiveBlocks', () => {
  it('快照为空时保留本地（本轮还没开始产出内容）', () => {
    const local = [text('已收到的增量')]
    expect(mergeLiveBlocks([], local)).toEqual(local)
  })

  it('本地为空时采用快照（切走期间内容只在主进程里）', () => {
    const live = [text('后台生成的正文')]
    expect(mergeLiveBlocks(live, [])).toEqual(live)
  })

  it('本地比快照更完整时保留本地，避免切换瞬间丢字', () => {
    const live = [text('你好')]
    const local = [text('你好，我是尚搏')]
    expect(mergeLiveBlocks(live, local)).toEqual(local)
  })

  it('本地落后于快照时采用快照', () => {
    const live = [text('你好，我是尚搏 Agent')]
    const local = [text('你好')]
    expect(mergeLiveBlocks(live, local)).toEqual(live)
  })

  it('本地内容与快照不一致（不同分支）时以快照为准', () => {
    const live = [text('快照正文')]
    const local = [text('完全不同的内容')]
    expect(mergeLiveBlocks(live, local)).toEqual(live)
  })
})

describe('shouldAdoptStreamingLeaf', () => {
  it('当前叶子是它的父消息时推进视图', () => {
    expect(
      shouldAdoptStreamingLeaf({ streamingMessageId: 'a1' }, 'u1', 'u1')
    ).toBe(true)
  })

  it('用户已切到别的分支时不拽回视图', () => {
    expect(
      shouldAdoptStreamingLeaf({ streamingMessageId: 'a1' }, 'u2', 'u1')
    ).toBe(false)
  })

  it('没有在流式输出时不推进', () => {
    expect(shouldAdoptStreamingLeaf({ streamingMessageId: null }, 'u1', 'u1')).toBe(false)
  })

  it('父消息未知时不推进', () => {
    expect(shouldAdoptStreamingLeaf({ streamingMessageId: 'a1' }, 'u1', null)).toBe(false)
  })
})
