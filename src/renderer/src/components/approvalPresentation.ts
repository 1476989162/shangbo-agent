/** 审批原因命中安全护栏时，卡片使用高危样式。 */
export function isSecurityCriticalApproval(reason: string): boolean {
  return reason.includes('Freebuff') || reason.includes('安全护栏') || reason.includes('安全红线')
}

/** 审批参数格式化失败时退回字符串，避免整个卡片无法渲染。 */
export function formatApprovalInput(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}
