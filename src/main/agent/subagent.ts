import { isAbsolute, resolve } from 'node:path'
import { z } from 'zod'
import type { ContentBlock } from '../../shared/types'
import type { CompletionRequest, LLMMessage, StreamChunk, ToolSchema } from '../providers/types'
import { callSignature, detectStuck, type ToolRecord } from './loopGuard'

/**
 * Antigravity 式子智能体：主循环把可并行、可独立的子任务派出去，
 * 子循环跑完把结论一次性带回来，父循环负责汇总。
 *
 * 完整能力：
 * - 并行派发（父循环的并行执行器天然支持一次多派）。
 * - 写任务隔离：git 仓库内默认进独立 worktree 跑，脏了就地保留分支给人验收，
 *   干净则静默回收；只读任务与非 git 目录直接原地跑。
 * - 进度可见：起止与结论都以文本通知回到父消息（零渲染改动），另发类型化事件
 *   供将来的子任务面板使用。
 * 安全边界全部继承父回合：同一审批流、同一停止信号，子循环看不到 spawn
 * 工具所以深度天然为 1，数据库 schema 零改动。
 */

export const SPAWN_TOOL_NAME = 'spawn_subagent'

export const SPAWN_SUBAGENT_SCHEMA: ToolSchema = {
  name: SPAWN_TOOL_NAME,
  description:
    '派一个子智能体并行处理独立子任务（侦察某模块、复查某目录、改造独立文件）。任务之间无依赖时可一次派多个。子任务完成后只返回结论摘要，由你汇总。',
  parameters: {
    type: 'object',
    properties: {
      task: { type: 'string', description: '子任务描述，越具体越好：目标、范围、交付什么样的结论' },
      scopeDir: { type: 'string', description: '子任务的工作目录，缺省与当前对话相同' }
    },
    required: ['task']
  }
}

const MAX_RESULT_CHARS = 6_000

const SUBAGENT_SYSTEM = `你是子智能体：只完成派给你的单个任务，然后给出简短结论。
硬规则：
- 先读/先搜再下结论，不猜。
- 只读任务不要写文件；改造任务一次只改一个文件，优先局部替换。
- 结束时直接给结论（发现了什么 / 改了什么 / 没改成的原因），不要铺垫。`

export interface SubagentCallbacks {
  model: string
  providerId?: string | null
  workingDirectory: string | null
  readOnly: boolean
  maxTokens?: number
  reasoningEffort?: string
  signal: AbortSignal
  /** 派给子循环的工具清单（由父回合组装：已剔除 spawn，只读模式已过滤）。 */
  schemas: ToolSchema[]
  /** 打转灵敏度（与父回合同一套保险丝），缺省 3。 */
  stuckLimit?: number
  stream(
    request: CompletionRequest,
    signal: AbortSignal,
    preferredProviderId?: string | null
  ): AsyncGenerator<StreamChunk>
  invokeTool(
    call: { id: string; name: string; input: unknown },
    /** 子任务实际工作目录（worktree 隔离时是独立路径，原地跑时是 scope）。 */
    workDir: string | null
  ): Promise<{ content: string; isError: boolean; image?: { mimeType: string; dataUrl: string } }>
  /**
   * 写任务隔离：在独立 worktree 里跑，返回收尾函数。只读任务返回 null 原地跑。
   * finalize 负责判定脏净：干净则回收并说明，脏则保留分支与路径给人验收。
   */
  isolate?(scopeDir: string | null): Promise<{
    workDir: string
    describe: string
    finalize: () => Promise<string>
  } | null>
  /** 进度通知（起止与关键节点），父回合负责落到界面。 */
  notify?(text: string): void
}

function truncate(text: string): string {
  if (text.length <= MAX_RESULT_CHARS) return text
  return `${text.slice(0, MAX_RESULT_CHARS)}\n\n…（子任务结论过长已截断，共 ${text.length} 字符）`
}

function resolveScope(base: string | null, scopeDir?: string): string | null {
  if (!scopeDir) return base
  if (isAbsolute(scopeDir)) return scopeDir
  return base ? resolve(base, scopeDir) : resolve(scopeDir)
}

