import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import {
  ALLOWED_REMOTE_OPS,
  canonicalParamString,
  parseRemoteRequest,
  RemotePushSchema,
  RemoteRequestSchema,
  RemoteResponseSchema
} from './remote'

/* 阶段1：远程协议 schema 校验。每个消息都有 zod 校验，类型导出给手机端。 */

describe('远程协议 (shared/remote)', () => {
  it('白名单包含清单要求的操作，不含 settings/provider/dialog/app', () => {
    expect(ALLOWED_REMOTE_OPS).toEqual(
      expect.arrayContaining([
        'listConversations',
        'getMessages',
        'send',
        'abort',
        'approve',
        'regenerate',
        'cancelQueued'
      ])
    )
    expect(ALLOWED_REMOTE_OPS).not.toContain('settings:set' as never)
    expect(ALLOWED_REMOTE_OPS).not.toContain('provider:list' as never)
  })

  it('合法请求解析通过并校验 params', () => {
    const parsed = parseRemoteRequest({
      id: '1',
      kind: 'req',
      op: 'send',
      params: { conversationId: 'c1', parentMessageId: null, content: '你好' }
    })
    expect(parsed.op).toBe('send')
  })

  it('未列出的操作直接抛错', () => {
    expect(() =>
      parseRemoteRequest({ id: '1', kind: 'req', op: 'settings:set', params: {} })
    ).toThrow()
    expect(() =>
      parseRemoteRequest({ id: '1', kind: 'req', op: 'provider:list', params: {} })
    ).toThrow()
    expect(() => parseRemoteRequest({ id: '1', kind: 'req', op: 'app:quit', params: {} })).toThrow()
  })

  it('非法 params 被拒绝（空消息、缺字段）', () => {
    expect(() =>
      parseRemoteRequest({
        id: '1',
        kind: 'req',
        op: 'send',
        params: { conversationId: 'c1', parentMessageId: null, content: '   ' }
      })
    ).toThrow()
    expect(() =>
      parseRemoteRequest({ id: '1', kind: 'req', op: 'approve', params: { runId: 'r' } })
    ).toThrow()
  })

  it('approve 必须带 paramHash（审批绑定）', () => {
    expect(() =>
      parseRemoteRequest({
        id: '1',
        kind: 'req',
        op: 'approve',
        params: { runId: 'r', toolUseId: 't', approved: true }
      })
    ).toThrow()
    const ok = parseRemoteRequest({
      id: '1',
      kind: 'req',
      op: 'approve',
      params: { runId: 'r', toolUseId: 't', approved: true, paramHash: 'abc' }
    })
    expect(ok.op).toBe('approve')
  })

  it('响应与推送结构校验', () => {
    expect(RemoteResponseSchema.parse({ id: '1', kind: 'res', ok: true, data: [] }).ok).toBe(true)
    expect(RemotePushSchema.parse({ kind: 'push', event: { type: 'run_end' } }).kind).toBe('push')
    expect(() => RemoteRequestSchema.parse({ id: '', kind: 'req', op: 'send', params: {} })).toThrow()
  })

  it('canonicalParamString 稳定：键序不同哈希相同，与 Node crypto 一致', () => {
    const a = canonicalParamString({ b: 2, a: 1, nested: { y: [3, 2], x: 1 } })
    const b = canonicalParamString({ nested: { x: 1, y: [3, 2] }, a: 1, b: 2 })
    expect(a).toBe(b)
    // 数组保序：顺序不同则不同
    expect(canonicalParamString({ y: [3, 2] })).not.toBe(canonicalParamString({ y: [2, 3] }))
    const sha = createHash('sha256').update(a, 'utf8').digest('hex')
    expect(sha).toMatch(/^[0-9a-f]{64}$/)
  })
})
