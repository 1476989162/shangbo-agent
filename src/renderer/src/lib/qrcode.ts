/**
 * 轻量二维码生成器（QR Code Model 2，Byte 模式，EC Level M）。
 * 不引入第三方库：配对二维码内容约 300 字节，自动选版本 1–10。
 * Reed-Solomon 基于 GF(256)，掩码按惩罚规则 8 选最优——标准流程的最小可用子集，
 * 只服务于"手机扫码配对"这一内部场景，不做通用库。
 */

const EXP_TABLE = new Array(512)
const LOG_TABLE = new Array(256)
;(() => {
  let x = 1
  for (let i = 0; i < 255; i++) {
    EXP_TABLE[i] = x
    LOG_TABLE[x] = i
    x <<= 1
    if (x & 0x100) x ^= 0x11d
  }
  for (let i = 255; i < 512; i++) EXP_TABLE[i] = EXP_TABLE[i - 255]
})()

function gfMul(a: number, b: number): number {
  if (a === 0 || b === 0) return 0
  return EXP_TABLE[LOG_TABLE[a] + LOG_TABLE[b]]
}

/** 生成 ecCount 个纠错码字。 */
function rsEncode(data: number[], ecCount: number): number[] {
  let generator = [1]
  for (let i = 0; i < ecCount; i++) {
    const next = new Array(generator.length + 1).fill(0)
    for (let j = 0; j < generator.length; j++) {
      next[j] ^= gfMul(generator[j], EXP_TABLE[i])
      next[j + 1] ^= generator[j]
    }
    generator = next
  }
  const result = new Array(ecCount).fill(0)
  for (const byte of data) {
    const factor = byte ^ (result.shift() ?? 0)
    result.push(0)
    for (let j = 0; j < ecCount; j++) {
      result[j] ^= gfMul(generator[j + 1], factor)
    }
  }
  return result
}

const ECC_CODEWORDS = [10, 16, 26, 18, 24, 16, 18, 22, 22, 26]
const TOTAL_CODEWORDS = [26, 44, 70, 100, 134, 172, 196, 242, 292, 346]
const ALIGNMENT_POS: number[][] = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50]
]

function utf8Bytes(text: string): number[] {
  return [...new TextEncoder().encode(text)]
}

/** 选能装下 text 的最小版本（1–10），装不下抛错。 */
function pickVersion(dataLen: number): number {
  const bitsNeeded = 4 + 8 + dataLen * 8
  for (let v = 1; v <= 10; v++) {
    const capacity = (TOTAL_CODEWORDS[v - 1] - ECC_CODEWORDS[v - 1]) * 8
    if (capacity >= bitsNeeded) return v
  }
  throw new Error('配对内容过长，无法生成二维码（上限约 270 字节）')
}

