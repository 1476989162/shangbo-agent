import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentEvent, ApprovalDecision } from '../../shared/types'

const settings = vi.hoisted(() => new Map<string, unknown>())

vi.mock('electron-log/main', () => ({
  default: { warn: vi.fn(), info: vi.fn() }
}))

vi.mock('../settings', () => ({
  getSetting: <T>(key: string, fallback: T): T =>
    settings.has(key) ? (settings.get(key) as T) : fallback,
  setSetting: (key: string, value: unknown): void => {
    settings.set(key, value)
  }
}))

import { ApprovalBroker } from './approvals'

function requestTool(
  broker: ApprovalBroker,
  runId = 'run-1',
  toolUseId = 'tool-1',
  conversationId = 'conv-1',
  name = 'write_file'
): {
  decision: Promise<ApprovalDecision>
  events: AgentEvent[]
  controller: AbortController
} {
  const events: AgentEvent[] = []
  const controller = new AbortController()
  const decision = broker.request(
    runId,
    conversationId,
    'message-1',
    { id: toolUseId, name, input: { path: 'a.txt' } },
    { name, approvalReason: '测试审批' },
    (event) => events.push(event),
    controller
  )
  return { decision, events, controller }
}

describe('ApprovalBroker', () => {
  beforeEach(() => {
    settings.clear()
  })

  it('桌面批准后结束挂起审批', async () => {
    const broker = new ApprovalBroker()
    const { decision, events } = requestTool(broker)

    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe('approval_required')
    expect(broker.list()).toHaveLength(1)

    broker.decide({ runId: 'run-1', toolUseId: 'tool-1', approved: true })

    await expect(decision).resolves.toEqual({
      runId: 'run-1',
      toolUseId: 'tool-1',
      approved: true
    })
    expect(broker.list()).toHaveLength(0)
  })

  it('远程审批哈希不一致时按拒绝收尾', async () => {
    const broker = new ApprovalBroker()
    const { decision } = requestTool(broker)

    expect(broker.decideWithHash('run-1', 'tool-1', true, 'wrong-hash')).toBe(false)
    await expect(decision).resolves.toMatchObject({ approved: false })
    expect(broker.list()).toHaveLength(0)
  })

  it('只有桌面审批的 alwaysAllow 会记录永久放行', async () => {
    const broker = new ApprovalBroker()
    const desktop = requestTool(broker, 'run-1', 'tool-1', 'conv-1', 'write_file')
    broker.decide({
      runId: 'run-1',
      toolUseId: 'tool-1',
      approved: true,
      alwaysAllow: true
    })
    await desktop.decision
    expect(broker.isAutoApproved('write_file')).toBe(true)

    const remote = requestTool(broker, 'run-2', 'tool-2', 'conv-1', 'mcp__demo__read')
    const pending = broker.list().find((item) => item.runId === 'run-2')
    expect(pending).toBeDefined()
    expect(
      broker.decideWithHash('run-2', 'tool-2', true, pending?.paramHash)
    ).toBe(true)
    await remote.decision
    expect(broker.isAutoApproved('mcp__demo__read')).toBe(false)
  })

  it('会话停止时拒绝该会话的全部挂起审批', async () => {
    const broker = new ApprovalBroker()
    const first = requestTool(broker, 'run-1', 'tool-1', 'conv-1')
    const second = requestTool(broker, 'run-2', 'tool-2', 'conv-1')
    const other = requestTool(broker, 'run-3', 'tool-3', 'conv-2')

    broker.rejectConversation('conv-1')

    await expect(first.decision).resolves.toMatchObject({ approved: false })
    await expect(second.decision).resolves.toMatchObject({ approved: false })
    expect(broker.list()).toHaveLength(1)
    expect(broker.list()[0]?.runId).toBe('run-3')

    broker.rejectRuns(new Set(['run-3']))
    await expect(other.decision).resolves.toMatchObject({ approved: false })
    expect(broker.list()).toHaveLength(0)
  })
})
