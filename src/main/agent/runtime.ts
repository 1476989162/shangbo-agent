import { randomUUID } from 'node:crypto'
import log from 'electron-log/main'
import * as repo from '../db/repo'
import { getSetting, setSetting } from '../settings'
import { toolRegistry } from '../tools'
import { streamWithFallback } from '../providers/gateway'
import { routingOrder } from '../providers/store'
import { buildContext, toLLMMessages } from './context'
import type {
  AgentEvent,
  ApprovalDecision,
  ContentBlock,
  Message,
  MessageStatus,
  SendPayload,
  Usage
} from '../../shared/types'
import type { LLMMessage } from '../providers/types'

export type Emitter = (event: AgentEvent) => void

/** 单轮最多允许的工具调用步数，防止模型陷入自我循环。 */
const MAX_STEPS = 12
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

  /** 发起一次新的对话回合。立即返回 runId，实际执行在微任务中进行。 */
  send(payload: SendPayload, emit: Emitter): { runId: string } {
    const runId = randomUUID()
    const controller = new AbortController()
    this.runs.set(runId, { controller, conversationId: payload.conversationId })

    // 放到微任务里，确保调用方先拿到 runId 再收到事件
    queueMicrotask(() => {
      void this.executeSend(runId, payload, emit, controller).finally(() => {
        this.runs.delete(runId)
      })
    })

    return { runId }
  }

  /** 重新生成：为同一条用户消息再挂一个助手兄弟节点，形成新的分支。 */
  regenerate(assistantMessageId: string, emit: Emitter): { runId: string } {
    const runId = randomUUID()
    const controller = new AbortController()
    const assistantMessage = repo.getMessage(assistantMessageId)

    if (!assistantMessage || !assistantMessage.parentId) {
      throw new Error('无法重新生成：找不到对应的用户消息')
    }
    const conversationId = assistantMessage.conversationId
    const userMessageId = assistantMessage.parentId
    this.runs.set(runId, { controller, conversationId })

    queueMicrotask(() => {
      const conversation = repo.getConversation(conversationId)
      if (!conversation) {
        emit({ type: 'run_end', runId })
        return
      }
      // 把激活叶子退回该用户消息，让新回复成为新分支
      repo.setActiveLeaf(conversationId, userMessageId)
      void this.runModel(
        runId,
        conversation,
        userMessageId,
        { providerId: assistantMessage.providerId, model: assistantMessage.model },
        emit,
        controller
      )
        .catch((error) => log.error('[agent] 重新生成失败', error))
        .finally(() => this.runs.delete(runId))
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
    try {
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
    } catch (error) {
      log.error('[agent] 回合失败', error)
      emit({ type: 'run_error', runId, messageId: '', error: describeError(error) })
    } finally {
      emit({ type: 'run_end', runId })
    }
  }

  /**
   * 「规划 → 调用工具 → 观察 → 再规划」主循环。
   * 一条助手消息承载整轮的全部内容块（文本、工具调用、工具结果），
   * 这样界面上呈现为一个可折叠的助手回合，回传历史时再拆回协议要求的角色序列。
   */
  private async runModel(
    runId: string,
    conversation: { id: string; systemPrompt: string | null },
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
      userMessageId,
      assistantMessageId: assistantMessage.id
    })

    const blocks: ContentBlock[] = []
    let usage: Usage | null = null
    let status: MessageStatus = 'done'
    let errorText: string | null = null
    let reachedStepLimit = false

    try {
      for (let step = 0; step < MAX_STEPS; step++) {
        if (controller.signal.aborted) {
          status = 'aborted'
          break
        }

        const system = conversation.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT
        const budget = getSetting<number>(BUDGET_KEY, DEFAULT_BUDGET_TOKENS)
        const persisted = repo.getActivePath(conversation.id)
        const context = buildContext(persisted, { system, budgetTokens: budget })

        // 持久化路径 + 本轮尚未落库的累积块，拼出这次请求的完整消息序列
        const inMemory: Message[] = [{ ...assistantMessage, blocks: [...blocks], role: 'assistant' }]
        const messages: LLMMessage[] = [...context.messages, ...toLLMMessages(inMemory)]

        const toolUses: { id: string; name: string; input: unknown }[] = []

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
              messageId: assistantMessage.id,
              text: chunk.text
            })
          } else if (chunk.type === 'reasoning') {
            appendBlock(blocks, { type: 'reasoning', text: chunk.text })
            emit({
              type: 'reasoning_delta',
              runId,
              messageId: assistantMessage.id,
              text: chunk.text
            })
          } else if (chunk.type === 'tool_use') {
            toolUses.push({ id: chunk.id, name: chunk.name, input: chunk.input })
          } else if (chunk.type === 'usage') {
            usage = usage
              ? {
                  promptTokens: usage.promptTokens + chunk.usage.promptTokens,
                  completionTokens: usage.completionTokens + chunk.usage.completionTokens
                }
              : chunk.usage
          }
        }

        for (const call of toolUses) {
          blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input })
          emit({
            type: 'tool_use',
            runId,
            messageId: assistantMessage.id,
            toolUseId: call.id,
            name: call.name,
            input: call.input
          })
        }

        if (toolUses.length === 0) {
          if (step === MAX_STEPS - 1) reachedStepLimit = true
          break
        }

        for (const call of toolUses) {
          const result = await this.invokeTool(runId, assistantMessage.id, call, conversation.id, emit, controller)
          blocks.push({
            type: 'tool_result',
            toolUseId: call.id,
            content: result.content,
            isError: result.isError
          })
          emit({
            type: 'tool_result',
            runId,
            messageId: assistantMessage.id,
            toolUseId: call.id,
            content: result.content,
            isError: result.isError
          })
        }

        // 阶段性落库，进程意外退出时仍能看到已完成的部分
        repo.updateMessage(assistantMessage.id, { blocks: [...blocks], usage })

        if (step === MAX_STEPS - 1) reachedStepLimit = true
      }

      if (reachedStepLimit) {
        const notice = `\n\n_（已达到单轮工具调用上限 ${MAX_STEPS} 步，如需继续请回复「继续」。）_`
        appendBlock(blocks, { type: 'text', text: notice })
        emit({ type: 'text_delta', runId, messageId: assistantMessage.id, text: notice })
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
        emit({ type: 'run_error', runId, messageId: assistantMessage.id, error: errorText })
      }
    }

    repo.updateMessage(assistantMessage.id, {
      blocks,
      status,
      error: errorText,
      usage,
      model: resolved.model,
      providerId: resolved.providerId
    })
    repo.setActiveLeaf(conversation.id, assistantMessage.id)
    repo.touchConversation(conversation.id)

    emit({
      type: 'message_done',
      runId,
      messageId: assistantMessage.id,
      status
    })
  }

  private async invokeTool(
    runId: string,
    messageId: string,
    call: { id: string; name: string; input: unknown },
    conversationId: string,
    emit: Emitter,
    controller: AbortController
  ): Promise<{ content: string; isError: boolean }> {
    const tool = toolRegistry.get(call.name)
    if (!tool) {
      return { content: `未知工具：${call.name}。可用工具：${toolRegistry.all().map((t) => t.name).join('、')}`, isError: true }
    }

    if (tool.requiresApproval && !this.isAutoApproved(call.name)) {
      const decision = await this.requestApproval(runId, messageId, call, tool, emit, controller)
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
        signal: controller.signal
      })
      return { content, isError: false }
    } catch (error) {
      return { content: `工具执行失败：${describeError(error)}`, isError: true }
    }
  }

  private requestApproval(
    runId: string,
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