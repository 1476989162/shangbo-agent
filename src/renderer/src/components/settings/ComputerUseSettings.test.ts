// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import ComputerUseSettings from './ComputerUseSettings.vue'

let mounted: Array<{ unmount: () => void }> = []

afterEach(() => {
  for (const w of mounted) w.unmount()
  mounted = []
  vi.useRealTimers()
  vi.restoreAllMocks()
})

interface ComputerMocks {
  probe: ReturnType<typeof vi.fn>
  settingsGetAll: ReturnType<typeof vi.fn>
  settingsSet: ReturnType<typeof vi.fn>
}

function readyProbe() {
  return {
    agentDesktop: { available: true, binary: 'C:\\agent-desktop.exe' },
    nutJs: { available: true },
    emergencyStop: { accelerator: 'CommandOrControl+Alt+X', displayLabel: 'Ctrl+Alt+X', registered: true }
  }
}

function installShangbo(overrides: Partial<ComputerMocks> = {}): ComputerMocks {
  const mocks: ComputerMocks = {
    probe: vi.fn(async () => readyProbe()),
    settingsGetAll: vi.fn(async () => ({ 'agent.computerUse': true })),
    settingsSet: vi.fn(async () => true),
    ...overrides
  }
  const g = globalThis as unknown as { window: Record<string, unknown> }
  g.window.shangbo = {
    computer: { probe: mocks.probe },
    settings: { getAll: mocks.settingsGetAll, set: mocks.settingsSet }
  }
  return mocks
}

async function mountComputer(overrides: Partial<ComputerMocks> = {}) {
  const mocks = installShangbo(overrides)
  const wrapper = mount(ComputerUseSettings)
  mounted.push(wrapper)
  await flushPromises()
  await flushPromises()
  await nextTick()
  return { wrapper, mocks }
}

describe('ComputerUseSettings 双通道自检', () => {
  it('挂载自动调用 probe 并展示就绪态', async () => {
    const { wrapper, mocks } = await mountComputer()
    expect(mocks.probe).toHaveBeenCalledTimes(1)
    expect(wrapper.text()).toContain('agent-desktop')
    expect(wrapper.text()).toContain('C:\\agent-desktop.exe')
    expect(wrapper.text()).toContain('nut-js')
    expect(wrapper.text()).toContain('Ctrl+Alt+X')
    expect(wrapper.text()).toContain('已注册')
  })

  it('失败态展示真实错误，不伪装可用', async () => {
    const { wrapper } = await mountComputer({
      probe: vi.fn(async () => ({
        agentDesktop: { available: false, binary: null, reason: '未找到 agent-desktop CLI' },
        nutJs: { available: false, error: 'native binding 缺失' },
        emergencyStop: { accelerator: 'CommandOrControl+Alt+X', displayLabel: 'Ctrl+Alt+X', registered: false }
      }))
    })
    expect(wrapper.text()).toContain('未找到 agent-desktop CLI')
    expect(wrapper.text()).toContain('native binding 缺失')
    expect(wrapper.text()).toContain('未注册')
  })

  it('无 Esc 误导文案，急停热键真实展示', async () => {
    const { wrapper } = await mountComputer()
    expect(wrapper.text()).not.toContain('Esc')
    expect(wrapper.text()).toContain('Ctrl+Alt+X')
  })

  it('切换电脑控制开关写 agent.computerUse 并 emit feedback', async () => {
    const { wrapper, mocks } = await mountComputer()
    const box = wrapper.find('input[type="checkbox"]')
    await box.setValue(false)
    await flushPromises()
    await nextTick()
    expect(mocks.settingsSet).toHaveBeenCalledWith('agent.computerUse', false)
    const feedbacks = wrapper.emitted('feedback') as Array<[{ ok: boolean; message: string }]> | undefined
    expect(feedbacks?.length).toBeGreaterThan(0)
  })

  it('probe 抛错展示自检失败', async () => {
    const { wrapper } = await mountComputer({
      probe: vi.fn(async () => {
        throw new Error('IPC 断开')
      })
    })
    expect(wrapper.text()).toContain('自检失败')
    expect(wrapper.text()).toContain('IPC 断开')
  })
})
