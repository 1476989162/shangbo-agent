import { randomUUID } from 'node:crypto'
import log from 'electron-log/main'
import * as repo from '../db/repo'
import { getSetting, setSetting } from '../settings'
import { auditCommandSecurity, toolRegistry } from '../tools'
import { streamWithFallback } from '../providers/gateway'
import { routingOrder } from '../providers/store'
import { buildContext, toLLMMessages } from './context'
import type {
  AgentEvent,
  ApprovalDecision,
  ContentBlock,
  Conversation,
  Message,
  MessageStatus,
  SendPayload,
  Usage
} from '../../shared/types'
import type { LLMMessage } from '../providers/types'

export type Emitter = (event: AgentEvent) => void

/** 单轮最多允许的工具调用步数，防止模型陷入自我循环。默认 15 步，支持在设置中自定义配置。 */
const DEFAULT_MAX_STEPS = 15
const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000
const MAX_OUTPUT_TOKENS = 8_192
const BUDGET_KEY = 'agent.contextBudgetTokens'
const AUTO_APPROVE_KEY = 'tools.autoApprove'

const DEFAULT_SYSTEM_PROMPT = `你是「尚搏 Agent」，一个运行在用户本机的个人助理。

工作方式：
- 需要了解本机文件、执行命令或获取实时信息时，主动调用工具，不要凭空猜测。
- 需要多个信息时可以并行调用多个工具，拿到结果后再给出结论。
- 写入文件、执行命令这类操作会先征求用户确认；被拒绝后不要重复尝试同一个操作。
- 回答用中文，先给结论，再给必要的解释，避免冗长的铺垫。`

const DEFAULT_BUDGET_TOKENS = 32_000

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 合并相邻的同类块，使流式增量落库后仍是一段完整文本而不是上千个碎片。 */
function appendBlock(blocks: ContentBlock[], block: ContentBlock): void {
  const last = blocks[blocks.length - 1]
  if (block.type === 'text' && last?.type === 'text') {
    last.text += block.text
    return
  }
  if (block.type === 'reasoning' && last?.type === 'reasoning') {
    last.text += block.text
    return
  }
  blocks.push(block)
}

function resolveTarget(
  preferredProviderId: string | null | undefined,
  preferredModel: string | null | undefined
): { providerId: string; model: string; providerName: string } {
  const order = routingOrder(preferredProviderId)
  if (order.length === 0) {
    throw new Error('没有可用的模型供应商：请到「设置 → 模型供应商」填入 API Key 并启用。')
  }
  const provider = order[0]
  const model = preferredModel?.trim() || provider.models[0]
  if (!model) {
    throw new Error(`供应商「${provider.name}」还没有配置模型名，请在设置中补充或点击「拉取模型列表」。`)
  }
  return { providerId: provider.id, model, providerName: provider.name }
}

interface PendingApproval {
  toolName: string
  settle: (approved: boolean) => void
}

interface ActiveRun {
  controller: AbortController
  conversationId: string
}

export class AgentRuntime {
  private runs = new Map<string, ActiveRun>()
  private approvals = new Map<string, PendingApproval>()

  /** 同一会话不允许并发两个回合：IPC 是公共边界，不能只靠渲染端防重入。 */
  private assertNoActiveRun(conversationId: string): void {
    if (this.isRunning(conversationId)) {
      throw new Error('该会话已有正在进行的回复，请先等待完成或点击「停止」后再操作。')
    }
  }

  /** 统一的生命周期包装：失败发 run_error，结束必发 run_end（渲染端靠它解锁输入区）。 */
  private async execute(
    runId: string,
    conversationId: string,
    emit: Emitter,
    task: () => Promise<void>
  ): Promise<void> {
    try {
      await task()
    } catch (error) {
      log.error('[agent] 回合失败', error)
      emit({ type: 'run_error', runId, conversationId, messageId: '', error: describeError(error) })
    } finally {
      emit({ type: 'run_end', runId, conversationId })
    }
  }

  /** 发起一次新的对话回合。立即返回 runId，实际执行在微任务中进行。 */
  send(payload: SendPayload, emit: Emitter): { runId: string } {
    this.assertNoActiveRun(payload.conversationId)

    const runId = randomUUID()
    const controller = new AbortController()
    this.runs.set(runId, { controller, conversationId: payload.conversationId })

    // 放到微任务里，确保调用方先拿到 runId 再收到事件
    queueMicrotask(() => {
      void this.execute(runId, payload.conversationId, emit, async () => {
        await this.executeSend(runId, payload, emit, controller)
      }).finally(() => {
        this.runs.delete(runId)
      })
    })

    return { runId }
  }

