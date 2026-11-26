// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import RemoteSettings from './RemoteSettings.vue'

let mounted: Array<{ unmount: () => void }> = []

afterEach(() => {
  for (const w of mounted) w.unmount()
  mounted = []
  vi.useRealTimers()
  vi.restoreAllMocks()
})

interface ShangboMocks {
  settingsGetAll: ReturnType<typeof vi.fn>
  settingsSet: ReturnType<typeof vi.fn>
  status: ReturnType<typeof vi.fn>
  devices: ReturnType<typeof vi.fn>
  pending: ReturnType<typeof vi.fn>
  identity: ReturnType<typeof vi.fn>
}

function installShangbo(overrides: Partial<ShangboMocks> = {}): ShangboMocks {
  const mocks: ShangboMocks = {
    settingsGetAll: vi.fn(async () => ({})),
    settingsSet: vi.fn(async () => true),
    status: vi.fn(async () => ({ enabled: false, status: '', detail: '' })),
    devices: vi.fn(async () => []),
    pending: vi.fn(async () => []),
    identity: vi.fn(async () => ({ publicKeyB64: 'x', fingerprint: '' })),
    ...overrides
  }
  const g = globalThis as unknown as { window: Record<string, unknown> }
  g.window.shangbo = {
    settings: { getAll: mocks.settingsGetAll, set: mocks.settingsSet },
    remote: {
      status: mocks.status,
      devices: mocks.devices,
      pending: mocks.pending,
      identity: mocks.identity,
      pair: vi.fn(),
      confirmPairing: vi.fn(),
      denyPairing: vi.fn(),
      revoke: vi.fn(),
      disconnect: vi.fn()
    }
  }
  return mocks
}

describe('RemoteSettings 读取与展示', () => {
  it('挂载后回填开关/地址/策略并展示设备与待确认列表', async () => {
    installShangbo({
      settingsGetAll: vi.fn(async () => ({
        'remote.enabled': true,
        'remote.relayUrl': 'wss://relay.example.com',
        'remote.accessKey': '',
        'remote.approvalPolicy': 'confirm-high'
      })),
      status: vi.fn(async () => ({ enabled: true, status: '已连接', detail: '2 台在线' })),
      devices: vi.fn(async () => [
        { id: 'd1', name: 'Pixel', createdAt: 1700000000000, lastSeenAt: null }
      ]),
      pending: vi.fn(async () => [
        {
          deviceName: 'iPhone',
          phonePubB64: 'x',
          phoneToken: 'tok1',
          fingerprint: 'fp1',
          receivedAt: 1700000001000
        }
      ]),
      identity: vi.fn(async () => ({ publicKeyB64: 'y', fingerprint: 'FP123' }))
    })
    const wrapper = mount(RemoteSettings)
    mounted.push(wrapper)
    await flushPromises()
    await flushPromises()
    await nextTick()

    const checkbox = wrapper.find('input[type="checkbox"]').element as HTMLInputElement
    expect(checkbox.checked).toBe(true)
    const relayInput = wrapper.find('input[placeholder="wss://relay.example.com"]')
      .element as HTMLInputElement
    expect(relayInput.value).toBe('wss://relay.example.com')
    const policy = wrapper.find('select.select-control').element as HTMLSelectElement
    expect(policy.value).toBe('confirm-high')
    expect(wrapper.text()).toContain('已连接')
    expect(wrapper.text()).toContain('Pixel')
    expect(wrapper.text()).toContain('iPhone')
    expect(wrapper.text()).toContain('FP123')
  })
})

describe('RemoteSettings 交互落盘', () => {
  it('切换开关调用 settings.set 并 emit feedback', async () => {
    const mocks = installShangbo({
      settingsGetAll: vi.fn(async () => ({ 'remote.enabled': false }))
    })
    const wrapper = mount(RemoteSettings)
    mounted.push(wrapper)
    await flushPromises()
    await flushPromises()
    await nextTick()

    const checkbox = wrapper.find('input[type="checkbox"]')
    await checkbox.setValue(true)
    await flushPromises()
    await nextTick()

    expect(mocks.settingsSet).toHaveBeenCalledWith('remote.enabled', true)
    const feedbacks = wrapper.emitted('feedback') as Array<[{ ok: boolean; message: string }]>
    expect(feedbacks?.length).toBeGreaterThan(0)
    expect(feedbacks[feedbacks.length - 1][0].ok).toBe(true)
  })

  it('保存中转地址调用 settings.set 并 emit feedback', async () => {
    const mocks = installShangbo()
    const wrapper = mount(RemoteSettings)
    mounted.push(wrapper)
    await flushPromises()
    await flushPromises()
    await nextTick()

    const relayInput = wrapper.find('input[placeholder="wss://relay.example.com"]')
    await relayInput.setValue('wss://new.example.com')
    const saveBtn = wrapper
      .findAll('button')
      .find((b) => b.text() === '保存')
    expect(saveBtn, '找不到 relay 保存按钮').toBeDefined()
    await saveBtn!.trigger('click')
    await flushPromises()

    expect(mocks.settingsSet).toHaveBeenCalledWith('remote.relayUrl', 'wss://new.example.com')
    expect(wrapper.emitted('feedback')).toBeDefined()
  })
})

describe('RemoteSettings 异步卸载回归 c332ba9', () => {
  it('status 悬挂期间卸载：resolve 后 pending 永不被轮询且无残留定时器', async () => {
    vi.useFakeTimers()
    try {
      let resolveStatus!: (value: { enabled: boolean; status: string; detail: string }) => void
      const statusGate = new Promise<{ enabled: boolean; status: string; detail: string }>(
        (resolve) => {
          resolveStatus = resolve
        }
      )
      const pending = vi.fn(async () => [])
      installShangbo({
        status: vi.fn(() => statusGate),
        pending,
        devices: vi.fn(async () => []),
        identity: vi.fn(async () => ({ publicKeyB64: 'x', fingerprint: '' }))
      })

      const wrapper = mount(RemoteSettings)
      // 挂载后立刻卸载：此时 status() 仍悬挂，loadRemote 卡在第一个 await
      await flushPromises()
      expect(pending).not.toHaveBeenCalled()
      wrapper.unmount()

      // 悬挂的 status 在卸载后才 resolve，再推进 10 秒轮询周期
      resolveStatus({ enabled: false, status: '', detail: '' })
      await flushPromises()
      await flushPromises()
      vi.advanceTimersByTime(10000)
      await flushPromises()

      expect(pending).not.toHaveBeenCalled()
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      vi.useRealTimers()
    }
  })
})
