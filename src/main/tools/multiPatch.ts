import { readFile, writeFile } from 'node:fs/promises'
import { z } from 'zod'
import type { ToolDefinition, ToolHost } from './index'

interface PatchReplacement {
  targetContent: string
  replacementContent: string
}

/** 先全部在内存中验证并替换，任何一处失败都不触碰磁盘。 */
export function applyMultiPatch(raw: string, replacements: PatchReplacement[]): string {
  let updated = raw
  for (let index = 0; index < replacements.length; index++) {
    const { targetContent, replacementContent } = replacements[index]
    const count = updated.split(targetContent).length - 1
    if (count === 0) {
      throw new Error(`第 ${index + 1} 处补丁未找到目标内容，文件未修改。`)
    }
    if (count > 1) {
      throw new Error(`第 ${index + 1} 处补丁匹配到 ${count} 个位置，文件未修改。请提供更多上下文保证唯一性。`)
    }
    updated = updated.replace(targetContent, () => replacementContent)
  }
  return updated
}

export function createMultiPatchFileTool(host: ToolHost): ToolDefinition {
  return {
    name: 'multi_patch_file',
    description:
      '对同一个文本文件做多处精确替换。所有补丁都匹配成功后才一次性写盘；任一处缺失或匹配不唯一则整体失败，文件保持不变。',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: '文件路径，相对路径基于项目目录解析' },
        replacements: {
          type: 'array',
          description: '按顺序执行的替换列表',
          items: {
            type: 'object',
            properties: {
              targetContent: { type: 'string', description: '要被替换的原文本，必须唯一匹配' },
              replacementContent: { type: 'string', description: '替换后的文本' }
            },
            required: ['targetContent', 'replacementContent']
          }
        }
      },
      required: ['path', 'replacements']
    },
    requiresApproval: true,
    approvalReason: '将对本地代码文件进行多处精确修改，只有全部匹配成功才会写盘。',
    async execute(input, context) {
      const { path, replacements } = z
        .object({
          path: z.string().min(1),
          replacements: z
            .array(
              z.object({
                targetContent: z.string(),
                replacementContent: z.string()
              })
            )
            .min(1)
        })
        .parse(input)

      const target = host.resolveUserPath(context, path)
      host.guardPrivatePath(target)
      const raw = await readFile(target, 'utf8')
      const updated = applyMultiPatch(raw, replacements)
      await writeFile(target, updated, 'utf8')
      return `已成功对 ${target} 应用 ${replacements.length} 处精确补丁。`
    }
  }
}