function buildMatrix(version: number, data: number[]): boolean[][] {
  const size = version * 4 + 17
  const matrix: (boolean | null)[][] = Array.from({ length: size }, () => new Array(size).fill(null))
  const reserved: boolean[][] = Array.from({ length: size }, () => new Array(size).fill(false))

  const set = (r: number, c: number, v: boolean, func = true): void => {
    matrix[r][c] = v
    if (func) reserved[r][c] = true
  }

  // 寻像图形 + 分隔带
  const finder = (r: number, c: number): void => {
    for (let dr = -1; dr <= 7; dr++) {
      for (let dc = -1; dc <= 7; dc++) {
        const rr = r + dr
        const cc = c + dc
        if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue
        if (dr >= 0 && dr <= 6 && dc >= 0 && dc <= 6) {
          const onBorder = dr === 0 || dr === 6 || dc === 0 || dc === 6
          const inCore = dr >= 2 && dr <= 4 && dc >= 2 && dc <= 4
          set(rr, cc, onBorder || inCore)
        } else {
          set(rr, cc, false)
        }
      }
    }
  }
  finder(0, 0)
  finder(0, size - 7)
  finder(size - 7, 0)

  // 校准图形
  for (const r of ALIGNMENT_POS[version - 1] ?? []) {
    for (const c of ALIGNMENT_POS[version - 1] ?? []) {
      if (matrix[r][c] !== null) continue
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          const edge = Math.max(Math.abs(dr), Math.abs(dc)) === 2
          set(r + dr, c + dc, edge || (dr === 0 && dc === 0))
        }
      }
    }
  }

  // 时序带
  for (let i = 8; i < size - 8; i++) {
    if (matrix[6][i] === null) set(6, i, i % 2 === 0)
    if (matrix[i][6] === null) set(i, 6, i % 2 === 0)
  }
  // 暗模块
  set(size - 8, 8, true)

  // 数据填充（Z 字形上行），跳过功能区
  const bits: number[] = []
  for (const byte of data) {
    for (let i = 7; i >= 0; i--) bits.push((byte >> i) & 1)
  }
  let bitIdx = 0
  const nextBit = (): boolean => (bitIdx < bits.length ? bits[bitIdx++] === 1 : false)
  let upward = true
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--
    for (let i = 0; i < size; i++) {
      const row = upward ? size - 1 - i : i
      for (const c of [col, col - 1]) {
        if (matrix[row][c] === null) set(row, c, nextBit(), false)
      }
    }
    upward = !upward
  }

  // 掩码（8 选最优：惩罚规则 N1+N2 简化版）
  const maskFns = [
    (r: number, c: number) => (r + c) % 2 === 0,
    (r: number) => r % 2 === 0,
    (_r: number, c: number) => c % 3 === 0,
    (r: number, c: number) => (r + c) % 3 === 0,
    (r: number, c: number) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r: number, c: number) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r: number, c: number) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r: number, c: number) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0
  ]
  let best = 0
  let bestScore = Infinity
  let bestMatrix: boolean[][] = matrix as boolean[][]
  for (let m = 0; m < 8; m++) {
    const trial = matrix.map((row) => [...row]) as boolean[][]
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (!reserved[r][c] && maskFns[m](r, c)) trial[r][c] = !trial[r][c]
      }
    }
    // N1：连续 5+ 同色惩罚；N2：2x2 同色块惩罚
    let score = 0
    for (let r = 0; r < size; r++) {
      let run = 1
      for (let c = 1; c < size; c++) {
        if (trial[r][c] === trial[r][c - 1]) {
          run++
        } else {
          if (run >= 5) score += 3 + (run - 5)
          run = 1
        }
      }
      if (run >= 5) score += 3 + (run - 5)
    }
    for (let c = 0; c < size; c++) {
      let run = 1
      for (let r = 1; r < size; r++) {
        if (trial[r][c] === trial[r - 1][c]) {
          run++
        } else {
          if (run >= 5) score += 3 + (run - 5)
          run = 1
        }
      }
      if (run >= 5) score += 3 + (run - 5)
    }
    for (let r = 0; r < size - 1; r++) {
      for (let c = 0; c < size - 1; c++) {
        const v = trial[r][c]
        if (trial[r + 1][c] === v && trial[r][c + 1] === v && trial[r + 1][c + 1] === v) score += 3
      }
    }
    if (score < bestScore) {
      bestScore = score
      best = m
      bestMatrix = trial
    }
  }

  // 格式信息（EC M + 掩码 best），BCH(15,5)
  const FORMAT_DATA = [
    [0x0, 0x1, 0x2, 0x3, 0x4, 0x5, 0x6, 0x7],
    [0x8, 0x9, 0xa, 0xb, 0xc, 0xd, 0xe, 0xf],
    [0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17]
  ]
  void FORMAT_DATA
  const ecBits = 0b00 // M
  const formatValue = (ecBits << 3) | best
  let formatBits = formatValue << 10
  const GEN = 0b10100110111
  for (let i = 14; i >= 10; i--) {
    if (formatBits & (1 << i)) formatBits ^= GEN << (i - 10)
  }
  const format = ((formatValue << 10) | (formatBits & 0x3ff)) ^ 0b101010000010010
  const putFormat = (r: number, c: number, bit: number): void => {
    bestMatrix[r][c] = bit === 1
  }
  for (let i = 0; i <= 5; i++) putFormat(8, i, (format >> i) & 1)
  putFormat(8, 7, (format >> 6) & 1)
  putFormat(8, 8, (format >> 7) & 1)
  putFormat(7, 8, (format >> 8) & 1)
  for (let i = 9; i <= 14; i++) putFormat(14 - i, 8, (format >> i) & 1)
  for (let i = 0; i < 8; i++) putFormat(size - 1 - i, 8, (format >> i) & 1)
  for (let i = 8; i < 15; i++) putFormat(8, size - 15 + i, (format >> i) & 1)

  return bestMatrix
}

/** 生成二维码矩阵（true=黑）。EC Level M，Byte 模式，版本自动。 */
export function makeQrMatrix(text: string): boolean[][] {
  const bytes = utf8Bytes(text)
  const version = pickVersion(bytes.length)
  const ecCount = ECC_CODEWORDS[version - 1]
  const dataCapacity = TOTAL_CODEWORDS[version - 1] - ecCount

  // 位流：模式(0100) + 字符数(8bit) + 数据 + 终止符 + 补齐
  const bits: number[] = []
  const push = (val: number, len: number): void => {
    for (let i = len - 1; i >= 0; i--) bits.push((val >> i) & 1)
  }
  push(0b0100, 4)
  push(bytes.length, 8)
  for (const b of bytes) push(b, 8)
  const cap = dataCapacity * 8
  const termLen = Math.min(4, cap - bits.length)
  push(0, termLen)
  while (bits.length % 8 !== 0) bits.push(0)
  const dataWords: number[] = []
  for (let i = 0; i < bits.length; i += 8) {
    let w = 0
    for (let j = 0; j < 8; j++) w = (w << 1) | bits[i + j]
    dataWords.push(w)
  }
  let pad = 0xec
  while (dataWords.length < dataCapacity) {
    dataWords.push(pad)
    pad = pad === 0xec ? 0x11 : 0xec
  }
  const ecWords = rsEncode(dataWords, ecCount)
  return buildMatrix(version, [...dataWords, ...ecWords])
}

/** 把二维码画到 canvas（白底黑块，静区 4 模块）。返回是否成功。 */
export function drawQr(canvas: HTMLCanvasElement, text: string, scale = 6): boolean {
  try {
    const matrix = makeQrMatrix(text)
    const size = matrix.length
    const quiet = 4
    const total = size + quiet * 2
    canvas.width = total * scale
    canvas.height = total * scale
    const ctx = canvas.getContext('2d')
    if (!ctx) return false
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, canvas.width, canvas.height)
    ctx.fillStyle = '#000000'
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (matrix[r][c]) ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale)
      }
    }
    return true
  } catch {
    return false
  }
}
