/** 可并发执行的只读工具；写入、命令和外部能力仍走串行。 */
export const READ_ONLY_TOOL_NAMES = new Set([
  'read_file',
  'list_directory',
  'search_files',
  'glob_files',
  'get_current_time'
])

export function isReadOnlyToolName(name: string): boolean {
  return READ_ONLY_TOOL_NAMES.has(name)
}

/** 把非法设置收敛到 1-16，缺省 4。 */
export function normalizeToolConcurrency(value: number): number {
  if (!Number.isFinite(value)) return 4
  return Math.max(1, Math.min(16, Math.floor(value)))
}

interface ToolBatchOptions<C, R> {
  concurrency: number
  /** 返回 true 的调用进入并发批；其余调用在并发批结束后按原顺序串行。 */
  canRunConcurrently: (call: C) => boolean
  invoke: (call: C) => Promise<R>
}

/**
 * 执行一批工具调用，并始终按输入数组顺序返回结果。
 * 并发批有上限；写入/命令不抢跑，避免同一批里多个审批与副作用互相穿插。
 */
export async function runToolBatch<C extends { name: string }, R>(
  calls: C[],
  options: ToolBatchOptions<C, R>
): Promise<R[]> {
  const results = new Array<R>(calls.length)
  if (calls.length === 0) return results

  const entries = calls.map((call, index) => ({ call, index }))
  const concurrentEntries = entries.filter((entry) => options.canRunConcurrently(entry.call))
  const serialEntries = entries.filter((entry) => !options.canRunConcurrently(entry.call))
  const limit = normalizeToolConcurrency(options.concurrency)

  const runConcurrent = async (): Promise<void> => {
    let cursor = 0
    const worker = async (): Promise<void> => {
      for (;;) {
        const current = cursor++
        if (current >= concurrentEntries.length) return
        const entry = concurrentEntries[current]
        results[entry.index] = await options.invoke(entry.call)
      }
    }
    const workerCount = Math.min(limit, concurrentEntries.length)
    await Promise.all(Array.from({ length: workerCount }, () => worker()))
  }

  await runConcurrent()
  for (const entry of serialEntries) {
    results[entry.index] = await options.invoke(entry.call)
  }
  return results
}
