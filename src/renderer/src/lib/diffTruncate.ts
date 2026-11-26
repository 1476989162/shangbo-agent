/** 超大 git diff 保护：行数与字符数双上限，超了就截断并给可读提示。 */
export const GIT_DIFF_MAX_LINES = 2000
export const GIT_DIFF_MAX_CHARS = 200_000

export interface TruncatedDiff {
  lines: string[]
  totalLines: number
  truncated: boolean
}

/** 按行截断 diff；返回展示行 + 是否被截断 + 原总行数。 */
export function truncateGitDiff(diffText: string): TruncatedDiff {
  if (!diffText) return { lines: [], totalLines: 0, truncated: false }
  const allLines = diffText.split('\n')
  let lines = allLines
  let truncated = false
  if (lines.length > GIT_DIFF_MAX_LINES) {
    lines = lines.slice(0, GIT_DIFF_MAX_LINES)
    truncated = true
  }
  let chars = 0
  let cutAt = lines.length
  for (let i = 0; i < lines.length; i++) {
    // +1 计入换行符
    chars += lines[i].length + 1
    if (chars > GIT_DIFF_MAX_CHARS) {
      cutAt = i + 1
      truncated = true
      break
    }
  }
  if (cutAt < lines.length) lines = lines.slice(0, cutAt)
  return { lines, totalLines: allLines.length, truncated }
}
