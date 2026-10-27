import { glob, stat } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import type { ToolDefinition, ToolHost } from './index'

const MAX_RESULTS = 500
const IGNORED_DIRECTORIES = new Set(['node_modules', '.git', 'out', 'dist'])

/** glob 返回的是相对 cwd 的路径，这里统一换成正斜杠便于模型跨平台使用。 */
function toDisplayPath(root: string, match: string): string {
  return relative(root, resolve(root, match)).split(sep).join('/')
}

function isIgnoredPath(path: string): boolean {
  return path.split(/[\\/]/).some((segment) => IGNORED_DIRECTORIES.has(segment))
}

export function createGlobFilesTool(host: ToolHost): ToolDefinition {
  return {
    name: 'glob_files',
    description:
      '按 glob 模式查找文件，例如 src/**/*.ts。自动忽略 node_modules、.git、out、dist，最多返回 500 条。',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'glob 模式，例如 src/**/*.ts' },
        path: { type: 'string', description: '搜索起点目录，缺省为当前项目目录' }
      },
      required: ['pattern']
    },
    requiresApproval: false,
    async execute(input, context) {
      const { pattern, path } = z
        .object({
          pattern: z.string().min(1),
          path: z.string().min(1).optional()
        })
        .parse(input)

      const root = host.resolveUserPath(context, path ?? '.')
      host.guardPrivatePath(root)

      try {
        const rootStat = await stat(root)
        if (!rootStat.isDirectory()) {
          throw new Error(`路径 ${root} 是文件不是目录：glob_files 的 path 必须传目录。`)
        }
      } catch (error) {
        if (error instanceof Error && error.message.includes('是文件不是目录')) throw error
        throw new Error(`无法访问搜索目录 ${root}：${error instanceof Error ? error.message : String(error)}`)
      }

      const matches: string[] = []
      let truncated = false
      for await (const match of glob(pattern, {
        cwd: root,
        // 这里返回字符串路径；最终过滤仍按路径段再做一遍，兼容不同 Node 重载。
        exclude: (entry) =>
          IGNORED_DIRECTORIES.has(String(entry).split(/[\\/]/).pop() ?? '')
      })) {
        if (context.signal.aborted) throw new Error('操作已取消')
        const display = toDisplayPath(root, String(match))
        if (isIgnoredPath(display)) continue
        matches.push(display)
        if (matches.length >= MAX_RESULTS) {
          truncated = true
          break
        }
      }

      matches.sort((a, b) => a.localeCompare(b))
      if (matches.length === 0) return `在 ${root} 未找到匹配 ${pattern} 的文件。`
      const suffix = truncated ? `\n\n…（结果达到 ${MAX_RESULTS} 条上限，请收窄 pattern 或 path）` : ''
      return host.truncate(`在 ${root} 找到 ${matches.length} 个匹配 ${pattern} 的文件：\n${matches.join('\n')}${suffix}`)
    }
  }
}