  /** 重新生成：为同一条用户消息再挂一个助手兄弟节点，形成新的分支。 */
  regenerate(assistantMessageId: string, emit: Emitter): { runId: string } {
    const assistantMessage = repo.getMessage(assistantMessageId)
    if (!assistantMessage || !assistantMessage.parentId) {
      throw new Error('无法重新生成：找不到对应的用户消息')
    }
    const conversationId = assistantMessage.conversationId
    const userMessageId = assistantMessage.parentId
    this.assertNoActiveRun(conversationId)

    const runId = randomUUID()
    const controller = new AbortController()
    this.runs.set(runId, { controller, conversationId })

    queueMicrotask(() => {
      void this.execute(runId, conversationId, emit, async () => {
        const conversation = repo.getConversation(conversationId)
        if (!conversation) throw new Error('会话不存在或已被删除')
        // 把激活叶子退回该用户消息，让新回复成为新分支
        repo.setActiveLeaf(conversationId, userMessageId)
        await this.runModel(
          runId,
          conversation,
          userMessageId,
          { providerId: assistantMessage.providerId, model: assistantMessage.model },
          emit,
          controller
        )
      }).finally(() => {
        this.runs.delete(runId)
      })
    })

    return { runId }
  }

  abort(runId: string): void {
    this.runs.get(runId)?.controller.abort()
  }

  abortConversation(conversationId: string): void {
    for (const run of this.runs.values()) {
      if (run.conversationId === conversationId) run.controller.abort()
    }
  }

  isRunning(conversationId: string): boolean {
    for (const run of this.runs.values()) {
      if (run.conversationId === conversationId) return true
    }
    return false
  }

  /** 渲染进程回传的权限确认结果。 */
  decide(decision: ApprovalDecision): void {
    const key = `${decision.runId}:${decision.toolUseId}`
    const pending = this.approvals.get(key)
    if (!pending) return
    if (decision.approved && decision.alwaysAllow) {
      this.grantAutoApprove(pending.toolName)
    }
    pending.settle(decision.approved)
  }

  /* ---------------------------------------------------------------- */

  private async executeSend(
    runId: string,
    payload: SendPayload,
    emit: Emitter,
    controller: AbortController
  ): Promise<void> {
    // 错误与 run_end 由外层 execute 统一负责
    const conversation = repo.getConversation(payload.conversationId)
    if (!conversation) throw new Error('会话不存在或已被删除')

    const parentId = payload.parentMessageId ?? repo.getActiveLeaf(conversation.id)
    const userMessage = repo.insertMessage({
      conversationId: conversation.id,
      parentId,
      role: 'user',
      blocks: [{ type: 'text', text: payload.content }]
    })
    repo.setActiveLeaf(conversation.id, userMessage.id)

    if (conversation.title === '新对话') {
      const title = payload.content.replace(/\s+/g, ' ').trim().slice(0, 24)
      if (title) repo.updateConversation(conversation.id, { title })
    }
    repo.touchConversation(conversation.id)

    await this.runModel(
      runId,
      conversation,
      userMessage.id,
      { providerId: payload.providerId, model: payload.model },
      emit,
      controller
    )
  }

