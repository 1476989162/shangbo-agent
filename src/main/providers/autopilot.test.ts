import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  assessWmiGpu,
  classifyGpuTierFromVram,
  detectHardware,
  inferVramFromName,
  listAutopilotTiers,
  probePolyStrataHealth,
  probeRealHardware,
  recommendLocalModel,
  verifyLocalModelReady
} from './autopilot'

describe('Model Autopilot：硬件分档推荐', () => {
  it('12GB N卡推荐 125B Flash-Next（linger 同款大模型）', () => {
    const pick = recommendLocalModel({
      platform: 'win32',
      totalMemGB: 64,
      cpuCount: 16,
      gpuTier: 'nvidia-12g',
      gpuMemGB: 12
    })
    expect(pick.model).toContain('Flash-Next')
    expect(pick.contextK).toBeGreaterThanOrEqual(64)
  })

  it('无独显兜底 7B 可跑', () => {
    const pick = recommendLocalModel({
      platform: 'win32',
      totalMemGB: 8,
      cpuCount: 8,
      gpuTier: 'cpu-only',
      gpuMemGB: null
    })
    expect(pick.model).toContain('7B')
  })

  it('本机探测不抛错且分档表自洽', () => {
    const hw = detectHardware()
    expect(hw.totalMemGB).toBeGreaterThan(0)
    const tiers = listAutopilotTiers()
    expect(tiers.length).toBeGreaterThanOrEqual(5)
    const pick = recommendLocalModel(hw)
    expect(pick.model.length).toBeGreaterThan(0)
  })
})

describe('Model Autopilot：真实显存分档（Stage 5）', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('按真实显存 MB 划分 8G / 12G / 24G，非法值落 cpu-only', () => {
    expect(classifyGpuTierFromVram(8192)).toBe('nvidia-8g')
    expect(classifyGpuTierFromVram(12288)).toBe('nvidia-12g')
    expect(classifyGpuTierFromVram(24576)).toBe('nvidia-24g')
    expect(classifyGpuTierFromVram(2048)).toBe('cpu-only')
    expect(classifyGpuTierFromVram(Number.NaN)).toBe('cpu-only')
  })

  it('WMI 把 12GB 卡溢出成 4GB 时，不再误判成无独显', () => {
    expect(inferVramFromName('NVIDIA GeForce RTX 3060')).toBe(12_288)
    expect(inferVramFromName('Intel UHD Graphics')).toBeNull()
    // 本机实测值：4293918720 字节 ≈ 4095MB（uint32 溢出）
    const a = assessWmiGpu('NVIDIA GeForce RTX 3060', 4_293_918_720)
    expect(a.discrete).toBe(true)
    expect(a.gpuTier).toBe('nvidia-12g')
    expect(a.gpuMemGB).toBe(12)
    expect(a.vramNote).toContain('型号推断')
    expect(assessWmiGpu('GameViewer Virtual Display Adapter', 0).discrete).toBe(false)
    expect(assessWmiGpu('Some Unknown NVIDIA Card', 4_293_918_720).gpuTier).toBe('unknown')
    expect(assessWmiGpu('NVIDIA RTX A2000', 6 * 1024 ** 3).gpuTier).toBe('nvidia-8g')
  })

  it('/health 不存在时回退 /v1/models，不把在线引擎误报为未启动', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/health')) return { ok: false, status: 404, json: async () => ({}) }
      return { ok: true, json: async () => ({ data: [{ id: 'Qwen3.8-Flash-Next' }] }) }
    })
    vi.stubGlobal('fetch', fetchMock)
    const health = await probePolyStrataHealth()
    expect(health.running).toBe(true)
    expect(health.source).toBe('models')
    expect(health.model).toBe('Qwen3.8-Flash-Next')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('probeRealHardware 返回结构化结果，绝不把系统内存冒充显存', async () => {
    const hw = await probeRealHardware()
    expect(hw.totalMemGB).toBeGreaterThan(0)
    expect(['nvidia-8g', 'nvidia-12g', 'nvidia-24g', 'apple-silicon', 'cpu-only', 'unknown']).toContain(hw.gpuTier)
    expect(['nvidia-smi', 'wmi', 'apple-silicon', 'fallback']).toContain(hw.source)
    if (hw.source === 'fallback') expect(hw.gpuTier).toBe('cpu-only')
    // 本机 nvidia-smi 常因远程虚拟显示器报 NVML 错误，走 WMI 回退：
    // 此时必须识别到独显并显式标注显存来源，不能倒退成 cpu-only。
    if (hw.source === 'wmi') {
      expect(hw.gpuTier).not.toBe('cpu-only')
      expect(hw.vramNote).toBeTruthy()
    }
  }, 15_000)

  it('/health 探测：正常解析与失败降级', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: unknown) => ({
      ok: true,
      json: async () => ({ loaded: true, model: 'local-model', max_context: 65_536, images: true })
    }))
    vi.stubGlobal('fetch', fetchMock)
    const health = await probePolyStrataHealth('http://127.0.0.1:8080')
    expect(health).toMatchObject({ running: true, loaded: true, model: 'local-model', maxContext: 65_536 })
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:8080/health')

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNREFUSED') }))
    expect((await probePolyStrataHealth()).running).toBe(false)
  })

  it('真题验活：非空回答才通过，空回答 / HTTP 错误都不算就绪', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: unknown) => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: 'READY' } }] })
    }))
    vi.stubGlobal('fetch', fetchMock)
    const ok = await verifyLocalModelReady('http://127.0.0.1:8080/v1', 'local-model')
    expect(ok.ok).toBe(true)
    expect(ok.reply).toBe('READY')
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:8080/v1/chat/completions')

    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '' } }] })
    })))
    expect((await verifyLocalModelReady('http://127.0.0.1:8080', 'local-model')).ok).toBe(false)

    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503 })))
    const failed = await verifyLocalModelReady('http://127.0.0.1:8080', 'local-model')
    expect(failed.ok).toBe(false)
    expect(failed.error).toContain('503')
  })
})
