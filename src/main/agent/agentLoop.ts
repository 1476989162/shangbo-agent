import log from 'electron-log/main'
import * as repo from '../db/repo'
import { getSetting } from '../settings'
import { auditCommandSecurity, toolRegistry } from '../tools'
import { getTodoItems } from '../tools/todo'
import { resolveFirstByteTimeoutMs, streamWithFallback } from '../providers/gateway'
import { buildContext, buildSummaryTranscript, estimateTokens, hydrateContextImages, toLLMMessages } from './context'
import { resolveEffort } from './effort'
import { callSignature, detectStuck, type ToolRecord } from './loopGuard'
import { isReadOnlyToolName, normalizeToolConcurrency, runToolBatch } from './toolScheduler'
import { SPAWN_SUBAGENT_SCHEMA, SPAWN_TOOL_NAME } from './subagent'
import { mcpManager } from '../mcp/manager'
import type {
  AgentEvent,
  ContentBlock,
  Conversation,
  Message,
  MessageStatus,
  Usage
} from '../../shared/types'
import { textOf, type LLMMessage } from '../providers/types'
import { matchReviewIntent, REVIEW_PLAYBOOK } from './playbooks'
import { buildTaskContract, classifyIntent, matchTaskPlaybook } from './intent'
import { listLessons, markLessonsUsed } from '../autonomous/store'
import { resolveAgentMode } from './wishMode'
import type { AgentMode } from '../../shared/types'
import type { ToolOutcome } from './toolOutcome'
import {
  appendBlock,
  DEFAULT_BUDGET_TOKENS,
  DEFAULT_SYSTEM_PROMPT,
  BUDGET_KEY,
  describeError,
  MAX_OUTPUT_TOKENS,
  normalizeIncomingDelta,
  resolveTarget,
  SKIP_THINKING_SUFFIX
} from './modelRuntime'

export type LoopEmitter = (event: AgentEvent) => void

export interface AgentLoopHooks {
  git(args: string[], cwd: string): Promise<string | null>
  summarizeHistory(transcript: string, providerId: string, signal: AbortSignal): Promise<string | null>
  takeSteeringNotes(conversationId: string): string[]
  invokeTool(
    runId: string,
    messageId: string,
    call: { id: string; name: string; input: unknown },
    conversationId: string,
    workingDirectory: string | null,
    emit: LoopEmitter,
    controller: AbortController,
    onNotify?: (text: string) => void,
    onUsage?: (promptTokens: number, completionTokens: number, requests: number) => void
  ): Promise<ToolOutcome>
  composeUsage(
    lastUsage: Usage | null,
    turnPromptTokens: number,
    turnCompletionTokens: number,
    requestCount: number,
    finishReason?: string,
    turnCacheReadTokens?: number,
    turnCacheWriteTokens?: number
  ): Usage | null
}

