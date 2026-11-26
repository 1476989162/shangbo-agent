// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import type { ComponentPublicInstance } from 'vue'
import ApprovalPanel from './ApprovalPanel.vue'
import type { ApprovalRequest } from '../stores/chat'

let mounted: Array<{ unmount: () => void }> = []

afterEach(() => {
  for (const w of mounted) w.unmount()
  mounted = []
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function makeApproval(overrides: Partial<ApprovalRequest> = {}): ApprovalRequest {
  return {
    runId: 'r1',
    toolUseId: 't1',
    name: 'run_command',
    input: { command: 'npm test' },
    reason: '需要确认',
    severity: 'normal',
    autoApprovable: true,
    ...overrides
  }
}

function buttonByText(wrapper: VueWrapper<ComponentPublicInstance>, text: string) {
  const found = wrapper.findAll('button').find((b) => b.text().includes(text))
  expect(found, `找不到按钮「${text}」`).toBeDefined()
  return found!
}

describe('ApprovalPanel 普通审批', () => {
  it('渲染确认文案/工具名/参数，三个按钮各发一次 decide', async () => {
    const wrapper = mount(ApprovalPanel, { props: { approval: makeApproval() } })
    mounted.push(wrapper)

    expect(wrapper.text()).toContain('需要操作确认')
    expect(wrapper.text()).toContain('run_command')
    expect(wrapper.text()).toContain('npm test')

    const buttons = wrapper.findAll('button')
    expect(buttons.map((b) => b.text())).toEqual(
      expect.arrayContaining(['允许这一次', '始终允许该工具', '拒绝操作'])
    )

    await buttonByText(wrapper, '允许这一次').trigger('click')
    await buttonByText(wrapper, '始终允许该工具').trigger('click')
    await buttonByText(wrapper, '拒绝操作').trigger('click')

    expect(wrapper.emitted('decide')).toEqual([
      [true, false],
      [true, true],
      [false, false]
    ])
  })

  it('autoApprovable=false 时不渲染始终允许按钮', () => {
    const wrapper = mount(ApprovalPanel, {
      props: { approval: makeApproval({ autoApprovable: false }) }
    })
    mounted.push(wrapper)

    expect(wrapper.text()).toContain('需要操作确认')
    expect(wrapper.text()).not.toContain('始终允许该工具')
    expect(wrapper.findAll('button')).toHaveLength(2)
  })
})

describe('ApprovalPanel 安全红线强约束', () => {
  it('critical 即使 autoApprovable=true 也不给始终允许，确认只放行一次', async () => {
    const wrapper = mount(ApprovalPanel, {
      props: { approval: makeApproval({ severity: 'critical', reason: '删库高危操作' }) }
    })
    mounted.push(wrapper)

    expect(wrapper.classes()).toContain('critical-security-card')
    expect(wrapper.find('.critical-security-card').exists()).toBe(true)
    expect(wrapper.text()).toContain('安全红线 · 必须人工确认')
    expect(wrapper.text()).not.toContain('始终允许该工具')

    await buttonByText(wrapper, '我已知晓风险，仍执行一次').trigger('click')
    expect(wrapper.emitted('decide')).toEqual([[true, false]])
  })

  it('severity 缺失但 reason 命中红线关键词时同样按红线处理', async () => {
    const approval = makeApproval({
      reason: '触碰安全红线：格式化磁盘',
      autoApprovable: true
    }) as unknown as ApprovalRequest & { severity: undefined }
    // 运行时缺失 severity，组件按 isSecurityCriticalApproval(reason) 兜底
    delete (approval as { severity?: unknown }).severity
    const wrapper = mount(ApprovalPanel, { props: { approval: approval as ApprovalRequest } })
    mounted.push(wrapper)

    expect(wrapper.find('.critical-security-card').exists()).toBe(true)
    expect(wrapper.text()).toContain('安全红线 · 必须人工确认')
    expect(wrapper.text()).not.toContain('始终允许该工具')

    await buttonByText(wrapper, '我已知晓风险，仍执行一次').trigger('click')
    await buttonByText(wrapper, '拒绝操作').trigger('click')
    expect(wrapper.emitted('decide')).toEqual([
      [true, false],
      [false, false]
    ])
  })
})
