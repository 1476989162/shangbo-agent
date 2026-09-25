/** 极简 SSE 读取器，同时兼容 `\n\n` 与 `\r\n\r\n` 分隔。 */
export interface SseEvent {
  event: string | null
  data: string
}

export async function* readSse(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      // 在累积后的完整缓冲区上归一化换行，避免 \r\n 被切分到两个 chunk 而漏判
      buffer = (buffer + decoder.decode(value, { stream: true })).replace(/\r\n/g, '\n')

      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1) {
        const raw = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const parsed = parseEvent(raw)
        if (parsed) yield parsed
        boundary = buffer.indexOf('\n\n')
      }
    }

    const tail = buffer.trim()
    if (tail) {
      const parsed = parseEvent(tail)
      if (parsed) yield parsed
    }
  } finally {
    reader.releaseLock()
  }
}

function parseEvent(raw: string): SseEvent | null {
  let event: string | null = null
  const dataLines: string[] = []

  for (const line of raw.split('\n')) {
    if (!line || line.startsWith(':')) continue
    if (line.startsWith('event:')) {
      event = line.slice(6).trim()
    } else if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).replace(/^ /, ''))
    }
  }

  if (dataLines.length === 0) return null
  return { event, data: dataLines.join('\n') }
}

/** 统一的 HTTP 错误构造，便于网关识别 401 / 429 后决定是否降级。 */
export class ProviderHttpError extends Error {
  /** 从 Retry-After 头解析出的等待毫秒数；头缺失时为 null。 */
  readonly retryAfterMs: number | null

  constructor(
    readonly status: number,
    readonly body: string,
    readonly providerName: string,
    retryAfterHeader?: string | null
  ) {
    super(`${providerName} 返回 ${status}: ${body.slice(0, 300)}`)
    this.name = 'ProviderHttpError'
    this.retryAfterMs = ProviderHttpError.parseRetryAfter(retryAfterHeader ?? null)
  }

  /** 可重试 / 可降级的状态码。 */
  get retryable(): boolean {
    return this.status === 408 || this.status === 429 || this.status >= 500
  }

  get isRateLimit(): boolean {
    return this.status === 429
  }

  /**
   * Retry-After 支持两种形式：delta-seconds（"30"）或 HTTP-date。
   * 统一返回毫秒；无法解析时返回 null。
   */
  private static parseRetryAfter(header: string | null): number | null {
    if (!header) return null
    const trimmed = header.trim()
    const seconds = Number(trimmed)
    if (Number.isFinite(seconds) && seconds >= 0) return Math.floor(seconds * 1000)
    const dateMs = Date.parse(trimmed)
    if (!Number.isNaN(dateMs)) return Math.max(0, dateMs - Date.now())
    return null
  }
}