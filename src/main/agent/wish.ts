import type { AutonomousTask, Lesson } from '../../shared/types'

export interface WishPromptOptions {
  task: Pick<AutonomousTask, 'name' | 'prompt' | 'acceptance' | 'workingDir' | 'verifyCommand' | 'maxSteps'>
  lessons: Lesson[]
  retry?: { attempt: number; output: string }
}

/**
 * 许愿模式的提示词只做三件事：锁目标、给验收、要求闭环。
 * 它不授予额外权限；能否自动执行由 runtime 的 wish 模式策略裁决。
 */
export function resolveWishPrompt(options: WishPromptOptions): string {
  const { task, lessons, retry } = options
  const parts = [
    '【许愿任务】',
    `目标：${task.prompt.trim()}`,
    task.acceptance.trim() ? `验收标准：\n${task.acceptance.trim()}` : '验收标准：以构建、测试、类型检查与需求一致性为准。',
    `工作区：${task.workingDir}`,
    task.verifyCommand.trim()
      ? `最终验收命令：${task.verifyCommand.trim()}（主进程会在你完成后真实执行）`
      : '未配置验收命令：完成后必须自己运行可用的构建/测试，并在结论中列出实际命令与结果。',
    `执行预算：最多 ${task.maxSteps} 步。不要为了“看起来完成”而跳过验证。`
  ]

  if (lessons.length > 0) {
    parts.push(
      '【项目经验（已验证，优先复用）】',
      ...lessons.map((lesson, index) => `${index + 1}. ${lesson.title}\n${lesson.content}`)
    )
  }

  if (retry) {
    parts.push(
      `【自动修复第 ${retry.attempt} 次】`,
      '上一轮实现没有通过真实验收。请先读错误、定位根因，再修改；不要重复提交同样的改法。',
      '验收输出：',
      retry.output.slice(0, 12_000)
    )
  }

  parts.push(
    '【完成协议】',
    '1. 先检查仓库结构与现有约定，再动手；',
    '2. 改动必须落在工作区内，优先小步 patch，一次只改一个文件；',
    '3. 每轮改完立即运行最相关的测试/类型检查/构建；',
    '4. 失败就自己读错误并修复，不要停下来等用户批准；',
    '5. 最终回复必须给出：改动摘要、验证命令与结果、未解决风险、回滚方式。'
  )

  return parts.join('\n\n')
}
