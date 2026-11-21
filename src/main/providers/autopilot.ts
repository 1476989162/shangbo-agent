/**
 * Model Autopilot（lite）：受 linger Model Autopilot 启发。
 *
 * linger 做法：安装时探测 GPU/VRAM/内存/带宽，只保留 weights+KV 在 64K 上下文
 * 能装下的模型，按 SimplexAI 分数先排最聪明、再排最快，装完用真问题验证。
 *
 * 本模块是纯函数版本，不碰网关/Provider 表，只做「给定硬件推荐什么本地模型」，
 * 调用方可拿推荐去填 Ollama/本地网关的 model 列表。无副作用，可单测。
 */
import { cpus, totalmem, platform } from 'node:os'
import { execFile } from 'node:child_process'

export type GpuTier = 'nvidia-8g' | 'nvidia-12g' | 'nvidia-24g' | 'apple-silicon' | 'cpu-only' | 'unknown'

export interface HardwareInfo {
  platform: string
  /** GB */
  totalMemGB: number
  cpuCount: number
  gpuTier: GpuTier
  /** GB，N 卡显存；Apple Silicon 为统一内存近似值 */
  gpuMemGB: number | null
}

export interface LocalModelPick {
  model: string
  quant: string
  contextK: number
  kv: string
  expectedTps: string
  /** 分档：everyday / capable / frontier */
  level: string
  comparesWith: string
  reason: string
}

/** linger 文档 public-tiers 的本地精简映射（实测速度区间原文照搬含义）。 */
const TIER_TABLE: Array<{
  match: (hw: HardwareInfo) => boolean
  pick: LocalModelPick
  score: number
}> = [
  {
    // 12GB N卡：125B MoE 也能跑（PolyStrata 式专家分流），本地最聪明一档
    match: (hw) => hw.gpuTier === 'nvidia-12g' || (hw.gpuTier === 'nvidia-24g' && hw.totalMemGB < 48),
    pick: {
      model: 'Qwen3.8-Flash-Next',
      quant: 'Q2_0',
      contextK: 64,
      kv: 'q4_0',
      expectedTps: '21-34',
      level: 'frontier',
      comparesWith: '≈ Claude Opus 4.6',
      reason: 'MoE 专家分流：热专家驻 GPU、冷专家放 RAM/SSD，12GB 显存可跑 125B'
    },
    score: 57.3
  },
  {
    match: (hw) => hw.gpuTier === 'nvidia-24g',
    pick: {
      model: 'Qwen3.8-27B',
      quant: 'UD-Q4_K_M',
      contextK: 128,
      kv: 'q8_0',
      expectedTps: '28-33',
      level: 'frontier',
      comparesWith: '≈ Claude Sonnet 4.6',
      reason: '24GB 大显存优先保证 128K 长上下文与稳定解码'
    },
    score: 54.0
  },
  {
    match: (hw) => hw.gpuTier === 'nvidia-8g',
    pick: {
      model: 'Qwen3.6-35B-A3B',
      quant: 'UD-Q3_K_M',
      contextK: 64,
      kv: 'q4_0',
      expectedTps: '88-146',
      level: 'capable',
      comparesWith: '≈ Gemini 2.5 Pro',
      reason: '8GB 卡选 35B-A3B 小激活 MoE，保证速度优先'
    },
    score: 35.4
  },
  {
    // Apple Silicon：统一内存即显存，按 24/32GB 分档
    match: (hw) => hw.gpuTier === 'apple-silicon' && hw.totalMemGB >= 28,
    pick: {
      model: 'Qwen3.8-27B',
      quant: 'UD-Q4_K_M',
      contextK: 128,
      kv: 'q4_0',
      expectedTps: '~45',
      level: 'frontier',
      comparesWith: '≈ Claude Sonnet 4.6',
      reason: '32GB 统一内存可放下 27B Q4 + 128K KV'
    },
    score: 54.0
  },
  {
    match: (hw) => hw.gpuTier === 'apple-silicon',
    pick: {
      model: 'Spark-X2.6-4B',
      quant: 'Q4_K_M',
      contextK: 64,
      kv: 'q8_0',
      expectedTps: '25-37',
      level: 'everyday',
      comparesWith: '日常助手',
      reason: '16GB 档先保证能跑：4B 小模型 + 64K 上下文'
    },
    score: 31.5
  }
]

