import type { AgentMode, UsageMode } from '../../shared/types'

export interface WorkModeContext {
  /** 本轮发送时侧边栏选择的工作视图；旧消息/无记录时为 null。 */
  workMode: UsageMode | null
  /** 会话绑定的工程目录；未绑定为 null。 */
  workingDirectory: string | null
  /** 本轮是否被只读复查降级：为真时不允许写文件与跑命令。 */
  readOnly: boolean
  /** 本轮生效的 Agent 模式：chat 只讨论不落盘，不能被视图指令反向放开。 */
  conversationMode: AgentMode
}

/**
 * 把「协同 / 代码」视图翻译成系统提示里的行为倾向。
 *
 * 为什么放在提示词层而不是工具层：
 * - 视图模式表达的是「用户希望以什么方式协作」，不是权限。权限由自治等级与安全分级
 *   负责，视图模式绝不能顺手改放行范围，否则用户切个视图就悄悄放宽了审批。
 * - 所以这里只影响表达与默认动作顺序，不新增、不放开任何工具。
 *
 * null 一律不注入：历史消息没有记录当时的选择，猜测会污染上下文。
 */
export function buildWorkModeDirective(ctx: WorkModeContext): string {
  const { workMode, workingDirectory, readOnly, conversationMode } = ctx
  if (workMode !== 'cowork' && workMode !== 'code') return ''

  // chat 模式只讨论不落盘：视图只能改表达风格，不能把“动手”塞回来。
  const discussionOnly = conversationMode === 'chat'

  if (workMode === 'cowork') {
    const lines = [
      '',
      '【协同视图】当前是协同视图：边做边讲，让用户能跟上你的判断。',
      '- 每完成一步（查、改、跑）用一两句话说明意图与影响，不要一口气甩出大段结论。',
      '- 需要取舍时直接选最合理的默认值继续做，但在结果里点名这条假设，不要停下来等确认。'
    ]
    if (!discussionOnly) {
      lines.push('- 协同不等于只出主意：能查证的就查证，能改的就改，不要用建议代替执行。')
    }
    return lines.join('\n')
  }

  // code 视图：以代码与命令为第一语言。只读复查 / 纯讨论时保留“代码视角”，但明确不许动手。
  let action: string
  if (discussionOnly) {
    action = '- 当前是纯讨论模式：给出精确到「文件:行号」的改法与代码片段即可，不要写入或执行命令。'
  } else if (readOnly) {
    action = '- 当前是只读复查：给出精确到「文件:行号」的问题与改法，不要尝试写入或执行命令。'
  } else {
    action = '- 直接动手改文件（优先 patch_file 局部改），少写铺垫与客套；结论用「文件:行号 + 改了什么 + 为什么」表达。'
  }
  const lines = [
    '',
    '【代码视图】当前是代码视图：以代码、路径与命令为第一语言。',
    action,
    '- 命令给出可直接复制的完整形式，并说明预期输出；跑完贴真实输出摘要，不要凭记忆转述。',
    '- 排版优先短句与代码块，不写大段散文式解释。'
  ]
  if (!workingDirectory && !readOnly && !discussionOnly) {
    lines.push('- 当前会话未绑定工程目录：涉及文件与命令时先显式确认目录，或给出完整路径，不要假设一个默认目录。')
  }
  return lines.join('\n')
}