export async function runAgentLoop(
  hooks: AgentLoopHooks,
  runId: string,
  conversation: Pick<Conversation, 'id' | 'systemPrompt' | 'workingDir' | 'mode'>,
  userMessage: Message,
  target: { providerId?: string | null; model?: string | null },
  emit: LoopEmitter,
  controller: AbortController,
  /** runtime 已按自然语言判定好的模式；缺省时按会话声明与意图兜底。 */
  options?: { effectiveMode?: AgentMode }
): Promise<void> {
    const resolved = resolveTarget(
      target.providerId,
      target.model ?? repo.getConversation(conversation.id)?.model
    )

    const assistantMessage = repo.insertMessage({
      conversationId: conversation.id,
      parentId: userMessage.id,
      role: 'assistant',
      blocks: [],
      status: 'streaming',
      providerId: resolved.providerId,
      model: resolved.model,
      usageMode: userMessage.usageMode ?? null
    })

    emit({
      type: 'run_start',
      runId,
      conversationId: conversation.id,
      userMessageId: userMessage.id,
      assistantMessageId: assistantMessage.id,
      userMessage
    })

    const blocks: ContentBlock[] = []
    // usage 口径说明：多步工具循环时上下文历史会逐步增长，每步请求都完整重发，
    // 把各步 promptTokens 相加当成"一次请求的输入"是虚的。因此分开记录：
    // lastUsage = 末次请求的真实规模（展示用），turnUsage = 整轮累计（成本口径），
    // requestCount 用于区分单请求与多步，让前端决定要不要展示双口径。
    let lastUsage: Usage | null = null
    let turnPromptTokens = 0
    let turnCompletionTokens = 0
    let turnCacheReadTokens = 0
    let turnCacheWriteTokens = 0
    let requestCount = 0
    // 流式通道快照：跨供应商/跨步共享同一份，确保累计全文不会被二次追加。
    let textStreamSnapshot = ''
    let reasoningStreamSnapshot = ''
    // 跨供应商降级后，实际服务的可能不是首选；最终落库以实际值为准。
    let servedProviderId = resolved.providerId
    let servedModel = resolved.model
    let status: MessageStatus = 'done'
    let errorText: string | null = null

    let finalStopReason = 'stop'

    // 回合内不变的系统提示只拼一次，避免每步重复读设置并膨胀上下文。
    const baseSystem = conversation.systemPrompt?.trim() || DEFAULT_SYSTEM_PROMPT
    const customInstructions = getSetting<string>('agent.instructions', '').trim()
    const effort = getSetting<string>('agent.effort', 'high')
    // 真旋钮：档位按模型家族映射成 API 参数与输出上限，不再只改一句话。
    const resolvedEffort = resolveEffort(resolved.model, effort)
    let system = baseSystem
    if (customInstructions) system += `\n\n用户通用指导偏好：\n${customInstructions}`
    if (resolvedEffort.hint) system += resolvedEffort.hint
    if (conversation.workingDir) {
      system += `\n\n当前项目目录：${conversation.workingDir}。相对路径基于它解析，命令默认在它下执行。`
    }

    const plugins = getSetting<string[]>('agent.plugins', [
      'feature-dev',
      'commit-commands',
      'ralph-loop',
      'security-guidance'
    ])
    const pluginDirectives: string[] = []
    if (plugins.includes('feature-dev')) pluginDirectives.push('复杂改造先查结构、给规划再改。')
    if (plugins.includes('commit-commands')) pluginDirectives.push('用户要提交时先 git status/diff 再写语义化信息。')
    if (plugins.includes('ralph-loop')) pluginDirectives.push('改完代码有测试就跑，报错读栈自愈。')
    if (plugins.includes('security-guidance')) pluginDirectives.push('注意密钥/SQL注入/命令拼接风险。')
    if (plugins.includes('github')) pluginDirectives.push('GitHub 操作优先用本机 gh。')

    const triggerText = textOf(userMessage.blocks)
    const intent = classifyIntent(triggerText)
    // resolveAgentMode 保证返回具体模式（auto 已在此展开），这里的收窄只是类型表达。
    const agentMode = (
      options?.effectiveMode && options.effectiveMode !== 'auto'
        ? options.effectiveMode
        : resolveAgentMode(
            conversation.mode,
            {
              wishEnabled: getSetting<boolean>('agent.wish.enabled', true),
              autoApproveWorkspace: getSetting<boolean>('agent.wish.autoApproveWorkspace', true),
              defaultMode: getSetting<string>('agent.mode', 'auto')
            },
            intent
          )
    ) as Exclude<AgentMode, 'auto'>

    // 用户确认过的长期背景：只在开关打开时注入，且限条数/字数，避免污染上下文。
    const globalInstructions = getSetting<string>('cowork.globalInstructions', '').trim()
    if (globalInstructions) {
      system += `\n\n【全局协作约定】\n${globalInstructions.slice(0, 4000)}`
    }
    if (getSetting<boolean>('cowork.useMemory', false)) {
      const memories = getSetting<{ title?: unknown; desc?: unknown }[]>('cowork.memories', [])
      const lines = memories
        .slice(0, 8)
        .map((item) => {
          const title = typeof item.title === 'string' ? item.title.trim() : ''
          const desc = typeof item.desc === 'string' ? item.desc.trim() : ''
          return title && desc ? `- ${title}：${desc}` : ''
        })
        .filter(Boolean)
        .join('\n')
        .slice(0, 2400)
      if (lines) system += `\n\n【长期记忆（用户已确认的背景，可作为默认前提）】\n${lines}`
    }

    // 许愿闭环：把当前分支的真实 diff 作为“改动证据”注入，避免模型只凭记忆总结。
    if (
      agentMode === 'wish' &&
      conversation.workingDir &&
      getSetting<boolean>('agent.wish.enabled', true)
    ) {
      const diff = await hooks.git(['diff', '--stat'], conversation.workingDir)
      if (diff) {
        system += `\n\n【当前工作区改动】\n${diff.slice(0, 6000)}`
      }
    }
    if (agentMode === 'builder') {
      system += '\n\n【建造者】直接动手：改代码必须调工具落盘、一次一个文件；优先 patch_file；写完有测试就自验。独立子任务（分模块侦察、独立文件改造）可 spawn_subagent 并行派，最后由你汇总结论。'
    } else if (agentMode === 'chat') {
      system += '\n\n【问答】给结论和核心片段即可，不要为了显得勤快而改文件。'
    } else if (agentMode === 'wish' && getSetting<boolean>('agent.wish.enabled', true)) {
      const acceptance = getSetting<string>('agent.wish.acceptance', '').trim()
      const verifyCommand = getSetting<string>('agent.wish.verifyCommand', '').trim()
      const wishAllowMcp = getSetting<boolean>('agent.wish.allowMcp', true)
      system += [
        '',
        '【许愿模式】你是自动交付者，不是咨询顾问。',
        '工作区内读写与命令无需等待用户确认；你必须自己规划、修改、运行验证、读取报错、修复并重跑，直到满足验收。',
        '不得声称“应该可以”或把验证留给用户。没有真实验证证据就不能宣布完成。',
        acceptance ? `默认验收标准：${acceptance}` : '',
        verifyCommand ? `默认验收命令：${verifyCommand}` : '',
        wishAllowMcp
          ? '外部 MCP 工具（mcp__服务__工具）可用：浏览器自动化、抓网页、检索文档、记忆库等；它们已按服务放行，直接调用即可，不要因为“不是本地工具”而放弃。'
          : '外部 MCP 工具已关闭：只能用工作区内的本地读写、补丁与命令工具。',
        '最终必须输出：改动摘要、实际执行的验证命令与结果、剩余风险、回滚方式。',
        '硬边界：只改当前工作区；不读取密钥库/会话数据库；删 .git、删库、清表、格式化磁盘一律停下来等人工确认。'
      ]
        .filter(Boolean)
        .join('\n')    }

    // 任务契约：把自然语言压成目标/验收/提问边界，是“少问多做”的主要抓手。
    // 寒暄/极短问答不注入，避免每句“你好”都背一段契约。
    const substantive = triggerText.trim().length >= 8 || intent.wantsAction
    const contract = substantive
      ? buildTaskContract(triggerText, agentMode, { workingDirectory: conversation.workingDir })
      : ''
    if (contract) system += `\n\n${contract}`
    const taskPlaybook = substantive ? matchTaskPlaybook(triggerText, agentMode) : ''
    if (taskPlaybook) system += taskPlaybook

    // 项目经验对所有模式都注入：建造者同样需要知道上次是怎么验证通过的。
    if (conversation.workingDir) {
      const lessons = listLessons({
        projectPath: conversation.workingDir,
        limit: agentMode === 'wish' ? 12 : 6
      })
      if (lessons.length > 0) {
        system += `\n\n【已验证的项目经验（优先复用）】\n${lessons
          .map((lesson, index) => `${index + 1}. ${lesson.title}\n${lesson.content}`)
          .join('\n')}`
        markLessonsUsed(lessons.map((lesson) => lesson.id))
      }
    }
    if (pluginDirectives.length > 0) system += `\n已启用技能：${pluginDirectives.join(' ')}`

    // 方法论注入：本轮是复查任务才给打法，平时不打扰。
    if (matchReviewIntent(triggerText)) {
      system += REVIEW_PLAYBOOK
    }

    // 许愿任务要留出“改—跑—读错—再改”的空间；32k 预算常在长测试日志后把任务目标裁掉。
    const configuredBudget = getSetting<number>(BUDGET_KEY, DEFAULT_BUDGET_TOKENS)
    const budget =
      agentMode === 'wish' && getSetting<boolean>('agent.wish.enabled', true)
        ? Math.max(configuredBudget, 64_000)
        : configuredBudget
    // Codex 式沙箱档：只读复查时模型根本看不到写工具，比逐个审批更彻底。
    // 许愿模式本身是“自动交付”模式，不应被通用只读复查开关静默降级；
    // 用户若切到许愿模式，就明确表示要落盘和验证。
    const readOnly = agentMode !== 'wish' && getSetting<boolean>('agent.readOnly', false)
    if (readOnly) system += '\n\n【只读复查】只允许读取与搜索文件，禁止写入、修改与执行命令；输出问题清单即可，不要尝试改动。'
    // 保险丝灵敏度：连续几次打转就停，默认 3。
    const stuckCfg = getSetting<number>('agent.stuckLimit', 3)
    const effectiveStuckLimit = typeof stuckCfg === 'number' && stuckCfg > 0 ? stuckCfg : 3
    // 步数上限：防止模型换参试错无限烧 Token，默认 50 轮请求后暂停。loopGuard 只拦"打转"，
    // 正常干活 50 步也会触发——这是成本熔断，不是行为判断。到顶复用 guardNotice 提示用户。
    const maxStepsCfg =
      agentMode === 'wish' && getSetting<boolean>('agent.wish.enabled', true)
        ? getSetting<number>('agent.wishMaxSteps', 120)
        : getSetting<number>('agent.maxSteps', 50)
    const effectiveMaxSteps = typeof maxStepsCfg === 'number' && maxStepsCfg > 0 ? Math.floor(maxStepsCfg) : 50
    let stepCount = 0
    // 本轮已执行的工具序列，只用于打转检测，不回传模型。
    const toolHistory: ToolRecord[] = []
    const noteToolBatch = (
      items: { call: { name: string; input: unknown }; result: { isError: boolean } }[]
    ): string | null => {
      for (const item of items) {
        toolHistory.push({ sig: callSignature(item.call.name, item.call.input), isError: item.result.isError })
      }
      return detectStuck(toolHistory, effectiveStuckLimit)
    }
    let stoppedByGuard = false
    // 本轮发给模型的工具清单：本地读/写 + spawn + 已启用 MCP 服务的远端工具。
    // MCP 进程首次拉起可能慢（npx 拉包），之后常驻复用；单个服务起不来只跳过不炸轮。
    // Computer Use 工具只在设置开启时挂载（截图免审，其余键鼠操作逐次审批）。
    const computerOn = getSetting<boolean>('agent.computerUse', true)
    const offeredSchemas = [
      ...toolRegistry.schemas({ readOnly }).filter((t) => computerOn || !t.name.startsWith('computer_')),
      SPAWN_SUBAGENT_SCHEMA,
      ...(await mcpManager.toolSchemas())
    ]
    if (computerOn && !readOnly) {
      system += '\n\n【桌面操作】需要操作本机桌面应用时：先 computer_screenshot 看屏，按截图像素坐标 computer_click，必要时 computer_type / computer_press_key / computer_scroll。每次键鼠操作都要用户确认。'
    }
    // 进度通知：子任务起止落到父消息文本里，当下即可见。
    const onNotify = (text: string): void => {
      appendBlock(blocks, { type: 'text', text: `\n\n${text}` })
      emit({
        type: 'text_delta',
        runId,
        conversationId: conversation.id,
        messageId: assistantMessage.id,
        text: `\n\n${text}`
      })
    }

    // 工具 schema 常年 8000-15000 tokens，不计入预算等于预算虚高：这里一次估值（续写复用）
    const toolSchemaTokens = estimateTokens(JSON.stringify(offeredSchemas))
    const toolResultMaxCharsRaw = getSetting<number>('agent.toolResultMaxChars', 4000)
    const effectiveToolResultMaxChars =
      typeof toolResultMaxCharsRaw === 'number' && toolResultMaxCharsRaw > 0 ? toolResultMaxCharsRaw : 4000

    try {
      // 主循环：跑到模型不再调工具为止。防打转靠 loopGuard 行为保险丝，
      // 防无限烧 Token 靠 maxSteps 成本熔断。想停随时点「停止」。
      for (;;) {
        if (controller.signal.aborted) {
          status = 'aborted'
          break
        }
        // 成本熔断：超过 maxSteps 轮请求即暂停，提示用户回复"继续"接力
        if (stepCount >= effectiveMaxSteps) {
          stoppedByGuard = true
          const guardNotice = `\n\n_（已达到单轮步数上限（${effectiveMaxSteps} 步），先停下来请人看一眼，不要继续烧 Token。排除问题后回复「继续」。）_`
          appendBlock(blocks, { type: 'text', text: guardNotice })
          emit({
            type: 'text_delta',
            runId,
            conversationId: conversation.id,
            messageId: assistantMessage.id,
            text: guardNotice
          })
          break
        }
        stepCount++

        const persisted = repo.getPathTo(userMessage.id)
        // 工具 schema 常年 8000-15000 tokens，不计入预算等于预算虚高：这里复用 try 外一次估值
          // 轮间摘要（可选）：被裁掉的历史先换成语义摘要，避免模型直接“失忆”。
          // 摘要由当前模型异步生成，并缓存在 conversations.summary_json。
          const summarizeEnabled = getSetting<boolean>('agent.context.summarize', false)
          let cachedSummary: repo.ConversationSummary | null = null
          if (summarizeEnabled) {
            cachedSummary = repo.getConversationSummary(conversation.id)
            const probe = buildContext(persisted, {
              system,
              budgetTokens: budget,
              extraTokens: toolSchemaTokens,
              toolResultMaxChars: effectiveToolResultMaxChars
            })
            if (probe.omittedMessages?.length && probe.omittedMessages.length > 0) {
              const lastOmitted = probe.omittedMessages[probe.omittedMessages.length - 1]
              if (!cachedSummary || cachedSummary.coveredMessageId !== lastOmitted.id) {
                const transcript = buildSummaryTranscript(probe.omittedMessages)
                if (transcript.trim()) {
                  const text = await hooks.summarizeHistory(
                    transcript,
                    resolved.providerId,
                    controller.signal
                  )
                  if (text) {
                    cachedSummary = {
                      coveredMessageId: lastOmitted.id,
                      text,
                      updatedAt: Date.now()
                    }
                    repo.setConversationSummary(conversation.id, cachedSummary)
                  }
                }
              }
            }
          }
          const context = buildContext(persisted, {
          system,
          budgetTokens: budget,
          extraTokens: toolSchemaTokens,
            toolResultMaxChars: effectiveToolResultMaxChars,
            summary: cachedSummary?.text
        })
        // 裁剪完成后才读图片：被裁掉的历史轮次里的图永远不进内存
        await hydrateContextImages(context)
        // 裁剪发生时告诉模型，避免它以为看到了全部历史而编造。
        // 中途指导：用户在排队消息上点"指导当前轮"，下一轮请求即带上，不等前面的跑完
        const steering = hooks.takeSteeringNotes(conversation.id)
        const effectiveSystem =
          context.omittedTurns > 0 || steering.length > 0
            ? `${system}${
                context.omittedTurns > 0
                  ? `\n\n（最早 ${context.omittedTurns} 轮历史已省略，如需请向用户确认。）`
                  : ''
              }${
                steering.length > 0
                  ? `\n\n【用户中途指导（必须优先遵守，后续动作按此调整）】\n${steering.map((s, i) => `${i + 1}. ${s}`).join('\n')}`
                  : ''
              }`
            : system

        // 持久化路径 + 本轮尚未落库的累积块，拼出这次请求的完整消息序列
        const inMemory: Message[] = [{ ...assistantMessage, blocks: [...blocks], role: 'assistant' }]
        const messages: LLMMessage[] = [...context.messages, ...toLLMMessages(inMemory)]

        const toolUses: { id: string; name: string; input: unknown }[] = []

        let stopReason = 'stop'
        const firstByteTimeoutRaw = getSetting<number>('providers.firstByteTimeoutMs', 180_000)
        const firstByteTimeoutMs = resolveFirstByteTimeoutMs(firstByteTimeoutRaw)
        // Anthropic 提示词缓存默认开启；兼容网关不支持时可在设置里关掉
        const promptCache = getSetting<boolean>('provider.anthropic.promptCache', true)
        for await (const chunk of streamWithFallback(
          {
            model: resolved.model,
            system: effectiveSystem,
            messages,
            tools: offeredSchemas,
            maxTokens: resolvedEffort.maxTokens,
            reasoningEffort: resolvedEffort.reasoningEffort,
            promptCache
          },
          controller.signal,
          resolved.providerId,
          { firstByteTimeoutMs }
        )) {
          if (chunk.type === 'text') {
            const normalized = normalizeIncomingDelta(chunk.text, textStreamSnapshot)
            textStreamSnapshot = normalized.snapshot
            if (!normalized.delta) continue
            appendBlock(blocks, { type: 'text', text: normalized.delta })
            emit({
              type: 'text_delta',
              runId,
              conversationId: conversation.id,
              messageId: assistantMessage.id,
              text: normalized.delta
            })
          } else if (chunk.type === 'reasoning') {
            const normalized = normalizeIncomingDelta(chunk.text, reasoningStreamSnapshot)
            reasoningStreamSnapshot = normalized.snapshot
            if (!normalized.delta) continue
            appendBlock(blocks, { type: 'reasoning', text: normalized.delta })
            emit({
              type: 'reasoning_delta',
              runId,
              conversationId: conversation.id,
              messageId: assistantMessage.id,
              text: normalized.delta
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
            // 上游只回输出不回输入时，累计输入会恒为 0，UI 上表现为
            // 「累计输入 0 / 累计输出 N」的自相矛盾。这里留痕，便于定位是
            // 网关不返回 prompt_tokens，而不是本地统计算错。
            if (chunk.usage.promptTokens === 0 && chunk.usage.completionTokens > 0) {
              log.warn(
                `[usage] ${servedProviderId}/${servedModel} 未返回 prompt_tokens（输出 ${chunk.usage.completionTokens}），输入侧统计会失真`
              )
            }
            turnPromptTokens += chunk.usage.promptTokens
            turnCompletionTokens += chunk.usage.completionTokens
            turnCacheReadTokens += chunk.usage.cacheReadTokens ?? 0
            turnCacheWriteTokens += chunk.usage.cacheWriteTokens ?? 0
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
          break
        }

        const configuredConcurrency = getSetting<number>('agent.toolConcurrency', 4)
        const invokeOne = (call: { id: string; name: string; input: unknown }): Promise<{
          call: { id: string; name: string; input: unknown }
          result: ToolOutcome
        }> => {
          return hooks.invokeTool(
            runId,
            assistantMessage.id,
            call,
            conversation.id,
            conversation.workingDir,
            emit,
            controller,
            onNotify,
            (promptTokens, completionTokens, requests) => {
              turnPromptTokens += promptTokens
              turnCompletionTokens += completionTokens
              requestCount += requests
            }
          ).then((result) => ({ call, result }))
        }

        type Settled = { call: { id: string; name: string; input: unknown }; result: ToolOutcome }
        // 只读工具先并发跑，写工具与命令随后串行；结果始终按原 tool_use 顺序回填。
        const outcomes = await runToolBatch(toolUses, {
          concurrency: normalizeToolConcurrency(configuredConcurrency),
          canRunConcurrently: (call) => {
            const tool = toolRegistry.get(call.name)
            return isReadOnlyToolName(call.name) && !!tool && !tool.requiresApproval
          },
          invoke: async (call) => (await invokeOne(call)).result
        })
        const settled: Settled[] = toolUses.map((call, index) => ({
          call,
          result: outcomes[index]
        }))

        for (const { call, result } of settled) {
          blocks.push({
            type: 'tool_result',
            toolUseId: call.id,
            content: result.content,
            isError: result.isError,
            ...(result.image ? { image: result.image } : {})
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

        // 保险丝：打转就地暂停，不再浪费后面的步数。
        const stuckReason = noteToolBatch(settled)
        if (stuckReason) {
          stoppedByGuard = true
          const guardNotice = `\n\n_（${stuckReason}本轮已暂停，排除问题后回复「继续」。）_`
          appendBlock(blocks, { type: 'text', text: guardNotice })
          emit({
            type: 'text_delta',
            runId,
            conversationId: conversation.id,
            messageId: assistantMessage.id,
            text: guardNotice
          })
          repo.updateMessage(assistantMessage.id, {
            blocks: [...blocks],
            usage: hooks.composeUsage(lastUsage, turnPromptTokens, turnCompletionTokens, requestCount, stopReason, turnCacheReadTokens, turnCacheWriteTokens)
          })
          break
        }

        // 阶段性落库，进程意外退出时仍能看到已完成的部分
        repo.updateMessage(assistantMessage.id, {
          blocks: [...blocks],
          usage: hooks.composeUsage(lastUsage, turnPromptTokens, turnCompletionTokens, requestCount, stopReason, turnCacheReadTokens, turnCacheWriteTokens)
        })
      }

      // 思考耗尽预算：先自动续一次（跳过思考直接要正文），实在要不到才提示手动继续。
      // 否则下一轮会把同样的历史重想一遍，再次撞上 8192 上限。
      const hasText = blocks.some((b) => b.type === 'text' && b.text.trim().length > 0)
      const hasReasoning = blocks.some((b) => b.type === 'reasoning' && b.text.trim().length > 0)
      let truncatedByThinking =
        (finalStopReason === 'length' || finalStopReason === 'max_tokens') &&
        !hasText &&
        hasReasoning
      if (truncatedByThinking && !controller.signal.aborted) {
        for (let attempt = 0; attempt < 2 && truncatedByThinking; attempt++) {
          const persistedNow = repo.getPathTo(userMessage.id)
          const contextNow = buildContext(persistedNow, {
            system,
            budgetTokens: budget,
            extraTokens: toolSchemaTokens,
            toolResultMaxChars: effectiveToolResultMaxChars
          })
          await hydrateContextImages(contextNow)
          const inMemoryNow: Message[] = [{ ...assistantMessage, blocks: [...blocks], role: 'assistant' }]
          const continued: { id: string; name: string; input: unknown }[] = []
          let contStop = 'stop'
          // 续写沿用实际服务模型的档位映射，避免降级后用错上限。
          const contEffort = resolveEffort(servedModel, effort)
            const contPromptCache = getSetting<boolean>('provider.anthropic.promptCache', true)
          for await (const chunk of streamWithFallback(
            {
              model: servedModel,
              system: system + SKIP_THINKING_SUFFIX,
              messages: [...contextNow.messages, ...toLLMMessages(inMemoryNow)],
              tools: offeredSchemas,
              maxTokens: contEffort.maxTokens,
                reasoningEffort: contEffort.reasoningEffort,
                promptCache: contPromptCache
            },
            controller.signal,
            servedProviderId
          )) {
            if (chunk.type === 'text') {
              const normalized = normalizeIncomingDelta(chunk.text, textStreamSnapshot)
              textStreamSnapshot = normalized.snapshot
              if (!normalized.delta) continue
              appendBlock(blocks, { type: 'text', text: normalized.delta })
              emit({ type: 'text_delta', runId, conversationId: conversation.id, messageId: assistantMessage.id, text: normalized.delta })
            } else if (chunk.type === 'reasoning') {
              const normalized = normalizeIncomingDelta(chunk.text, reasoningStreamSnapshot)
              reasoningStreamSnapshot = normalized.snapshot
              if (!normalized.delta) continue
              appendBlock(blocks, { type: 'reasoning', text: normalized.delta })
              emit({ type: 'reasoning_delta', runId, conversationId: conversation.id, messageId: assistantMessage.id, text: normalized.delta })
            } else if (chunk.type === 'tool_use') {
              continued.push({ id: chunk.id, name: chunk.name, input: chunk.input })
            } else if (chunk.type === 'stop') {
              contStop = chunk.reason
            } else if (chunk.type === 'usage') {
              lastUsage = chunk.usage
              turnPromptTokens += chunk.usage.promptTokens
              turnCompletionTokens += chunk.usage.completionTokens
              turnCacheReadTokens += chunk.usage.cacheReadTokens ?? 0
              turnCacheWriteTokens += chunk.usage.cacheWriteTokens ?? 0
              requestCount++
              emit({ type: 'usage', runId, conversationId: conversation.id, messageId: assistantMessage.id, usage: chunk.usage })
            }
          }
          for (const call of continued) {
            blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.input })
            emit({ type: 'tool_use', runId, conversationId: conversation.id, messageId: assistantMessage.id, toolUseId: call.id, name: call.name, input: call.input })
          }
          const contPairs: { call: { id: string; name: string; input: unknown }; result: ToolOutcome }[] = []
          for (const call of continued) {
            const result = await hooks.invokeTool(runId, assistantMessage.id, call, conversation.id, conversation.workingDir, emit, controller, onNotify,
              (promptTokens, completionTokens, requests) => {
                turnPromptTokens += promptTokens
                turnCompletionTokens += completionTokens
                requestCount += requests
              })
            blocks.push({ type: 'tool_result', toolUseId: call.id, content: result.content, isError: result.isError, ...(result.image ? { image: result.image } : {}) })
            emit({ type: 'tool_result', runId, conversationId: conversation.id, messageId: assistantMessage.id, toolUseId: call.id, content: result.content, isError: result.isError })
            contPairs.push({ call, result })
          }
          const contStuck = noteToolBatch(contPairs)
          if (contStuck) {
            stoppedByGuard = true
            const guardNotice = `\n\n_（${contStuck}本轮已暂停，排除问题后回复「继续」。）_`
            appendBlock(blocks, { type: 'text', text: guardNotice })
            emit({ type: 'text_delta', runId, conversationId: conversation.id, messageId: assistantMessage.id, text: guardNotice })
            finalStopReason = contStop
            repo.updateMessage(assistantMessage.id, {
              blocks: [...blocks],
              usage: hooks.composeUsage(lastUsage, turnPromptTokens, turnCompletionTokens, requestCount, contStop, turnCacheReadTokens, turnCacheWriteTokens)
            })
            break
          }
          finalStopReason = contStop
          const gotText = blocks.some((b) => b.type === 'text' && b.text.trim().length > 0)
          truncatedByThinking = (contStop === 'length' || contStop === 'max_tokens') && !gotText
          repo.updateMessage(assistantMessage.id, {
            blocks: [...blocks],
            usage: hooks.composeUsage(lastUsage, turnPromptTokens, turnCompletionTokens, requestCount, contStop, turnCacheReadTokens, turnCacheWriteTokens)
          })
        }
      }
      const stillTruncated =
        (finalStopReason === 'length' || finalStopReason === 'max_tokens') &&
        !blocks.some((b) => b.type === 'text' && b.text.trim().length > 0) &&
        blocks.some((b) => b.type === 'reasoning' && b.text.trim().length > 0)
      if (stillTruncated) {
        const truncationNotice =
          `\n\n⚠️ **【智能截断保护】** 大模型的思考推导过程耗尽了单次最大 Token 预算（${resolvedEffort.maxTokens} tokens），在输出正式正文前被中断。\n\n💡 **已为您就绪断点续写机制**：请点击下方「⚡ 智能继续生成」或发送「继续」，大模型将跳过思考直接无缝吐出剩余正文与代码。`
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
      usage: hooks.composeUsage(lastUsage, turnPromptTokens, turnCompletionTokens, requestCount, finalStopReason, turnCacheReadTokens, turnCacheWriteTokens),
      model: servedModel,
      providerId: servedProviderId
    })
    // 只有当 activeLeaf 仍停在本回合的起点（用户消息）时才推进到新回复。
    // 生成期间用户可能已切换分支，直接覆盖会悄悄改掉用户的选择。
    if (repo.getActiveLeaf(conversation.id) === userMessage.id) {
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
