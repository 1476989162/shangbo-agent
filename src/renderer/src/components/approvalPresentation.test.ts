import { describe, expect, it } from 'vitest'
import {
  formatApprovalInput,
  isSecurityCriticalApproval,
  shouldAutoApproveApproval
} from './approvalPresentation'

describe('approvalPresentation', () => {
  it('识别安全护栏相关的高危审批原因', () => {
    expect(isSecurityCriticalApproval('命中 Freebuff 安全审计')).toBe(true)
    expect(isSecurityCriticalApproval('触碰安全护栏')).toBe(true)
    expect(isSecurityCriticalApproval('越过安全红线')).toBe(true)
    expect(isSecurityCriticalApproval('普通命令需要确认')).toBe(false)
  })

  it('自动同意开关只放行普通审批，硬红线始终拦截', () => {
    expect(shouldAutoApproveApproval({ severity: 'normal' }, false)).toBe(false)
    expect(shouldAutoApproveApproval({ severity: 'normal' }, true)).toBe(true)
    expect(shouldAutoApproveApproval({ severity: 'critical' }, true)).toBe(false)
    expect(shouldAutoApproveApproval({}, true)).toBe(true)
  })

  it('以可读 JSON 展示审批参数', () => {
    expect(formatApprovalInput({ command: 'npm test', nested: { ok: true } })).toBe(
      '{\n  "command": "npm test",\n  "nested": {\n    "ok": true\n  }\n}'
    )
  })

  it('循环引用等无法序列化的值退回字符串', () => {
    const input: Record<string, unknown> = {}
    input.self = input
    expect(formatApprovalInput(input)).toBe('[object Object]')
  })
})