  /**
   * 「规划 → 调用工具 → 观察 → 再规划」主循环。
   * 一条助手消息承载整轮的全部内容块（文本、工具调用、工具结果），
   * 这样界面上呈现为一个可折叠的助手回合，回传历史时再拆回协议要求的角色序列。
   */
  private async runModel(
    runId: string,
    conversation: Pick<Conversation, 'id' | 'systemPrompt' | 'workingDir'>,
    userMessageId: string,
    target: { providerId?: string | null; model?: string | null },
    emit: Emitter,
    controller: AbortController
  ): Promise<void> {
    const resolved = resolveTarget(
      target.providerId,
      target.model ?? repo.getConversation(conversation.id)?.model
    )

    const assistantMessage = repo.insertMessage({
      conversationId: conversation.id,
      parentId: userMessageId,
      role: 'assistant',
      blocks: [],
      status: 'streaming',
      providerId: resolved.providerId,
      model: resolved.model
    })

    emit({
      type: 'run_start',
      runId,
      conversationId: conversation.id,
      userMessageId,
      assistantMessageId: assistantMessage.id
    })

    const blocks: ContentBlock[] = []
    // usage 口径说明：多步工具循环时上下文历史会逐步增长，每步请求都完整重发，
    // 把各步 promptTokens 相加当成"一次请求的输入"是虚的。因此分开记录：
    // lastUsage = 末次请求的真实规模（展示用），turnUsage = 整轮累计（成本口径），
    // requestCount 用于区分单请求与多步，让前端决定要不要展示双口径。
    let lastUsage: Usage | null = null
    let turnPromptTokens = 0
    let turnCompletionTokens = 0
    let requestCount = 0
    // 跨供应商降级后，实际服务的可能不是首选；最终落库以实际值为准。
    let servedProviderId = resolved.providerId
    let servedModel = resolved.model
    let status: MessageStatus = 'done'
    let errorText: string | null = null
    let reachedStepLimit = false

    let finalStopReason = 'stop'

    const maxStepsConfig = getSetting<number>('agent.maxSteps', DEFAULT_MAX_STEPS)
    const effectiveMaxSteps =
      typeof maxStepsConfig === 'number' && maxStepsConfig > 0 ? maxStepsConfig : DEFAULT_MAX_STEPS

    try {
      for (let step = 0; step < effectiveMaxSteps; step++) {
        if (controller.signal.aborted) {
          status = 'aborted'
          break
        }

        const baseSystem = conversation.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT
        const customInstructions = getSetting<string>('agent.instructions', '').trim()
        const effort = getSetting<string>('agent.effort', 'high')
        let effortInstruction = ''
        if (effort === 'minimal') {
          effortInstruction = '\n\n【思考模式：极速】请尽可能以最简短、直接的方式回复，跳过繁琐的推导，直接输出核心结果。'
        } else if (effort === 'max') {
          effortInstruction = '\n\n【思考模式：极限深思】请充分进行深度分析与推理，全面评估潜在边界条件，并给出详尽可靠的严谨方案。'
        } else if (effort === 'low') {
          effortInstruction = '\n\n【思考模式：快速】保持敏捷响应，着重提供关键步骤。'
        }

        let system = baseSystem
        if (customInstructions) {
          system += `\n\n用户通用指导偏好：\n${customInstructions}`
        }
        if (effortInstruction) {
          system += effortInstruction
        }
        if (conversation.workingDir) {
          system += `\n\n当前项目目录：${conversation.workingDir}。用户为该对话绑定了此目录：文件操作优先在该目录内进行，工具收到的相对路径都基于它解析，执行命令的默认工作目录也是它。`
        }

        // 插件与技能扩展体系 (图片 2 能力打通)
        const plugins = getSetting<string[]>('agent.plugins', [
          'feature-dev',
          'commit-commands',
          'ralph-loop',
          'security-guidance'
        ])
        const pluginDirectives: string[] = []
        if (plugins.includes('feature-dev')) {
          pluginDirectives.push('【已激活技能：Feature dev 功能开发增强】在执行复杂开发或跨文件改造时，先全面查阅目录与依赖结构，输出清晰的实现规划，再有条不紊地精准修改，并在最后给出自验结果。')
        }
        if (plugins.includes('commit-commands')) {
          pluginDirectives.push('【已激活技能：Commit commands 提交助手】当用户要求提交代码或输入 `/commit` 时，主动调用 git status 和 git diff 检查变更，提炼规范的语义化提交说明（如 feat:、fix:、refactor:）并执行提交。')
        }
        if (plugins.includes('ralph-loop')) {
          pluginDirectives.push('【已激活技能：Ralph loop 自主反思自愈】在创建或修改代码后，若工程内存在测试套件或编译脚本，主动运行测试验证；若遇到报错，直接读取报错堆栈并自动进行修复，直至自测完全通过。')
        }
        if (plugins.includes('security-guidance')) {
          pluginDirectives.push('【已激活技能：Security guidance 安全审计】在阅读或生成代码、执行命令时，严格审计敏感凭据（API Key、密码等）、SQL注入、命令拼接等安全隐患，并予以预警与加固。')
        }
        if (plugins.includes('github')) {
          pluginDirectives.push('【已激活技能：GitHub 协作】若需访问远程 GitHub 仓库、Pull Request 或 Issue，优先配合本机 gh 命令行或 GitHub 接口进行操作。')
        }
        if (plugins.includes('figma')) {
          pluginDirectives.push('【已激活技能：Figma 设计协同】若涉及前端 UI 开发与还原，优先遵循现代高还原度规范，拆解像素间距、颜色变量与组件层级。')
        }
        if (plugins.includes('supabase')) {
          pluginDirectives.push('【已激活技能：Supabase 云服务】涉及后端数据模型与数据库时，优先遵循 Supabase / PostgreSQL 最佳实践并关注 RLS 行级安全策略。')
        }
        if (plugins.includes('vercel')) {
          pluginDirectives.push('【已激活技能：Vercel 部署】在构建生产发布或云端部署时，提供 Vercel CLI 与全栈 Serverless 规范支持。')
        }

        const agentMode = getSetting<string>('agent.mode', 'builder')
        if (agentMode === 'builder') {
          system += `\n\n【TRAE 工作流：建造者模式 (Builder Mode) 与 Hermes 规范已激活】
你是一名具备全栈自主工程交付能力的资深开发工程师。请严格遵循以下工业级工程构建规范：
1. 【禁止大段全量代码聊天】：严禁在普通文本中一次性输出数百行甚至数千行的完整工程代码，防止单次 Token 输出溢出截断！
2. 【必须使用工具逐个文件落盘】：创建新文件必须调用 write_file，修改现有代码必须优先调用 patch_file（局部精确替换），单步只写一个文件；
3. 【Hermes 结构化步进】：遵循 [PLAN]（本步明确目标）-> [ACT]（调用工具精准落盘）-> [OBSERVE]（观察执行结果）的规范闭环；
4. 【自测自愈 (Ralph Loop)】：文件写入完成后，如工程存在测试套件或编译脚本，主动调用 run_command 进行自验，遇错即读栈自愈。`
        } else {
          system += `\n\n【TRAE 工作流：问答咨询模式 (Chat Mode) 已激活】
你是一名亲切高效的技术专家。当前专注于概念解答、方案分析、代码走读与思路交流。
以清晰简洁的 Markdown 组织回答，给出思路与核心代码片段即可。`
        }

        if (pluginDirectives.length > 0) {
          system += `\n\n当前已启用的扩展技能与工作流：\n${pluginDirectives.join('\n')}`
        }
        const budget = getSetting<number>(BUDGET_KEY, DEFAULT_BUDGET_TOKENS)
        const persisted = repo.getActivePath(conversation.id)
        const context = buildContext(persisted, { system, budgetTokens: budget })

        // 持久化路径 + 本轮尚未落库的累积块，拼出这次请求的完整消息序列
        const inMemory: Message[] = [{ ...assistantMessage, blocks: [...blocks], role: 'assistant' }]
        const messages: LLMMessage[] = [...context.messages, ...toLLMMessages(inMemory)]

        const toolUses: { id: string; name: string; input: unknown }[] = []

        let stopReason = 'stop'
        for await (const chunk of streamWithFallback(
          {
            model: resolved.model,
            system,
            messages,
            tools: toolRegistry.schemas(),
            maxTokens: MAX_OUTPUT_TOKENS
          },
          controller.signal,
          resolved.providerId
        )) {
          if (chunk.type === 'text') {
            appendBlock(blocks, { type: 'text', text: chunk.text })
            emit({
              type: 'text_delta',
              runId,
              conversationId: conversation.id,
              messageId: assistantMessage.id,
              text: chunk.text
            })
          } else if (chunk.type === 'reasoning') {
            appendBlock(blocks, { type: 'reasoning', text: chunk.text })
            emit({
              type: 'reasoning_delta',
              runId,
              conversationId: conversation.id,
              messageId: assistantMessage.id,
              text: chunk.text
            })
          } else if (chunk.type === 'tool_use') {
            toolUses.push({ id: chunk.id, name: chunk.name, input: chunk.input })
          } else if (chunk.type === 'stop') {
            stopReason = chunk.reason
          } else if (chunk.type === 'provider_switch') {
            servedProviderId = chunk.providerId
            servedModel = chunk.model
            emit({
              type: 'provider_switched',
              runId,
              conversationId: conversation.id,
              fromProviderName: chunk.fromProviderName,
              providerName: chunk.providerName,
              model: chunk.model,
              reason: chunk.reason
            })
          } else if (chunk.type === 'retry_status') {
            emit({
              type: 'retry_status',
              runId,
              conversationId: conversation.id,
              providerName: chunk.providerName,
              attempt: chunk.attempt,
              maxAttempts: chunk.maxAttempts,
              waitMs: chunk.waitMs,
              reason: chunk.reason
            })
          } else if (chunk.type === 'usage') {
            lastUsage = chunk.usage
            turnPromptTokens += chunk.usage.promptTokens
            turnCompletionTokens += chunk.usage.completionTokens
            requestCount++
            // 渲染端靠这个事件实时刷新 token 用量；只落库不发事件，UI 上的用量就永远是空的
            emit({
              type: 'usage',
              runId,
              conversationId: conversation.id,
              messageId: assistantMessage.id,
              usage: chunk.usage
            })
          }
        }

        finalStopReason = stopReason

        for (const call of toolUses) {
          blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input })
          emit({
            type: 'tool_use',
            runId,
            conversationId: conversation.id,
            messageId: assistantMessage.id,
            toolUseId: call.id,
            name: call.name,
            input: call.input
          })
        }

        if (toolUses.length === 0) {
          if (step === effectiveMaxSteps - 1) reachedStepLimit = true
          break
        }

        for (const call of toolUses) {
          const result = await this.invokeTool(
            runId,
            assistantMessage.id,
            call,
            conversation.id,
            conversation.workingDir,
            emit,
            controller
          )
          blocks.push({
            type: 'tool_result',
            toolUseId: call.id,
            content: result.content,
            isError: result.isError
          })
          emit({
            type: 'tool_result',
            runId,
            conversationId: conversation.id,
            messageId: assistantMessage.id,
            toolUseId: call.id,
            content: result.content,
            isError: result.isError
          })
        }

        // 阶段性落库，进程意外退出时仍能看到已完成的部分
        repo.updateMessage(assistantMessage.id, {
          blocks: [...blocks],
          usage: this.composeUsage(lastUsage, turnPromptTokens, turnCompletionTokens, requestCount, stopReason)
        })

        if (step === effectiveMaxSteps - 1) reachedStepLimit = true
      }

