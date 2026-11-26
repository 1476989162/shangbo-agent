import { describe, expect, it } from 'vitest'
import type { Message } from '@shared/types'
import { buildChildrenByParentId, getBranchInfo, hasAssistantReply } from './messageIndex'

function makeMessage(overrides: Partial<Message> & { id: string }): Message {
  return {
    conversationId: 'conv',
    parentId: null,
    role: 'user',
    blocks: [],
    status: 'done',
    error: null,
    providerId: null,
    model: null,
    usage: null,
    usageMode: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides
  } as Message
}

describe('buildChildrenByParentId', () => {
  it('按 parentId 建索引，无 parent 的消息不进表', () => {
    const root = makeMessage({ id: 'root' })
    const child = makeMessage({ id: 'c1', parentId: 'root', role: 'assistant' })
    const index = buildChildrenByParentId([root, child])
    expect(index.get('root')).toEqual([child])
    expect(index.has('c1')).toBe(false)
  })

  it('空输入返回空表', () => {
    expect(buildChildrenByParentId([]).size).toBe(0)
  })
})

describe('getBranchInfo', () => {
  it('多助手回复按时间排序并给出前后指针', () => {
    const parent = 'u1'
    const a1 = makeMessage({ id: 'a1', parentId: parent, role: 'assistant', createdAt: 2 })
    const a2 = makeMessage({ id: 'a2', parentId: parent, role: 'assistant', createdAt: 1 })
    const index = buildChildrenByParentId([
      makeMessage({ id: parent }),
      a1,
      a2,
      makeMessage({ id: 'u2', parentId: parent, role: 'user', createdAt: 3 })
    ])
    // 用户子消息不计入助手分支
    expect(getBranchInfo(a2, index)).toEqual({ index: 1, total: 2, prevId: null, nextId: 'a1' })
    expect(getBranchInfo(a1, index)).toEqual({ index: 2, total: 2, prevId: 'a2', nextId: null })
  })

  it('单个回复 / 非助手消息返回 null', () => {
    const parent = 'u1'
    const only = makeMessage({ id: 'only', parentId: parent, role: 'assistant' })
    const user = makeMessage({ id: parent })
    const index = buildChildrenByParentId([user, only])
    expect(getBranchInfo(only, index)).toBeNull()
    expect(getBranchInfo(user, index)).toBeNull()
  })
})

describe('hasAssistantReply', () => {
  it('有助手子节点为 true，无子节点/仅用户子节点为 false', () => {
    const index = buildChildrenByParentId([
      makeMessage({ id: 'u1' }),
      makeMessage({ id: 'a1', parentId: 'u1', role: 'assistant' }),
      makeMessage({ id: 'u2' }),
      makeMessage({ id: 'u3', parentId: 'u2', role: 'user' })
    ])
    expect(hasAssistantReply('u1', index)).toBe(true)
    expect(hasAssistantReply('u2', index)).toBe(false)
    expect(hasAssistantReply('不存在', index)).toBe(false)
  })
})
