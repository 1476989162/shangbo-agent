import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ProviderHttpError } from './sse'
import { setFirstByteTimeoutForTesting, streamWithFallback } from './gateway'
import type { Provider } from '../../shared/types'
import type { CompletionRequest, ProviderAdapter, StreamChunk } from './types'

/**
 * 网关降级逻辑的集成测试。
 * store（背后是 Electron db + secrets）与 electron-log 用 mock 替换，
 * streamWithFallback 本身走真实实现，验证真实的选择/降级/报错编排。
 */

const storeMocks = vi.hoisted(() => ({
  routingOrder: vi.fn<() => Provider[]>(),
  getApiKey: vi.fn<(id: string) => string | null>(),
  adapterFor: vi.fn<(provider: Provider) => ProviderAdapter>(),
  getProvider: vi.fn<(id: string) => Provider | null>(),
  listProviders: vi.fn<() => Provider[]>()
}))

vi.mock('./store', () => ({
  routingOrder: storeMocks.routingOrder,
  getApiKey: storeMocks.getApiKey,
  adapterFor: storeMocks.adapterFor,
  getProvider: storeMocks.getProvider,
  listProviders: storeMocks.listProviders
}))

vi.mock('electron-log/main', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
}))

const request: CompletionRequest = {
  model: 'test-model',
  system: 'sys',
  messages: [{ role: 'user', blocks: [{ type: 'text', text: 'hi' }] }]
}

function makeProvider(id: string, name = id): Provider {
  return {
    id,
    name,
    kind: 'openai-compatible',
    baseUrl: 'https://example.invalid',
    hasApiKey: true,
    models: ['test-model'],
    enabled: true,
    priority: 10,
    headers: {},
    createdAt: 0,
    updatedAt: 0
  }
}

/** 一个把行为完全交给测试编排的适配器。 */
function makeAdapter(stream: ProviderAdapter['stream']): ProviderAdapter {
  return {
    kind: 'openai-compatible',
    stream,
    listModels: async () => []
  }
}

/** 立即产出若干 chunk 后正常结束。 */
function okStream(chunks: StreamChunk[]): ProviderAdapter['stream'] {
  return async function* () {
    for (const chunk of chunks) yield chunk
  }
}

/** 永远挂起，直到外部 abort 或给定毫秒后自行继续。 */
function hangingStream(): ProviderAdapter['stream'] {
  return async function* (_request, context) {
    await new Promise((resolve, reject) => {
      context.signal.addEventListener('abort', () => reject(new Error('This operation was aborted')), {
        once: true
      })
    })
    yield { type: 'stop', reason: 'stop' }
  }
}

let providerA: Provider
let providerB: Provider

beforeEach(() => {
  vi.useFakeTimers()
  setFirstByteTimeoutForTesting(30_000)
  providerA = makeProvider('a', '供应商A')
  providerB = makeProvider('b', '供应商B')
  storeMocks.routingOrder.mockReturnValue([providerA, providerB])
  storeMocks.getApiKey.mockImplementation((id) => `key-${id}`)
  storeMocks.getProvider.mockImplementation((id) =>
    id === 'a' ? providerA : id === 'b' ? providerB : null
  )
  storeMocks.listProviders.mockReturnValue([providerA, providerB])
})

afterEach(() => {
  vi.useRealTimers()
  vi.clearAllMocks()
})

async function drain(gen: AsyncGenerator<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const chunk of gen) out.push(chunk)
  return out
}