      if (reachedStepLimit) {
        const notice = `\n\n_（已达到单轮工具调用上限 ${effectiveMaxSteps} 步，如需继续请回复「继续」。可在「设置 ⚙️ → 偏好设置」中调大上限。）_`
        appendBlock(blocks, { type: 'text', text: notice })
        emit({
          type: 'text_delta',
          runId,
          conversationId: conversation.id,
          messageId: assistantMessage.id,
          text: notice
        })
      }

      // Qoder / Cline 级截断防护：当输出因达到 token 上限被中断时自动处理
      const hasText = blocks.some((b) => b.type === 'text' && b.text.trim().length > 0)
      const hasReasoning = blocks.some((b) => b.type === 'reasoning' && b.text.trim().length > 0)
      if ((finalStopReason === 'length' || finalStopReason === 'max_tokens') && !hasText && hasReasoning) {
        const truncationNotice =
          '\n\n⚠️ **【Qoder / Cline 级智能截断保护】** 大模型的思考推导过程耗尽了单次最大 Token 预算（8192 tokens），在输出正式正文前被中断。\n\n💡 **已为您就绪断点续写机制**：请点击下方「⚡ 智能继续生成」或发送「继续」，大模型将跳过思考直接无缝吐出剩余正文与代码。'
        appendBlock(blocks, { type: 'text', text: truncationNotice })
        emit({
          type: 'text_delta',
          runId,
          conversationId: conversation.id,
          messageId: assistantMessage.id,
          text: truncationNotice
        })
      }

