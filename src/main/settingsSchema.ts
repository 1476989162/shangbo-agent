import { z } from 'zod'

/**
 * settings:set 的完整键白名单：键 → zod schema。
 * 按本项目威胁模型渲染层不可信：没有这张表时兜底的 setSetting(key, value)
 * 允许写任意键和任意值——直接打开 agent.computerUse、关掉 agent.readOnly、
 * 篡改自动批准名单都只是一次 IPC 调用。白名单外的键一律抛错。
 */
export const SettingSchemas: Record<string, z.ZodType> = {
  // 数字类（带各自的业务范围）
  'agent.contextBudgetTokens': z
    .number()
    .int()
    .min(4000, '上下文预算需为 4000–1000000 之间的整数')
    .max(1_000_000, '上下文预算需为 4000–1000000 之间的整数'),
  'agent.maxSteps': z
    .number()
    .int()
    .min(1, '单轮步数上限需为 1–500 之间的整数')
    .max(500, '单轮步数上限需为 1–500 之间的整数'),
  'agent.wishMaxSteps': z
    .number()
    .int()
    .min(1, '许愿模式步数上限需为 1–500 之间的整数')
    .max(500, '许愿模式步数上限需为 1–500 之间的整数'),
  'agent.toolResultMaxChars': z
    .number()
    .int()
    .min(500, '工具输出截断需为 500–100000 之间的整数')
    .max(100_000, '工具输出截断需为 500–100000 之间的整数'),
  'providers.firstByteTimeoutMs': z
    .number()
    .int()
    .min(15_000, '首字节超时需为 15000–600000 之间的整数（毫秒）')
    .max(600_000, '首字节超时需为 15000–600000 之间的整数（毫秒）'),
  'agent.stuckLimit': z
    .number()
    .int()
    .min(1, '打转保险丝灵敏度需为 1–100 之间的整数')
    .max(100, '打转保险丝灵敏度需为 1–100 之间的整数'),
  // 布尔开关
  'agent.computerUse': z.boolean(),
  'agent.readOnly': z.boolean(),
  // 自治等级：strict 全确认 / balanced 工作区自治 / trusted 软风险自治；硬红线不受影响
  'agent.autonomy': z.enum(['strict', 'balanced', 'trusted']),
  // 渲染层自动同意普通审批（硬红线 critical 永不自动同意），默认关闭
  'agent.autoApproveSoft': z.boolean(),
  // 轮间摘要默认关闭：开启后调用当前模型生成摘要，会产生额外请求
  'agent.context.summarize': z.boolean(),
  'agent.wish.enabled': z.boolean(),
  'agent.wish.autoApproveWorkspace': z.boolean(),
  'agent.wish.autoVerify': z.boolean(),
  'agent.wish.evolve': z.boolean(),
  'agent.wish.verifyRetries': z.number().int().min(0).max(10),
  'agent.wish.dailyRunLimit': z.number().int().min(1).max(100),
  'agent.autonomous.enabled': z.boolean(),
  'agent.notifyCompletion': z.boolean(),
  'agent.reduceMotion': z.boolean(),
  'cowork.useMemory': z.boolean(),
  'agent.browser.builtin': z.boolean(),
  'agent.browser.external': z.boolean(),
  'agent.browser.autoScreenshot': z.boolean(),
  // 自更新：是否自动检查、发现后是否自动下载。安装永远需要用户确认。
  'app.update.check': z.boolean(),
  'app.update.autoDownload': z.boolean(),
  // Anthropic 提示词缓存：部分兼容网关不支持 cache_control，需要能关掉
  'provider.anthropic.promptCache': z.boolean(),
  // 文本
  'agent.instructions': z.string().max(20_000, '通用指导过长'),
  'agent.effort': z.string().max(50),
  'agent.mode': z.string().max(50),
  'agent.workRole': z.string().max(200),
  'agent.chatFont': z.string().max(100),
  'app.theme': z.string().max(50),
  'chat.model': z.string().max(200),
  'chat.providerId': z.string().max(200),
  'cowork.filesPath': z.string().max(1000),
  'cowork.globalInstructions': z.string().max(20_000, '全局指导过长'),
  // 手机远程（只能桌面本机改，远程通道无 settings:set）
  'remote.enabled': z.boolean(),
  'remote.relayUrl': z.string().max(500),
  // 中转准入密钥：与中转侧 RELAY_ACCESS_KEY 一致，留空表示该中转不设准入
  'remote.accessKey': z.string().max(200),
  'remote.approvalPolicy': z.enum(['allow-all', 'confirm-high', 'read-only']),
  // 枚举
  'agent.browser.default': z.enum(['external', 'builtin']),
  // 字符串数组
  'agent.plugins': z.array(z.string().max(100)).max(50),
  'agent.mcpServers': z.array(z.string().max(200)).max(200),
  'chat.hiddenModels': z.array(z.string().max(200)).max(1000),
  'cowork.trustedFolders': z.array(z.string().max(1000)).max(1000),
  // 安全相关：自动批准名单。成员必须是已知工具名（MCP 工具动态注册，
  // 以 mcp__ 前缀放行），由 parseSettingValue 按 knownToolNames 附加校验
  'tools.autoApprove': z.array(z.string().max(200)).max(200),
  // 结构化数组：元素必须是对象，具体字段由各自读取方容错
  'agent.mcp.servers': z.array(z.record(z.string(), z.unknown())).max(100),
  'cowork.memories': z.array(z.record(z.string(), z.unknown())).max(500),
  'agent.wish.verifyCommand': z.string().max(2000),
  'agent.wish.acceptance': z.string().max(10_000)
}

/**
 * 校验一个待写入的设置项，返回通过校验的值。
 * 白名单外的键、类型不符的值都抛错；tools.autoApprove 的成员
 * 在提供 knownToolNames 时进一步校验为已知工具名。
 */
export function parseSettingValue(
  key: string,
  value: unknown,
  opts?: { knownToolNames?: string[] }
): unknown {
  const schema = SettingSchemas[key]
  if (!schema) {
    throw new Error(`不支持的设置项：${key}。该键不在设置白名单内，已拒绝写入。`)
  }
  const parsed = schema.parse(value)
  if (key === 'tools.autoApprove' && opts?.knownToolNames) {
    const known = new Set(opts.knownToolNames)
    for (const name of parsed as string[]) {
      if (!known.has(name) && !name.startsWith('mcp__')) {
        throw new Error(`自动批准名单包含未知工具：${name}`)
      }
    }
  }
  return parsed
}