const CPU_FALLBACK: LocalModelPick = {
  model: 'Qwen2.5-7B',
  quant: 'Q4_K_M',
  contextK: 32,
  kv: 'q8_0',
  expectedTps: '10-20',
  level: 'everyday',
  comparesWith: '日常助手',
  reason: '无独显/CPU 兜底：7B 最小可用，Ollama 本地可直接跑'
}

/**
 * 探测本机硬件。GPU 档位启发式：
 * - darwin arm64 → apple-silicon（totalMem 即统一内存）
 * - env SHANGBO_GPU_TIER / SHANGBO_GPU_MEM_GB 可显式指定（便于测试与用户覆盖）
 * - 否则按内存粗估：>=20GB 视作 24GB N卡档，>=10GB 视作 12GB 档，>=6GB 视作 8GB 档，其余 cpu-only
 */
export function detectHardware(override?: Partial<HardwareInfo>): HardwareInfo {
  const memGB = totalmem() / 1024 ** 3
  const plat = platform()
  const envTier = (process.env.SHANGBO_GPU_TIER || '').toLowerCase() as GpuTier
  const envMem = Number(process.env.SHANGBO_GPU_MEM_GB)
  let gpuTier: GpuTier = 'cpu-only'
  let gpuMem: number | null = null

  if (override?.gpuTier) {
    gpuTier = override.gpuTier
    gpuMem = override.gpuMemGB ?? null
  } else if (envTier === 'nvidia-8g' || envTier === 'nvidia-12g' || envTier === 'nvidia-24g' || envTier === 'apple-silicon' || envTier === 'cpu-only') {
    gpuTier = envTier
    gpuMem = Number.isFinite(envMem) && envMem > 0 ? envMem : null
  } else if (plat === 'darwin' && process.arch === 'arm64') {
    gpuTier = 'apple-silicon'
    gpuMem = Math.round(memGB)
  } else if (memGB >= 20) {
    gpuTier = 'nvidia-24g'
    gpuMem = 24
  } else if (memGB >= 10) {
    gpuTier = 'nvidia-12g'
    gpuMem = 12
  } else if (memGB >= 6) {
    gpuTier = 'nvidia-8g'
    gpuMem = 8
  }

  return {
    platform: override?.platform ?? plat,
    totalMemGB: override?.totalMemGB ?? Math.round(memGB * 10) / 10,
    cpuCount: override?.cpuCount ?? cpus().length,
    gpuTier,
    gpuMemGB: gpuMem
  }
}

/** 按硬件推荐本地模型：命中分档表第一项，否则 CPU 兜底。 */
export function recommendLocalModel(hw?: HardwareInfo): LocalModelPick {
  const info = hw ?? detectHardware()
  for (const tier of TIER_TABLE) {
    try {
      if (tier.match(info)) return { ...tier.pick }
    } catch {
      continue
    }
  }
  return { ...CPU_FALLBACK }
}