      if (blocks.length === 0) {
        appendBlock(blocks, {
          type: 'text',
          text: '（模型返回了空回复。可能是当前模型不支持工具调用，请换一个模型或关闭工具后重试。）'
        })
      }
    } catch (error) {
      if (controller.signal.aborted) {
        status = 'aborted'
      } else {
        status = 'error'
        errorText = describeError(error)
        log.error('[agent] 生成失败', error)
        emit({
          type: 'run_error',
          runId,
          conversationId: conversation.id,
          messageId: assistantMessage.id,
          error: errorText
        })
      }
    }

    repo.updateMessage(assistantMessage.id, {
      blocks,
      status,
      error: errorText,
      usage: this.composeUsage(lastUsage, turnPromptTokens, turnCompletionTokens, requestCount, finalStopReason),
      model: servedModel,
      providerId: servedProviderId
    })
    // 只有当 activeLeaf 仍停在本回合的起点（用户消息）时才推进到新回复。
    // 生成期间用户可能已切换分支，直接覆盖会悄悄改掉用户的选择。
    if (repo.getActiveLeaf(conversation.id) === userMessageId) {
      repo.setActiveLeaf(conversation.id, assistantMessage.id)
    }
    repo.touchConversation(conversation.id)

    emit({
      type: 'message_done',
      runId,
      conversationId: conversation.id,
      messageId: assistantMessage.id,
      status
    })
  }

  /** 组装落库的 usage：末次请求为基准，多步时附上整轮累计与请求数。 */
  private composeUsage(
    lastUsage: Usage | null,
    turnPromptTokens: number,
    turnCompletionTokens: number,
    requestCount: number,
    finishReason?: string
  ): Usage | null {
    if (!lastUsage) {
      return finishReason ? { promptTokens: 0, completionTokens: 0, finishReason } : null
    }
    return {
      ...lastUsage,
      ...(requestCount > 1
        ? {
            totalPromptTokens: turnPromptTokens,
            totalCompletionTokens: turnCompletionTokens,
            requests: requestCount
          }
        : {}),
      ...(finishReason ? { finishReason } : {})
    }
  }

  private async invokeTool(
    runId: string,
    messageId: string,
    call: { id: string; name: string; input: unknown },
    conversationId: string,
    workingDirectory: string | null,
    emit: Emitter,
    controller: AbortController
  ): Promise<{ content: string; isError: boolean }> {
    const tool = toolRegistry.get(call.name)
    if (!tool) {
      return { content: `未知工具：${call.name}。可用工具：${toolRegistry.all().map((t) => t.name).join('、')}`, isError: true }
    }

    // Freebuff 安全护栏审计：针对命令执行和高危操作进行深度规则扫描
    let isSecurityCritical = false
    let securityAuditReason = ''
    if (call.name === 'run_command' && typeof (call.input as Record<string, unknown>)?.command === 'string') {
      const audit = auditCommandSecurity(String((call.input as Record<string, unknown>).command))
      if (audit.isDangerous) {
        isSecurityCritical = true
        securityAuditReason = audit.reason || '【Freebuff 安全护栏拦截】检测到高危系统级操作！'
      }
    }

    const needsApproval = (tool.requiresApproval && !this.isAutoApproved(call.name)) || isSecurityCritical
    if (needsApproval) {
      const decision = await this.requestApproval(
        runId,
        conversationId,
        messageId,
        call,
        {
          name: tool.name,
          approvalReason: isSecurityCritical ? securityAuditReason : tool.approvalReason
        },
        emit,
        controller
      )
      if (!decision.approved) {
        return {
          content: '用户拒绝了这次操作。请不要重复尝试相同操作，改为向用户说明你的意图或换一种不影响本机的方式。',
          isError: true
        }
      }
    }

    try {
      const content = await tool.execute(call.input, {
        conversationId,
        workingDirectory,
        signal: controller.signal
      })
      return { content, isError: false }
    } catch (error) {
      return { content: `工具执行失败：${describeError(error)}`, isError: true }
    }
  }

  private requestApproval(
    runId: string,
    conversationId: string,
    messageId: string,
    call: { id: string; name: string; input: unknown },
    tool: { name: string; approvalReason?: string },
    emit: Emitter,
    controller: AbortController
  ): Promise<ApprovalDecision> {
    const key = `${runId}:${call.id}`

    emit({
      type: 'approval_required',
      runId,
      conversationId,
      messageId,
      toolUseId: call.id,
      name: call.name,
      input: call.input,
      reason: tool.approvalReason ?? '该操作会修改你的本机环境。'
    })

    return new Promise<ApprovalDecision>((resolve) => {
      const settle = (approved: boolean): void => {
        clearTimeout(timer)
        controller.signal.removeEventListener('abort', onAbort)
        this.approvals.delete(key)
        resolve({ runId, toolUseId: call.id, approved })
      }

      const timer = setTimeout(() => {
        log.warn(`[agent] 工具 ${call.name} 的确认超时，按拒绝处理`)
        settle(false)
      }, APPROVAL_TIMEOUT_MS)

      const onAbort = (): void => settle(false)
      controller.signal.addEventListener('abort', onAbort, { once: true })

      this.approvals.set(key, { toolName: tool.name, settle })
    })
  }

  private isAutoApproved(toolName: string): boolean {
    return getSetting<string[]>(AUTO_APPROVE_KEY, []).includes(toolName)
  }

  private grantAutoApprove(toolName: string): void {
    const current = getSetting<string[]>(AUTO_APPROVE_KEY, [])
    if (current.includes(toolName)) return
    setSetting(AUTO_APPROVE_KEY, [...current, toolName])
    log.info(`[agent] 已永久放行工具：${toolName}`)
  }
}

export const agentRuntime = new AgentRuntime()