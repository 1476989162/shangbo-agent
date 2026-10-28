/** 审批原因命中安全护栏时，卡片使用高危样式。 */
export function isSecurityCriticalApproval(reason: string): boolean {
  return reason.includes('Freebuff') || reason.includes('安全护栏') || reason.includes('安全红线')
}

/**
 * 渲染层「自动同意常规审批」开关是否应直接批准这条审批。
 *
 * 只按 severity 判定：硬红线由主进程标记为 critical，无论开关如何设置都不会自动同意；
 * 其余普通审批在开关打开时直接放行。开关默认关闭，且状态持久化在主进程设置里。
 */
export function shouldAutoApproveApproval(
  event: { severity?: 'normal' | 'critical' },
  enabled: boolean
): boolean {
  if (!enabled) return false
  return (event.severity ?? 'normal') !== 'critical'
}

/** 审批参数格式化失败时退回字符串，避免整个卡片无法渲染。 */
export function formatApprovalInput(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}
