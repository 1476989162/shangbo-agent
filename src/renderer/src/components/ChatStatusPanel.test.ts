// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import ChatStatusPanel from './ChatStatusPanel.vue'
import type { RetryInfo, SwitchNotice } from '../stores/chat'
import type { TodoItem } from '@shared/types'

let mounted: Array<{ unmount: () => void }> = []

afterEach(() => {
  for (const w of mounted) w.unmount()
  mounted = []
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function track<T extends { unmount: () => void }>(wrapper: T): T {
  mounted.push(wrapper)
  return wrapper
}

function baseProps() {
  return {
    todos: [] as TodoItem[],
    retry: null as RetryInfo | null,
    switchNotice: null as SwitchNotice | null,
    error: null as string | null,
    canScrollToBottom: false,
    streaming: false
  }
}

describe('ChatStatusPanel 任务清单', () => {
  it('展示已完成/总数，默认折叠，点击标题展开列表与状态类', async () => {
    const todos: TodoItem[] = [
      { id: '1', content: '做 A', status: 'completed' },
      { id: '2', content: '做 B', status: 'in_progress' },
      { id: '3', content: '做 C', status: 'pending' }
    ]
    const wrapper = track(mount(ChatStatusPanel, { props: { ...baseProps(), todos } }))

    expect(wrapper.text()).toContain('1/3')
    expect(wrapper.find('ul').exists()).toBe(false)

    await wrapper.find('.todo-toggle').trigger('click')

    const items = wrapper.findAll('.todo-item')
    expect(items).toHaveLength(3)
    expect(items[0].classes()).toContain('completed')
    expect(items[1].classes()).toContain('in_progress')
    expect(items[0].text()).toContain('做 A')
    expect(items[2].text()).toContain('做 C')
  })
})

describe('ChatStatusPanel 重试倒计时', () => {
  it('retry 出现后倒计时递减，卸载时定时器彻底清理', async () => {
    vi.useFakeTimers()
    try {
      const wrapper = track(
        mount(ChatStatusPanel, {
          props: {
            ...baseProps(),
            retry: null
          }
        })
      )

      await wrapper.setProps({
        retry: {
          providerName: 'P',
          attempt: 1,
          maxAttempts: 5,
          waitMs: 3000,
          reason: '限流'
        }
      })
      await nextTick()

      expect(wrapper.find('.retry-banner').exists()).toBe(true)
      expect(wrapper.find('.retry-text strong').text()).toBe('3')

      vi.advanceTimersByTime(1000)
      await nextTick()
      expect(wrapper.find('.retry-text strong').text()).toBe('2')

      vi.advanceTimersByTime(2000)
      await nextTick()
      expect(wrapper.find('.retry-text strong').text()).toBe('0')

      wrapper.unmount()
      mounted = mounted.filter((w) => w !== wrapper)
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('ChatStatusPanel 通知条按钮', () => {
  it('切换通知"知道了"触发 dismissSwitchNotice', async () => {
    const switchNotice: SwitchNotice = {
      fromProviderName: 'A',
      providerName: 'B',
      model: 'm',
      reason: '429 限流'
    }
    const wrapper = track(mount(ChatStatusPanel, { props: { ...baseProps(), switchNotice } }))

    const buttons = wrapper.findAll('button')
    const target = buttons.find((b) => b.text().includes('知道了'))
    expect(target, '找不到"知道了"按钮').toBeDefined()
    await target!.trigger('click')
    expect(wrapper.emitted('dismissSwitchNotice')).toHaveLength(1)
  })

  it('错误条"关闭"触发 dismissError', async () => {
    const wrapper = track(mount(ChatStatusPanel, { props: { ...baseProps(), error: '出错了' } }))

    expect(wrapper.text()).toContain('出错了')
    const buttons = wrapper.findAll('button')
    const target = buttons.find((b) => b.text().includes('关闭'))
    expect(target, '找不到"关闭"按钮').toBeDefined()
    await target!.trigger('click')
    expect(wrapper.emitted('dismissError')).toHaveLength(1)
  })

  it('回到底部按钮触发 scrollToBottom', async () => {
    const wrapper = track(
      mount(ChatStatusPanel, { props: { ...baseProps(), canScrollToBottom: true, streaming: true } })
    )

    const fab = wrapper.find('button.scroll-bottom-fab')
    expect(fab.exists()).toBe(true)
    await fab.trigger('click')
    expect(wrapper.emitted('scrollToBottom')).toHaveLength(1)
  })

  it('重试条"停止等待"触发 stop', async () => {
    const retry: RetryInfo = {
      providerName: 'P',
      attempt: 2,
      maxAttempts: 5,
      waitMs: 5000,
      reason: '超时'
    }
    const wrapper = track(mount(ChatStatusPanel, { props: { ...baseProps(), retry } }))

    const buttons = wrapper.findAll('button')
    const target = buttons.find((b) => b.text().includes('停止等待'))
    expect(target, '找不到"停止等待"按钮').toBeDefined()
    await target!.trigger('click')
    expect(wrapper.emitted('stop')).toHaveLength(1)
  })
})
