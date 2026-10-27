import qrcode from 'qrcode-generator'

/**
 * 生成二维码矩阵（true=黑）。EC Level M，Byte 模式，版本自动。
 *
 * 二维码编码包含大量纠错、掩码和格式信息细节，使用经过验证的
 * qrcode-generator，避免手写实现出现"能识别定位角但内容解不出来"的问题。
 */
export function makeQrMatrix(text: string): boolean[][] {
  const qr = qrcode(0, 'M')
  qr.addData(text, 'Byte')
  qr.make()
  const size = qr.getModuleCount()
  return Array.from({ length: size }, (_, row) =>
    Array.from({ length: size }, (_, col) => qr.isDark(row, col))
  )
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
    for (let row = 0; row < size; row++) {
      for (let col = 0; col < size; col++) {
        if (matrix[row][col]) {
          ctx.fillRect((col + quiet) * scale, (row + quiet) * scale, scale, scale)
        }
      }
    }
    return true
  } catch {
    return false
  }
}
