import { describe, expect, it } from 'vitest'
import { isReadOnlyToolName, normalizeToolConcurrency, runToolBatch } from './toolScheduler'

interface TestCall {
  name: string
  id: string
}

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

describe('工具并发调度', () => {
  it('混有写工具时先并发跑完只读工具，再串行执行写工具，结果保持原顺序', async () => {
    const calls: TestCall[] = [
      { name: 'write_file', id: 'write' },
      { name: 'read_file', id: 'read-1' },
      { name: 'search_files', id: 'read-2' },
      { name: 'list_directory', id: 'read-3' }
    ]
    const started: string[] = []
    const finished: string[] = []
    let activeReads = 0
    let maxActiveReads = 0

    const results = await runToolBatch(calls, {
      concurrency: 4,
      canRunConcurrently: (call) => isReadOnlyToolName(call.name),
      invoke: async (call) => {
        started.push(call.id)
        if (isReadOnlyToolName(call.name)) {
          activeReads++
          maxActiveReads = Math.max(maxActiveReads, activeReads)
          await wait(30)
          activeReads--
        }
        finished.push(call.id)
        return call.id
      }
    })

    expect(maxActiveReads).toBe(3)
    expect(finished.slice(0, 3).sort()).toEqual(['read-1', 'read-2', 'read-3'])
    expect(finished[3]).toBe('write')
    // 写调用虽然排在输入第一位，但只读批全部启动前不会执行
    expect(started.slice(0, 3).sort()).toEqual(['read-1', 'read-2', 'read-3'])
    expect(started[3]).toBe('write')
    expect(results).toEqual(['write', 'read-1', 'read-2', 'read-3'])
  })

  it('只读并发受 agent.toolConcurrency 上限约束', async () => {
    const calls = Array.from({ length: 6 }, (_, index) => ({
      name: 'read_file',
      id: `read-${index}`
    }))
    let active = 0
    let maxActive = 0

    await runToolBatch(calls, {
      concurrency: 3,
      canRunConcurrently: (call) => isReadOnlyToolName(call.name),
      invoke: async () => {
        active++
        maxActive = Math.max(maxActive, active)
        await wait(15)
        active--
        return 'ok'
      }
    })

    expect(maxActive).toBe(3)
    expect(normalizeToolConcurrency(0)).toBe(1)
    expect(normalizeToolConcurrency(99)).toBe(16)
  })

  it('全部为写工具时严格串行，且结果仍按调用顺序返回', async () => {
    const calls: TestCall[] = [
      { name: 'write_file', id: 'w1' },
      { name: 'patch_file', id: 'w2' },
      { name: 'run_command', id: 'w3' }
    ]
    const order: string[] = []

    const results = await runToolBatch(calls, {
      concurrency: 4,
      canRunConcurrently: (call) => isReadOnlyToolName(call.name),
      invoke: async (call) => {
        order.push(call.id)
        await wait(5)
        return call.id
      }
    })

    expect(order).toEqual(['w1', 'w2', 'w3'])
    expect(results).toEqual(['w1', 'w2', 'w3'])
  })
})
