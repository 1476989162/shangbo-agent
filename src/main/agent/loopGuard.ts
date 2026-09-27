/**
 * 防死循环保险丝（学 Cursor 的连续犯错上限 + Hermes 按模型连贯性设帽）。
 *
 * 它只回答一个问题："最近这几步是不是在原地打转？"——连续失败、同一个调用重复发，
 * 都是人一眼能看出的打转。正常干活哪怕跑 50 步也不会触发，所以它和步数上限
 * （管"最多跑多远"）是两个独立的东西，可以放心把步数调大。
 */

export interface ToolRecord {
  /** "工具名:参数摘要"，由 callSignature 生成。 */
  sig: string
  isError: boolean
}

/** 参数转摘要：JSON 压平，超长截断，只求"相同调用→相同摘要"。 */
export function callSignature(name: string, input: unknown): string {
  let raw: string
  try {
    raw = JSON.stringify(input ?? {})
  } catch {
    raw = String(input)
  }
  return `${name}:${raw.length > 500 ? raw.slice(0, 500) : raw}`
}

/**
 * 检查最近 limit 条记录是否打转。返回停机原因，无事返回 null。
 * - 最近 limit 次全是失败 → 模型在同一类错误里撞墙（比如 patch 原文永远对不上）。
 * - 最近 limit 次是同一个调用 → 模型在重复上一模一样的操作。
 */
export function detectStuck(history: ToolRecord[], limit = 3): string | null {
  if (limit <= 0 || history.length < limit) return null
  const recent = history.slice(-limit)

  if (recent.every((r) => r.isError)) {
    return `工具已连续失败 ${limit} 次（${recent[recent.length - 1].sig}），先停下来请人看一眼，不要继续烧 Token。`
  }

  const first = recent[0].sig
  if (recent.every((r) => r.sig === first)) {
    return `同一个工具调用已重复 ${limit} 次（${first}），疑似原地打转，先停下来。`
  }

  return null
}