/** 给 UI/设置页用的分档说明（与 recommendLocalModel 同源，避免两套口径）。 */
export function listAutopilotTiers(): Array<{ when: string; pick: LocalModelPick; score: number }> {
  return [
    { when: 'Linux/Win NVIDIA 12GB + 32GB 内存', pick: { ...TIER_TABLE[0].pick }, score: TIER_TABLE[0].score },
    { when: 'Linux/Win NVIDIA 24GB + 64GB 内存', pick: { ...TIER_TABLE[1].pick }, score: TIER_TABLE[1].score },
    { when: 'Linux/Win NVIDIA 8GB + 32GB 内存', pick: { ...TIER_TABLE[2].pick }, score: TIER_TABLE[2].score },
    { when: 'Mac 32GB 统一内存', pick: { ...TIER_TABLE[3].pick }, score: TIER_TABLE[3].score },
    { when: 'Mac 16GB 统一内存', pick: { ...TIER_TABLE[4].pick }, score: TIER_TABLE[4].score },
    { when: '无独显 / CPU 兜底', pick: { ...CPU_FALLBACK }, score: 20 }
  ]
}

/* ------------------------------------------------------------------ */
/* 真实硬件探测与本地模型验活（Stage 5）                                */
/* ------------------------------------------------------------------ */

export interface RealHardwareInfo extends HardwareInfo {
  /** 探测到的显卡名；核显/探测失败时为空。 */
  gpuName?: string
  /** 证据来源，供 UI 明示「精确值」还是「回退估计」。 */
  source: 'nvidia-smi' | 'wmi' | 'apple-silicon' | 'fallback'
  /** 显存数值的来源说明（NVML 不可用 / WMI 溢出 / 型号推断），UI 必须如实展示。 */
  vramNote?: string
}

export interface LocalEngineHealth {
  running: boolean
  loaded?: boolean
  model?: string
  maxContext?: number
  images?: boolean
  error?: string
  /** 实际命中的探测端点，便于 UI 说明状态来源。 */
  source?: 'health' | 'models'
  note?: string
}

export interface LocalModelVerifyResult {
  ok: boolean
  latencyMs: number
  reply?: string
  error?: string
}

/** 按真实显存 MB 分档（纯函数，可单测）。 */
export function classifyGpuTierFromVram(vramMB: number): GpuTier {
  if (!Number.isFinite(vramMB) || vramMB <= 0) return 'cpu-only'
  if (vramMB >= 20_000) return 'nvidia-24g'
  if (vramMB >= 10_000) return 'nvidia-12g'
  if (vramMB >= 6_000) return 'nvidia-8g'
  return 'cpu-only'
}

/**
 * 少数型号显存是确定值，可用于 nvidia-smi 不可用时的兜底推断。
 * 只列桌面版固定容量的卡；命中后必须带 vramNote 标明「推断」，不冒充实测。
 */
const KNOWN_VRAM_MB: Array<[RegExp, number]> = [
  [/\brtx\s*3060\s*ti\b/, 8_192],
  [/\brtx\s*3060\b/, 12_288],
  [/\brtx\s*4060\s*ti\b/, 8_192],
  [/\brtx\s*4060\b/, 8_192],
  [/\brtx\s*4070\b/, 12_288],
  [/\brtx\s*4080\b/, 16_384],
  [/\brtx\s*4090\b/, 24_576],
  [/\brtx\s*5090\b/, 32_768]
]

export function inferVramFromName(name: string): number | null {
  const lower = (name || '').toLowerCase()
  for (const [pattern, vramMB] of KNOWN_VRAM_MB) {
    if (pattern.test(lower)) return vramMB
  }
  return null
}

export interface WmiGpuAssessment {
  discrete: boolean
  gpuName: string
  gpuTier: GpuTier
  gpuMemGB: number | null
  vramNote?: string
}

/**
 * WMI 显卡判定（纯函数）：Win32_VideoController.AdapterRAM 是 uint32，
 * 12GB 卡常溢出成 4293918720 字节（≈4095MB）。绝不能拿这个溢出值分档，
 * 更不能因此把独显判成 cpu-only；优先按确定型号推断并显式标注来源。
 */
