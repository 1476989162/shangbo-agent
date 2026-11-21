import { describe, expect, it } from 'vitest'
import {
  attachMemoryNote,
  buildMemoryNote,
  getWikiIndex,
  MEMORY_CONTEXT_OPEN,
  setWikiIndex
} from './memoryNote'
import type { LLMMessage } from '../providers/types'

describe('记忆 Note（保 Prompt Cache 注入）', () => {
  it('无动态记忆时不注入空标签', () => {
    setWikiIndex([])
    expect(buildMemoryNote()).toBe('')
    expect(buildMemoryNote({ coworkMemories: [], lessons: [] })).toBe('')
  })

  it('长期背景 / 经验库 / Wiki 索引三块都进 <memory_context>', () => {
    setWikiIndex([{ id: 'project:acme', kind: 'project', title: 'Acme', updatedAt: 10 }])
    const note = buildMemoryNote({
      coworkMemories: ['时区：GMT+8'],
      lessons: ['[全局] 先跑测试'],
      wikiIndex: undefined
    })
    expect(note.startsWith(MEMORY_CONTEXT_OPEN)).toBe(true)
    expect(note).toContain('时区：GMT+8')
    expect(note).toContain('[全局] 先跑测试')
    expect(note).toContain('project:acme')
    expect(getWikiIndex()[0].title).toBe('Acme')
  })

  it('附加到首条 user 消息文本块末尾，不修改原数组，且幂等', () => {
    const messages: LLMMessage[] = [
      { role: 'user', blocks: [{ type: 'text', text: '你好' }] },
      { role: 'assistant', blocks: [{ type: 'text', text: '在' }] }
    ]
    const note = buildMemoryNote({ coworkMemories: ['偏好：简明'], wikiIndex: [] })
    const next = attachMemoryNote(messages, note)

    expect(next).not.toBe(messages)
    expect(messages[0].blocks[0].type === 'text' && messages[0].blocks[0].text).toBe('你好')
    const first = next[0].blocks[0]
    expect(first.type === 'text' && first.text.startsWith('你好')).toBe(true)
    expect(first.type === 'text' && first.text.includes(MEMORY_CONTEXT_OPEN)).toBe(true)
    expect(next[1]).toBe(messages[1])

    const again = attachMemoryNote(next, note)
    const text = again[0].blocks[0]
    expect(text.type === 'text' && text.text.split(MEMORY_CONTEXT_OPEN).length - 1).toBe(1)
  })

  it('首条 user 没有文本块时追加一个文本块；空 note 直接返回原数组', () => {
    const messages: LLMMessage[] = [
      { role: 'user', blocks: [{ type: 'image', mimeType: 'image/png', dataUrl: 'data:image/png;base64,x' }] }
    ]
    const next = attachMemoryNote(messages, buildMemoryNote({ lessons: ['经验'], wikiIndex: [] }))
    expect(next[0].blocks.length).toBe(2)
    expect(attachMemoryNote(messages, '')).toBe(messages)
  })
})
