// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import PluginsSettings from './PluginsSettings.vue'

let mounted: Array<{ unmount: () => void }> = []

afterEach(() => {
  for (const w of mounted) w.unmount()
  mounted = []
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function installShangbo(settings: Record<string, unknown> = {}) {
  const settingsGetAll = vi.fn(async () => ({ ...settings }))
  const settingsSet = vi.fn(async () => true)
  const pickFolder = vi.fn(async () => null as string | null)
  const g = globalThis as unknown as { window: Record<string, unknown> }
  g.window.shangbo = {
    settings: { getAll: settingsGetAll, set: settingsSet },
    dialog: { pickFolder }
  }
  return { settingsGetAll, settingsSet, pickFolder }
}

beforeEach(() => {
  setActivePinia(createPinia())
})

async function mountPlugins(settings: Record<string, unknown> = {}) {
  const mocks = installShangbo(settings)
  const wrapper = mount(PluginsSettings, { props: { tab: 'plugins' } })
  mounted.push(wrapper)
  await flushPromises()
  await flushPromises()
  await nextTick()
  return { wrapper, mocks }
}

function cardTitles(wrapper: { findAll: (sel: string) => Array<{ text: () => string }> }): string[] {
  return wrapper.findAll('.plugin-title-cn').map((el) => el.text())
}

describe('PluginsSettings 搜索与筛选', () => {
  it('英文关键词搜到 GitHub 插件，中文关键词搜到安全审计', async () => {
    const { wrapper } = await mountPlugins()
    expect(wrapper.findAll('.plugin-card-item')).toHaveLength(8)

    const search = wrapper.find('input.plugins-search-input')
    await search.setValue('Github')
    expect(cardTitles(wrapper)).toEqual(['GitHub 官方插件'])

    await search.setValue('安全审计')
    expect(cardTitles(wrapper)).toEqual(['安全审计与防护'])

    await search.setValue('')
    expect(wrapper.findAll('.plugin-card-item')).toHaveLength(8)
  })

  it('状态筛选仅已启用/仅已停用数量准确', async () => {
    const { wrapper } = await mountPlugins()
    const selects = wrapper.findAll('.filter-inline-select')
    expect(selects.length).toBeGreaterThanOrEqual(2)
    const statusSelect = selects[0]

    await statusSelect.setValue('enabled')
    let titles = cardTitles(wrapper)
    expect(titles).toHaveLength(4)
    expect(wrapper.findAll('.plugin-state-capsule').every((b) => b.text().includes('已启用'))).toBe(
      true
    )

    await statusSelect.setValue('disabled')
    titles = cardTitles(wrapper)
    expect(titles).toHaveLength(4)
    expect(wrapper.findAll('.plugin-state-capsule').every((b) => b.text().includes('已停用'))).toBe(
      true
    )
  })

  it('按名称字母排序重排 DOM 列表', async () => {
    const { wrapper } = await mountPlugins()
    const defaultOrder = cardTitles(wrapper)
    const selects = wrapper.findAll('.filter-inline-select')
    await selects[1].setValue('name')

    const sorted = cardTitles(wrapper)
    const expected = [...defaultOrder].sort((a, b) => a.localeCompare(b, 'zh-CN'))
    expect(sorted).toEqual(expected)
    expect(sorted).not.toEqual(defaultOrder)
  })
})

describe('PluginsSettings 开关与技能目录', () => {
  it('点击状态胶囊切换开关并落盘 agent.plugins + feedback', async () => {
    const { wrapper, mocks } = await mountPlugins()

    const firstCapsule = wrapper.findAll('.plugin-state-capsule')[0]
    expect(firstCapsule.text()).toContain('已启用')
    await firstCapsule.trigger('click')
    await flushPromises()

    expect(mocks.settingsSet).toHaveBeenCalledWith('agent.plugins', [
      'commit-commands',
      'ralph-loop',
      'security-guidance'
    ])
    const feedbacks = wrapper.emitted('feedback') as Array<[{ ok: boolean; message: string }]>
    expect(feedbacks?.length).toBeGreaterThan(0)
    expect(feedbacks[feedbacks.length - 1][0].ok).toBe(true)
    expect(firstCapsule.text()).toContain('已停用')
  })

  it('添加外部技能目录联动 dialog.pickFolder、落盘与 countsChange', async () => {
    const { wrapper, mocks } = await mountPlugins()
    mocks.pickFolder.mockResolvedValueOnce('/tmp/skills')

    await wrapper.find('.btn-add-plugin').trigger('click')
    await flushPromises()
    await nextTick()

    expect(mocks.pickFolder).toHaveBeenCalled()
    expect(mocks.settingsSet).toHaveBeenCalledWith('agent.skillDirs', ['/tmp/skills'])
    const counts = wrapper.emitted('countsChange') as Array<[{ plugins: number; skills: number }]>
    expect(counts?.length).toBeGreaterThan(0)
    expect(counts[counts.length - 1][0]).toEqual({ plugins: 8, skills: 1 })
    expect(wrapper.text()).toContain('/tmp/skills')
  })

  it('移除外部技能目录回写空数组并更新 countsChange', async () => {
    const { wrapper, mocks } = await mountPlugins({ 'agent.skillDirs': ['/a'] })
    expect(wrapper.text()).toContain('/a')

    const removeBtn = wrapper.findAll('button').find((b) => b.text() === '移除')
    expect(removeBtn, '找不到"移除"按钮').toBeDefined()
    await removeBtn!.trigger('click')
    await flushPromises()
    await nextTick()

    expect(mocks.settingsSet).toHaveBeenCalledWith('agent.skillDirs', [])
    const counts = wrapper.emitted('countsChange') as Array<[{ plugins: number; skills: number }]>
    expect(counts[counts.length - 1][0]).toEqual({ plugins: 8, skills: 0 })
  })

  it('发现按钮 emit navigate(connectors)', async () => {
    const { wrapper } = await mountPlugins()
    const discover = wrapper.findAll('button').find((b) => b.text().includes('发现'))
    expect(discover, '找不到"发现"按钮').toBeDefined()
    await discover!.trigger('click')
    expect(wrapper.emitted('navigate')).toEqual([['connectors']])
  })
})