export function assessWmiGpu(name: string, adapterRamBytes: number): WmiGpuAssessment {
  const gpuName = String(name || '')
  const isDiscrete = /nvidia|geforce|rtx|radeon|\barc\b/i.test(gpuName) && !/intel/i.test(gpuName)
  if (!isDiscrete) {
    return { discrete: false, gpuName, gpuTier: 'cpu-only', gpuMemGB: null }
  }
  const vramMB = Number(adapterRamBytes) / 1024 / 1024
  const overflowed =
    !Number.isFinite(vramMB) ||
    (vramMB >= 3_900 && vramMB <= 4_200) ||
    vramMB >= 65_000 ||
    vramMB <= 0
  if (!overflowed) {
    return {
      discrete: true,
      gpuName,
      gpuTier: classifyGpuTierFromVram(vramMB),
      gpuMemGB: Math.round(vramMB / 1024),
      vramNote: '由 WMI AdapterRAM 估算，精度低于 nvidia-smi'
    }
  }
  const inferred = inferVramFromName(gpuName)
  if (inferred) {
    return {
      discrete: true,
      gpuName,
      gpuTier: classifyGpuTierFromVram(inferred),
      gpuMemGB: Math.round(inferred / 1024),
      vramNote: 'nvidia-smi 不可用；WMI 显存值溢出，按显卡型号推断'
    }
  }
  return {
    discrete: true,
    gpuName,
    gpuTier: 'unknown',
    gpuMemGB: null,
    vramNote: 'WMI 显存值疑似 uint32 溢出，无法确认显存，请运行 nvidia-smi 复核'
  }
}

function runCommand(file: string, args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      file,
      args,
      { timeout: timeoutMs, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(error)
          return
        }
        resolve(String(stdout))
      }
    )
  })
}

/** 与 detectHardware 不同：这里绝不拿系统内存冒充显存。 */
function bareHardware(): HardwareInfo {
  const memGB = totalmem() / 1024 ** 3
  return {
    platform: platform(),
    totalMemGB: Math.round(memGB * 10) / 10,
    cpuCount: cpus().length,
    gpuTier: 'cpu-only',
    gpuMemGB: null
  }
}

/**
 * 真实硬件探测：优先 nvidia-smi 精确显存 → Windows WMI 回退 → 如实 cpu-only。
 * 保留同步 detectHardware(override) 供旧单测与显式覆盖使用，二者互不干扰。
 */
export async function probeRealHardware(): Promise<RealHardwareInfo> {
  const base = bareHardware()
  if (platform() === 'darwin' && process.arch === 'arm64') {
    return {
      ...base,
      gpuTier: 'apple-silicon',
      gpuMemGB: Math.round(base.totalMemGB),
      gpuName: 'Apple Silicon（统一内存）',
      source: 'apple-silicon'
    }
  }

  try {
    const out = await runCommand(
      'nvidia-smi',
      ['--query-gpu=name,memory.total', '--format=csv,noheader,nounits'],
      3_000
    )
    const first = out.trim().split(/\r?\n/)[0] ?? ''
    const [name, mem] = first.split(',').map((part) => part.trim())
    const vramMB = Number(mem)
    if (name && Number.isFinite(vramMB) && vramMB > 0) {
      return {
        ...base,
        gpuTier: classifyGpuTierFromVram(vramMB),
        gpuMemGB: Math.round(vramMB / 1024),
        gpuName: name,
        source: 'nvidia-smi'
      }
    }
  } catch {
    // 无 N 卡 / 驱动未装 / 命令不存在，继续回退
  }

  if (process.platform === 'win32') {
    try {
      const out = await runCommand(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          'Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM | ConvertTo-Json -Compress'
        ],
        5_000
      )
      const parsed = JSON.parse(out) as unknown
      const list = Array.isArray(parsed) ? parsed : [parsed]
      // 远程桌面/虚拟显示器（Oray、GameViewer）也会混进 WMI 列表，只认独显。
      for (const controller of list as Array<{ Name?: unknown; AdapterRAM?: unknown }>) {
        const assessment = assessWmiGpu(
          String(controller?.Name ?? ''),
          Number(controller?.AdapterRAM ?? 0)
        )
        if (!assessment.discrete) continue
        return {
          ...base,
          gpuTier: assessment.gpuTier,
          gpuMemGB: assessment.gpuMemGB,
          gpuName: assessment.gpuName,
          source: 'wmi',
          ...(assessment.vramNote ? { vramNote: assessment.vramNote } : {})
        }
      }
    } catch {
      // WMI 不可用时如实判定 cpu-only
    }
  }

  return { ...base, gpuTier: 'cpu-only', gpuMemGB: null, source: 'fallback' }
}