export async function runSubagent(input: unknown, ctx: SubagentCallbacks): Promise<{ content: string; isError: boolean }> {
  const parsed = z
    .object({
      task: z.string().min(1, '请给出子任务描述 task'),
      scopeDir: z.string().optional()
    })
    .safeParse(input ?? {})
  if (!parsed.success) {
    return { content: `派子任务失败：${parsed.error.issues[0]?.message ?? '参数非法'}`, isError: true }
  }

  const scope = resolveScope(ctx.workingDirectory, parsed.data.scopeDir)
  ctx.notify?.(`🛰 子任务开始：${parsed.data.task}`)
  const isolation = ctx.readOnly ? null : await ctx.isolate?.(scope)
  const workDir = isolation?.workDir ?? scope
  const system = `${SUBAGENT_SYSTEM}${workDir ? `\n\n工作目录：${workDir}。相对路径基于它解析。` : ''}${
    ctx.readOnly ? '\n\n【只读】只允许读取与搜索，禁止写入与执行命令。' : ''
  }${isolation ? `\n\n你在独立工作区（${isolation.describe}）里改代码，不用担心和别人的改动冲突。` : ''}`

  const messages: LLMMessage[] = [
    { role: 'user', blocks: [{ type: 'text', text: parsed.data.task } as ContentBlock] }
  ]
  let finalText = ''
  let lastStop = 'stop'
  let stuckNote = ''
  const history: ToolRecord[] = []
  const limit = ctx.stuckLimit && ctx.stuckLimit > 0 ? ctx.stuckLimit : 3

  // 无步数上限：跑到模型不再调工具为止；只在打转（连续失败/重复调用）时停。
  for (;;) {
    if (ctx.signal.aborted) return { content: '子任务被用户停止。', isError: true }

    const toolUses: { id: string; name: string; input: unknown }[] = []
    let stopReason = 'stop'
    for await (const chunk of ctx.stream(
      { model: ctx.model, system, messages, tools: ctx.schemas, maxTokens: ctx.maxTokens, reasoningEffort: ctx.reasoningEffort },
      ctx.signal,
      ctx.providerId
    )) {
      if (chunk.type === 'text') finalText += chunk.text
      else if (chunk.type === 'tool_use') toolUses.push({ id: chunk.id, name: chunk.name, input: chunk.input })
      else if (chunk.type === 'stop') stopReason = chunk.reason
    }
    lastStop = stopReason
    if (toolUses.length === 0) break

    const results: { content: string; isError: boolean }[] = []
    for (const call of toolUses) {
      const result = await ctx.invokeTool(call, workDir)
      results.push(result)
      const resultBlock: ContentBlock = {
        type: 'tool_result',
        toolUseId: call.id,
        content: result.content,
        isError: result.isError,
        ...(result.image ? { image: result.image } : {})
      }
      const useBlock: ContentBlock = { type: 'tool_use', id: call.id, name: call.name, input: call.input }
      messages.push({ role: 'assistant', blocks: [useBlock] })
      messages.push({ role: 'tool', blocks: [resultBlock] })
    }
    for (let i = 0; i < toolUses.length; i++) {
      history.push({ sig: callSignature(toolUses[i].name, toolUses[i].input), isError: results[i].isError })
    }
    const stuck = detectStuck(history, limit)
    if (stuck) {
      stuckNote = `\n\n（${stuck}）`
      break
    }
  }

  const exhausted = lastStop === 'length' || lastStop === 'max_tokens'
  const tail = `${exhausted ? '\n\n（子循环预算用尽，结论可能不完整。）' : ''}${stuckNote}`
  const body = finalText.trim() ? truncate(finalText.trim()) : '（子任务没有留下文字结论，请看工具执行情况或换个问法重派。）'
  const isolationReport = isolation ? `\n\n${await isolation.finalize()}` : ''
  ctx.notify?.(`✅ 子任务完成：${parsed.data.task}`)
  return { content: `【子任务结论】${parsed.data.task}\n\n${body}${tail}${isolationReport}`, isError: false }
}
