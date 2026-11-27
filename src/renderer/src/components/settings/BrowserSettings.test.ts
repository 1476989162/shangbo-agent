// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import BrowserSettings from './BrowserSettings.vue'

let mounted: Array<{ unmount: () => void }> = []

afterEach(() => {
  for (const w of mounted) w.unmount()
  mounted = []
  vi.useRealTimers()
  vi.restoreAllMocks()
})

interface BrowserMocks {
  chromeDetails: ReturnType<typeof vi.fn>
  launchChrome: ReturnType<typeof vi.fn>
  clearData: ReturnType<typeof vi.fn>
  mcpStatus: ReturnType<typeof vi.fn>
  settingsGetAll: ReturnType<typeof vi.fn>
  settingsSet: ReturnType<typeof vi.fn>
}

function installShangbo(overrides: Partial<BrowserMocks> = {}): BrowserMocks {
  const mocks: BrowserMocks = {
    chromeDetails: vi.fn(async () => ({ connected: false })),
    launchChrome: vi.fn(async () => ({ ok: true, alreadyRunning: true, message: 'running' })),
    clearData: vi.fn(async () => true),
    mcpStatus: vi.fn(async () => [
      { id: 'playwright', name: 'Playwright', enabled: true, state: 'ready', toolCount: 25 },
      { id: 'chrome-devtools', name: 'Chrome DevTools', enabled: true, state: 'error', toolCount: 0, error: 'spawn ENOENT' }
    ]),
    settingsGetAll: vi.fn(async () => ({})),
    settingsSet: vi.fn(async () => true),
    ...overrides
  }
  const g = globalThis as unknown as { window: Record<string, unknown> }
  g.window.shangbo = {
    browser: {
      chromeDetails: mocks.chromeDetails,
      launchChrome: mocks.launchChrome,
      clearData: mocks.clearData
    },
    mcp: { status: mocks.mcpStatus },
    settings: { getAll: mocks.settingsGetAll, set: mocks.settingsSet }
  }
  return mocks
}

async function mountBrowser(overrides: Partial<BrowserMocks> = {}) {
  const mocks = installShangbo(overrides)
  const wrapper = mount(BrowserSettings)
  mounted.push(wrapper)
  await flushPromises()
  await flushPromises()
  await nextTick()
  return { wrapper, mocks }
}

describe('BrowserSettings 真实闭环', () => {
  it('无假「导入」按钮；内置卡片诚实说明预览栏范围', async () => {
    const { wrapper } = await mountBrowser()
    expect(wrapper.text()).not.toContain('导入')
    expect(wrapper.text()).toContain('仅清除右侧预览栏站点数据')
  })

  it('展示 Playwright 已就绪与 Chrome DevTools 真实报错', async () => {
    const { wrapper } = await mountBrowser()
    expect(wrapper.text()).toContain('Playwright')
    expect(wrapper.text()).toContain('25 个工具')
    expect(wrapper.text()).toContain('Chrome DevTools')
    expect(wrapper.text()).toContain('spawn ENOENT')
  })

  it('点击「启动并检测」调用 browser.launchChrome 并 emit feedback', async () => {
    const { wrapper, mocks } = await mountBrowser()
    const launchBtn = wrapper.findAll('button').find((b) => b.text() === '启动并检测')
    expect(launchBtn, '找不到"启动并检测"按钮').toBeDefined()
    await launchBtn!.trigger('click')
    await flushPromises()
    await nextTick()
    expect(mocks.launchChrome).toHaveBeenCalledTimes(1)
    const feedbacks = wrapper.emitted('feedback') as Array<[{ ok: boolean; message: string }]> | undefined
    expect(feedbacks?.length).toBeGreaterThan(0)
    expect(feedbacks![feedbacks!.length - 1][0].ok).toBe(true)
  })

  it('9222 开关写 browser.chromeAttach9222', async () => {
    const { wrapper, mocks } = await mountBrowser()
    const boxes = wrapper.findAll('input[type="checkbox"]')
    // 引擎开关 ×2 + 附着开关 ×1，附着开关在最后
    expect(boxes.length).toBe(3)
    await boxes[boxes.length - 1].setValue(true)
    await flushPromises()
    await nextTick()
    expect(mocks.settingsSet).toHaveBeenCalledWith('browser.chromeAttach9222', true)
  })

  it('引擎开关走 settings 双写', async () => {
    const { wrapper, mocks } = await mountBrowser()
    const boxes = wrapper.findAll('input[type="checkbox"]')
    await boxes[0].setValue(false)
    await flushPromises()
    await nextTick()
    const keys = mocks.settingsSet.mock.calls.map((c) => c[0] as string)
    expect(keys).toContain('agent.mcpServers')
    expect(keys).toContain('agent.mcp.servers')
  })

  it('连接器按钮 emit navigate(connectors)', async () => {
    const { wrapper } = await mountBrowser()
    const btn = wrapper.findAll('button').find((b) => b.text() === '连接器 / MCP')
    expect(btn, '找不到"连接器 / MCP"按钮').toBeDefined()
    await btn!.trigger('click')
    expect(wrapper.emitted('navigate')).toEqual([['connectors']])
  })
})

describe('BrowserSettings 异步卸载守卫', () => {
  it('chromeDetails 悬挂期间卸载：resolve 后无状态写入、无 feedback', async () => {
    let resolveDetails!: (value: { connected: boolean; browser?: string }) => void
    const detailsGate = new Promise<{ connected: boolean; browser?: string }>((resolve) => {
      resolveDetails = resolve
    })
    installShangbo({
      chromeDetails: vi.fn(() => detailsGate),
      mcpStatus: vi.fn(async () => [])
    })
    const wrapper = mount(BrowserSettings)
    await flushPromises()
    wrapper.unmount()
    resolveDetails({ connected: true, browser: 'Chrome/145.0' })
    await flushPromises()
    await flushPromises()
    await nextTick()
    expect(wrapper.emitted('feedback')).toBeUndefined()
  })

  it('mcp.status 悬挂期间卸载：resolve 后不抛错', async () => {
    let resolveMcp!: (value: unknown[]) => void
    const mcpGate = new Promise<unknown[]>((resolve) => {
      resolveMcp = resolve
    })
    installShangbo({
      chromeDetails: vi.fn(async () => ({ connected: false })),
      mcpStatus: vi.fn(() => mcpGate)
    })
    const wrapper = mount(BrowserSettings)
    mounted.push(wrapper)
    await flushPromises()
    wrapper.unmount()
    mounted = []
    resolveMcp([])
    await flushPromises()
    await flushPromises()
    expect(wrapper.emitted('feedback')).toBeUndefined()
  })
})