/**
 * 探测本地推理引擎：先试 /health 拿详细状态，失败回退到 /v1/models。
 * 官方 README 承诺的是 http://127.0.0.1:8080/v1（OpenAI 兼容）与 8080 Web UI，
 * 并没有承诺 /health 一定存在，所以只依赖 /health 会把「在线」误报成「未启动」。
 */
export async function probePolyStrataHealth(
  baseUrl = 'http://127.0.0.1:8080'
): Promise<LocalEngineHealth> {
  const root = baseUrl.replace(/\/+$/, '')
  let lastError = ''
  for (const path of ['/health', '/v1/models'] as const) {
    try {
      const response = await fetch(`${root}${path}`, {
        signal: AbortSignal.timeout(2_000)
      })
      if (!response.ok) {
        lastError = `HTTP ${response.status}`
        continue
      }
      if (path === '/v1/models') {
        const data = (await response.json().catch(() => ({}))) as {
          data?: Array<{ id?: string }>
        }
        return {
          running: true,
          model: data.data?.[0]?.id,
          source: 'models',
          note: `/health 不可用（${lastError || '未知原因'}），已回退 /v1/models 探测`
        }
      }
      const data = (await response.json()) as Record<string, unknown>
      return {
        running: true,
        loaded: typeof data.loaded === 'boolean' ? data.loaded : undefined,
        model: typeof data.model === 'string' ? data.model : undefined,
        maxContext:
          typeof data.max_context === 'number'
            ? data.max_context
            : typeof data.maxContext === 'number'
              ? data.maxContext
              : undefined,
        images: typeof data.images === 'boolean' ? data.images : undefined,
        source: 'health'
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
  }
  return {
    running: false,
    error: `本地引擎未启动或不可达（最后错误：${lastError || '未知'}）`
  }
}

/** 通用别名：设置页不必关心具体引擎名。 */
export const probeLocalEngineHealth = probePolyStrataHealth

/** 真题验活：发一个 16 token 上限的真实问题，收到非空回答才算就绪。 */
export async function verifyLocalModelReady(
  baseUrl: string,
  model: string,
  apiKey?: string
): Promise<LocalModelVerifyResult> {
  const startedAt = Date.now()
  const root = baseUrl.replace(/\/+$/, '')
  const endpoint = /\/v1$/.test(root)
    ? `${root}/chat/completions`
    : `${root}/v1/chat/completions`
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {})
      },
      body: JSON.stringify({
        model,
        messages: [{ role: 'user', content: 'Reply with the single word READY.' }],
        max_tokens: 16,
        temperature: 0,
        stream: false
      }),
      signal: AbortSignal.timeout(30_000)
    })
    const latencyMs = Date.now() - startedAt
    if (!response.ok) {
      return { ok: false, latencyMs, error: `HTTP ${response.status}` }
    }
    const data = (await response.json()) as {
      choices?: Array<{ message?: { content?: string }; text?: string }>
    }
    const reply = String(data.choices?.[0]?.message?.content ?? data.choices?.[0]?.text ?? '').trim()
    return reply
      ? { ok: true, latencyMs, reply: reply.slice(0, 200) }
      : { ok: false, latencyMs, error: '模型返回了空回答，未通过真题验活' }
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - startedAt,
      error: error instanceof Error ? error.message : String(error)
    }
  }
}
