import { describe, expect, it, vi } from 'vitest'
import { runSubagent, SPAWN_SUBAGENT_SCHEMA, SPAWN_TOOL_NAME, type SubagentCallbacks } from './subagent'
import type { StreamChunk } from '../providers/types'

function baseCtx(overrides: Partial<SubagentCallbacks> = {}): SubagentCallbacks {
  return {
    model: 'test-model',
    providerId: null,
    workingDirectory: '/proj',
    readOnly: false,
    signal: new AbortController().signal,
    schemas: [],
    stream: async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: 'done' }
      yield { type: 'stop', reason: 'stop' }
    },
    invokeTool: async () => ({ content: 'ok', isError: false }),
    ...overrides
  }
}

describe('子智能体 (runSubagent)', () => {
  it('纯文字任务直接返回结论', async () => {
    const res = await runSubagent({ task: '看看 a 目录' }, baseCtx())
    expect(res.isError).toBe(false)
    expect(res.content).toContain('done')
    expect(res.content).toContain('【子任务结论】')
  })

  it('缺少 task 参数直接报错不进循环', async () => {
    const stream = vi.fn(baseCtx().stream)
    const res = await runSubagent({}, baseCtx({ stream }))
    expect(res.isError).toBe(true)
    expect(stream).not.toHaveBeenCalled()
  })

  it('工具调用会被执行，结果回填后再收结论', async () => {
    const seen: unknown[] = []
    let round = 0
    const res = await runSubagent(
      { task: '查一下' },
      baseCtx({
        schemas: [{ name: 'read_file', description: '', parameters: {} }],
        stream: async function* () {
          round++
          if (round === 1) {
            yield { type: 'tool_use', id: 'c1', name: 'read_file', input: { path: 'a.txt' } }
          } else {
            yield { type: 'text', text: '文件里写着 42' }
          }
          yield { type: 'stop', reason: 'stop' }
        },
        invokeTool: async (call) => {
          seen.push(call)
          return { content: '42', isError: false }
        }
      })
    )
    expect(seen).toHaveLength(1)
    expect(res.content).toContain('42')
  })

  it('无步数上限：打转时靠行为保险丝停，不死循环', async () => {
    let calls = 0
    const res = await runSubagent(
      { task: '转圈' },
      baseCtx({
        stream: async function* () {
          yield { type: 'tool_use', id: 'c1', name: 'read_file', input: {} }
          yield { type: 'stop', reason: 'length' }
        },
        invokeTool: async () => {
          calls++
          return { content: 'ok', isError: false }
        }
      })
    )
    expect(calls).toBe(3)
    expect(res.content).toContain('结论可能不完整')
  })

  it('超长结论截断并注明', async () => {
    const res = await runSubagent(
      { task: '长文' },
      baseCtx({
        stream: async function* () {
          yield { type: 'text', text: 'x'.repeat(7000) }
          yield { type: 'stop', reason: 'stop' }
        }
      })
    )
    expect(res.content).toContain('已截断')
  })

  it('写任务走隔离 worktree，收尾报告进结论', async () => {
    const noticed: string[] = []
    const res = await runSubagent(
      { task: '改 bug', scopeDir: 'pkg' },
      baseCtx({
        workingDirectory: '/repo',
        isolate: async (scopeDir) => ({
          workDir: '/tmp/wt1',
          describe: '分支 subagent-abc',
          finalize: async () => '独立工作区干净，已回收。'
        }),
        notify: (text) => noticed.push(text),
        invokeTool: async (call, workDir) => {
          expect(workDir).toBe('/tmp/wt1')
          return { content: 'patched', isError: false }
        },
        stream: async function* () {
          yield { type: 'tool_use', id: 'c1', name: 'patch_file', input: {} }
          yield { type: 'stop', reason: 'stop' }
        }
      })
    )
    expect(res.content).toContain('已回收')
    expect(noticed.join('\n')).toContain('开始')
  })

  it('只读任务不请求隔离', async () => {
    const isolate = vi.fn(async () => null)
    await runSubagent({ task: '看看' }, baseCtx({ readOnly: true, isolate }))
    expect(isolate).not.toHaveBeenCalled()
  })

  it('spawn 工具定义完整，可被父循环挂载', () => {
    expect(SPAWN_TOOL_NAME).toBe('spawn_subagent')
    expect(SPAWN_SUBAGENT_SCHEMA.parameters.required).toContain('task')
  })
})
