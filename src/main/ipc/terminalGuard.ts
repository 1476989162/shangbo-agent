import { auditCommandSecurity, commandTouchesPrivateData } from '../tools'

/**
 * 工作台终端（右侧文件查看器里的命令行）的护栏。
 *
 * 为什么需要这一层：`app:execCommand` 是渲染进程可直接调用的通道，而渲染进程里
 * 渲染着模型输出与工具结果（可能夹带提示注入）。如果这里不做与工具层一致的检查，
 * 一句 `type %APPDATA%\shangbo-agent\secrets.json` 就绕过了审批、把密钥读进界面、
 * 再随下一轮对话发给供应商——README 里「密钥不会进入对话上下文」的承诺就破了。
 *
 * 分工与工具层保持一致：
 * - 触碰密钥库 / 会话数据库：直接拒绝，不存在批准后放行的路径；
 * - CRITICAL 级擦盘命令：直接拒绝；
 * - 其余命令放行（终端是用户自己敲的，不是模型代劳，日常删除子目录不应被拦死）。
 */
export interface TerminalGuardResult {
  blocked: boolean
  reason?: string
}

export function checkTerminalCommand(command: string, cwd?: string): TerminalGuardResult {
  if (commandTouchesPrivateData(command, cwd)) {
    return {
      blocked: true,
      reason: '禁止访问应用私有数据：该命令触碰存放密钥与数据库的位置。'
    }
  }
  const audit = auditCommandSecurity(command)
  if (audit.isDangerous && audit.severity === 'CRITICAL') {
    return {
      blocked: true,
      reason: audit.reason ?? '【安全护栏拦截】检测到高危系统级操作，已拒绝执行。'
    }
  }
  return { blocked: false }
}
