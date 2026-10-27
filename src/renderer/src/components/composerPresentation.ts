/** 输入区与主进程保持一致的图片约束。 */
export const MAX_IMAGE_COUNT = 8
export const MAX_IMAGE_BYTES = 6 * 1024 * 1024
export const IMAGE_MIME_RE = /^image\/(png|jpeg|jpg|webp|gif|bmp)$/i

/** 上下文用量徽标：1M / 200K / 128K。 */
export function formatTokensK(tokens: number): string {
  if (tokens >= 1_000_000) {
    return (tokens / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M'
  }
  if (tokens >= 1_000) {
    return (tokens / 1_000).toFixed(1).replace(/\.0$/, '') + 'k'
  }
  return String(tokens)
}

/** 按模型名推断上下文上限；未知模型回落到 128K。 */
export function resolveModelContextLimit(modelName: string): number {
  const model = modelName.toLowerCase()
  if (
    model.includes('sensenova') ||
    model.includes('sensecore') ||
    model.includes('spark') ||
    model.includes('1m') ||
    model.includes('kimi') ||
    model.includes('moonshot') ||
    model.includes('qwen-long') ||
    model.includes('glm-4-long') ||
    model.includes('gemini-1.5') ||
    model.includes('gemini-2')
  ) {
    return 1_000_000
  }
  if (
    model.includes('claude-3-5') ||
    model.includes('claude-3-7') ||
    model.includes('sonnet') ||
    model.includes('opus')
  ) {
    return 200_000
  }
  return 128_000
}