describe('streamWithFallback', () => {
  it('首选供应商正常时直接产出，不触碰后续供应商', async () => {
    storeMocks.adapterFor.mockReturnValue(makeAdapter(okStream([{ type: 'text', text: 'hi' }])))

    const events = await drain(streamWithFallback(request, new AbortController().signal))

    expect(events).toEqual([{ type: 'text', text: 'hi' }])
    expect(storeMocks.adapterFor).toHaveBeenCalledTimes(1)
  })

  it('未配置密钥的供应商被跳过并计入失败清单', async () => {
    storeMocks.getApiKey.mockImplementation((id) => (id === 'a' ? null : 'key-b'))
    storeMocks.adapterFor.mockReturnValue(makeAdapter(okStream([{ type: 'stop', reason: 'stop' }])))

    const events = await drain(streamWithFallback(request, new AbortController().signal))

    expect(storeMocks.adapterFor).toHaveBeenCalledTimes(1)
    expect(storeMocks.adapterFor.mock.calls[0][0].id).toBe('b')
    // 该合成流只有 stop 元数据块，没有真实内容，因此不产生切换通知
    expect(events).toEqual([{ type: 'stop', reason: 'stop' }])
  })

  it('首字节超时：重试 3 次后降级到下一个供应商', async () => {
    storeMocks.adapterFor.mockImplementation((provider) =>
      makeAdapter(provider.id === 'a' ? hangingStream() : okStream([{ type: 'text', text: '来自B' }]))
    )

    const gen = streamWithFallback(request, new AbortController().signal)

    // 后台持续拉取（for-await 会在每个 chunk 到达后立刻续拉，从而武装下一次 sleep），
    // 同时推进虚拟时间：A 三次 30s 超时 + 两次指数退避（约 1s/2s）后降级到 B
    const chunks: StreamChunk[] = []
    const done = (async () => {
      for await (const chunk of gen) chunks.push(chunk)
    })()
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(31_000)
    }
    await done

    expect(chunks).toContainEqual({ type: 'text', text: '来自B' })
    expect(chunks.some((c) => c.type === 'provider_switch')).toBe(true)
  })

  it('首字节超时的错误文案进入失败清单，而不是裸的 AbortError', async () => {
    storeMocks.adapterFor.mockReturnValue(makeAdapter(hangingStream()))

    const promise = drain(streamWithFallback(request, new AbortController().signal))
    const assertion = expect(promise).rejects.toThrow(/首字节超时/)

    // 两个供应商各重试 3 次，每次都要挂满 30 秒，外加尝试间的退避
    for (let i = 0; i < 8; i++) {
      await vi.advanceTimersByTimeAsync(30_500)
    }
    await assertion
  })

  it('中途失败：已产出内容后不再降级，直接抛出原始错误', async () => {
    const midStream = async function* (): AsyncGenerator<StreamChunk> {
      yield { type: 'text', text: '前半段' }
      throw new Error('流中断')
    }
    storeMocks.adapterFor.mockReturnValue(makeAdapter(midStream))

    await expect(drain(streamWithFallback(request, new AbortController().signal))).rejects.toThrow(
      '流中断'
    )
    // B 从未被尝试
    expect(storeMocks.adapterFor).toHaveBeenCalledTimes(1)
  })

  it('401：不可重试的配置类错误，中止降级直接抛出', async () => {
    storeMocks.adapterFor.mockImplementation(
      () =>
        makeAdapter(async function* () {
          throw new ProviderHttpError(401, 'invalid api key', '供应商A')
        })
    )

    await expect(drain(streamWithFallback(request, new AbortController().signal))).rejects.toThrow(
      /401/
    )
    expect(storeMocks.adapterFor).toHaveBeenCalledTimes(1)
  })

  it('5xx：同供应商重试耗尽后降级，落到下一个供应商', async () => {
    let attemptsA = 0
    storeMocks.adapterFor.mockImplementation((provider) =>
      makeAdapter(
        provider.id === 'a'
          ? async function* () {
              attemptsA++
              throw new ProviderHttpError(503, 'overloaded', '供应商A')
            }
          : okStream([{ type: 'text', text: '来自B' }])
      )
    )

    const promise = drain(streamWithFallback(request, new AbortController().signal))
    const assertion = expect(promise).resolves.toContainEqual({ type: 'text', text: '来自B' })
    // A 的 3 次尝试之间有 1s/2s 的退避等待，推进 10 秒足够覆盖
    await vi.advanceTimersByTimeAsync(10_000)
    await assertion
    expect(attemptsA).toBe(3)
  })

  it('429（未显式选择时）：同供应商按限流窗口重试 6 次后才降级到 B', async () => {
    let attemptsA = 0
    storeMocks.adapterFor.mockImplementation((provider) =>
      makeAdapter(
        provider.id === 'a'
          ? async function* () {
              attemptsA++
              throw new ProviderHttpError(429, 'rate limit', '供应商A')
            }
          : okStream([{ type: 'text', text: '来自B' }])
      )
    )

    const promise = drain(streamWithFallback(request, new AbortController().signal))
    const assertion = expect(promise).resolves.toContainEqual({ type: 'text', text: '来自B' })
    // A 的 5 次等待各 10 秒（无 Retry-After 头），共 50 秒后才轮到 B
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(10_500)
    }
    await assertion
    expect(attemptsA).toBe(6)
  })

  it('显式选择供应商：429 时只在该供应商内重试，绝不切换到别家', async () => {
    let attemptsA = 0
    let touchedB = false
    storeMocks.adapterFor.mockImplementation((provider) =>
      makeAdapter(
        provider.id === 'a'
          ? async function* () {
              attemptsA++
              throw new ProviderHttpError(429, 'rate limit', '供应商A')
            }
          : (async function* () {
              touchedB = true
              yield { type: 'text', text: '来自B' }
            })
      )
    )

    const gen = streamWithFallback(request, new AbortController().signal, 'a')
    const collected: StreamChunk[] = []
    // 立即挂上 rejection 处理器，避免 reject 先于断言发生时被记为 unhandledRejection
    const settled: Promise<unknown> = (async () => {
      for await (const chunk of gen) collected.push(chunk)
    })().then(
      () => null,
      (error: unknown) => error
    )
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(10_500)
    }
    const error = await settled
    expect(error).toBeInstanceOf(Error)
    expect(String((error as Error).message)).toMatch(/429|Use balance/)

    expect(attemptsA).toBe(6)
    expect(touchedB).toBe(false)
    // 每次等待前都下发一次重试状态，共 5 次
    expect(collected.filter((e) => e.type === 'retry_status')).toHaveLength(5)
  })

  it('显式选择的供应商未启用：直接报错提示配置问题，不允许悄悄换别家', async () => {
    const disabled: Provider = { ...providerA, enabled: false, hasApiKey: false }
    storeMocks.getProvider.mockReturnValue(disabled)
    storeMocks.listProviders.mockReturnValue([disabled, providerB])

    await expect(
      drain(streamWithFallback(request, new AbortController().signal, 'a'))
    ).rejects.toThrow(/未启用|API Key/)
    expect(storeMocks.adapterFor).not.toHaveBeenCalled()
  })

  it('Retry-After 响应头存在时，按头给定的秒数等待', async () => {
    let waitedMs = 0
    storeMocks.adapterFor.mockImplementation(
      () =>
        makeAdapter(async function* () {
          throw new ProviderHttpError(429, 'rate limit', '供应商A', '15')
        })
    )
    // 拦截 sleep 时长（fake timer 下直接推进）：显式选择，6 次尝试间应等待 15s（封顶 60s）
    const gen = streamWithFallback(request, new AbortController().signal, 'a')
    const settled: Promise<unknown> = (async () => {
      for await (const chunk of gen) {
        if (chunk.type === 'retry_status') waitedMs += chunk.waitMs
      }
    })().then(
      () => null,
      (error: unknown) => error
    )
    for (let i = 0; i < 6; i++) {
      await vi.advanceTimersByTimeAsync(16_000)
    }
    expect(await settled).toBeInstanceOf(Error)
    expect(waitedMs).toBe(15_000 * 5)
  })

  it('跨供应商降级：模型名在 B 不存在时重映射为 B 的首个模型，并下发切换通知', async () => {
    const providerB: Provider = { ...makeProvider('b', '供应商B'), models: ['b-native-model'] }
    storeMocks.routingOrder.mockReturnValue([providerA, providerB])

    const seenRequests: { provider: string; model: string }[] = []
    storeMocks.adapterFor.mockImplementation((provider) =>
      makeAdapter(
        provider.id === 'a'
          ? async function* () {
              seenRequests.push({ provider: provider.id, model: 'test-model' })
              throw new ProviderHttpError(429, 'rate limit', provider.name)
            }
          : async function* (req) {
              seenRequests.push({ provider: provider.id, model: req.model })
              yield { type: 'text', text: '来自B' }
            }
      )
    )

    const events = await (async () => {
      const gen = streamWithFallback(request, new AbortController().signal)
      const out: StreamChunk[] = []
      const done = (async () => {
        for await (const chunk of gen) out.push(chunk)
      })()
      // A 限流重试 6 次（5 次 10s 等待）后才轮到 B
      for (let i = 0; i < 6; i++) {
        await vi.advanceTimersByTimeAsync(10_500)
      }
      await done
      return out
    })()

    // 发给 A 的是首选模型，发给 B 的被重映射为 b-native-model
    expect(seenRequests).toContainEqual({ provider: 'a', model: 'test-model' })
    expect(seenRequests).toContainEqual({ provider: 'b', model: 'b-native-model' })
    // 前 5 个块是限流重试状态；切换通知在内容之前且只发一次
    const switches = events.filter((e) => e.type === 'provider_switch')
    expect(switches).toHaveLength(1)
    expect(switches[0]).toMatchObject({
      providerName: '供应商B',
      model: 'b-native-model'
    })
    expect(events).toContainEqual({ type: 'text', text: '来自B' })
  })

  it('跨供应商降级后仍失败：错误信息包含完整尝试链而非只有最后一家', async () => {
    storeMocks.adapterFor.mockImplementation(
      () =>
        makeAdapter(async function* () {
          throw new ProviderHttpError(503, 'overloaded', 'x')
        })
    )
    // 让第二家返回不可重试的 404（模型不存在）
    const bAdapter = makeAdapter(async function* () {
      throw new ProviderHttpError(404, 'model is not found', '供应商B')
    })
    storeMocks.adapterFor.mockImplementation((provider) =>
      provider.id === 'a'
        ? makeAdapter(async function* () {
            throw new ProviderHttpError(503, 'overloaded', '供应商A')
          })
        : bAdapter
    )

    const promise = drain(streamWithFallback(request, new AbortController().signal))
    const assertion = expect(promise).rejects.toThrow(/供应商B[\s\S]*此前的尝试[\s\S]*供应商A/)
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(10_000)
    }
    await assertion
  })

  it('全部供应商失败：汇总失败清单抛出', async () => {
    storeMocks.adapterFor.mockImplementation(
      () =>
        makeAdapter(async function* () {
          throw new ProviderHttpError(500, 'boom', 'x')
        })
    )

    const promise = drain(streamWithFallback(request, new AbortController().signal))
    const assertion = expect(promise).rejects.toThrow(/所有模型供应商均不可用/)
    // 每个供应商立即失败 + 退避 1s/2s，推进虚拟时间让所有重试跑完
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(10_000)
    }
    await assertion
  })

  it('外层 signal 取消：立即传播中断，不降级', async () => {
    const outer = new AbortController()
    storeMocks.adapterFor.mockImplementation(() => makeAdapter(hangingStream()))

    const gen = streamWithFallback(request, outer.signal)
    const iterator = gen[Symbol.asyncIterator]()
    const pending = iterator.next()
    await Promise.resolve()
    await Promise.resolve()

    outer.abort()

    await expect(pending).rejects.toThrow()
    expect(storeMocks.adapterFor).toHaveBeenCalledTimes(1)
  })

  it('candidates 为空时直接报错', async () => {
    storeMocks.routingOrder.mockReturnValue([])
    await expect(drain(streamWithFallback(request, new AbortController().signal))).rejects.toThrow(
      /没有可用的模型供应商/
    )
  })

  it('降级严格按优先级顺序进行：A 重试耗尽后试 B，再试 C', async () => {
    const providerC = makeProvider('c', '供应商C')
    storeMocks.routingOrder.mockReturnValue([providerA, providerB, providerC])

    const tried: string[] = []
    storeMocks.adapterFor.mockImplementation((provider) => {
      tried.push(provider.id)
      return makeAdapter(
        provider.id === 'c'
          ? okStream([{ type: 'text', text: '来自C' }])
          : async function* () {
              throw new ProviderHttpError(503, 'down', provider.name)
            }
      )
    })

    const promise = drain(streamWithFallback(request, new AbortController().signal))
    const assertion = expect(promise).resolves.toContainEqual({ type: 'text', text: '来自C' })
    // A、B 各重试 3 次（退避 1s/2s），推进虚拟时间跑完重试链
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(10_000)
    }
    await assertion
    // 每个失败供应商都被尝试 3 次
    expect(tried).toEqual(['a', 'a', 'a', 'b', 'b', 'b', 'c'])
  })

  it('A、B 先后失败时，汇总错误包含每家的原因', async () => {
    storeMocks.adapterFor.mockImplementation(
      (provider) =>
        makeAdapter(async function* () {
          throw new Error(`${provider.id} 的原因`)
        })
    )

    const promise = drain(streamWithFallback(request, new AbortController().signal))
    const assertion = expect(promise).rejects.toThrow(/供应商A[\s\S]*a 的原因[\s\S]*供应商B[\s\S]*b 的原因/)
    for (let i = 0; i < 4; i++) {
      await vi.advanceTimersByTimeAsync(10_000)
    }
    await assertion
  })

  it('调用方提前终止生成器：不再拉取后续 chunk，也不降级到下一个供应商', async () => {
    const clearTimeoutSpy = vi.spyOn(global, 'clearTimeout')
    const pulls: number[] = []
    storeMocks.adapterFor.mockImplementation(() =>
      makeAdapter(async function* () {
        pulls.push(1)
        yield { type: 'text', text: '第一段' }
        pulls.push(2)
        yield { type: 'text', text: '第二段' }
      })
    )

    const gen = streamWithFallback(request, new AbortController().signal)
    const iterator = gen[Symbol.asyncIterator]()

    const first = await iterator.next()
    expect(first.value).toEqual({ type: 'text', text: '第一段' })
    // 首 chunk 到达即解除首字节限制：定时器已被清理
    expect(clearTimeoutSpy).toHaveBeenCalled()

    // 模拟 for-await 循环里的 break：生成器应被正确关闭
    await iterator.return?.(undefined)
    expect(pulls).toEqual([1])
    expect(storeMocks.adapterFor).toHaveBeenCalledTimes(1)
    clearTimeoutSpy.mockRestore()
  })

  it('显式指定了不存在的供应商 id：明确报错，而不是悄悄换成别家', async () => {
    await expect(
      drain(streamWithFallback(request, new AbortController().signal, 'not-exists'))
    ).rejects.toThrow(/不存在|未配置/)
    expect(storeMocks.adapterFor).not.toHaveBeenCalled()
  })
})
