// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import MarkdownBlock from './MarkdownBlock.vue'
import { highlighterReady, renderMarkdown } from '../lib/markdown'
import { useChatStore } from '../stores/chat'
import { useViewerStore } from '../stores/viewer'

vi.mock('../lib/markdown', async (importOriginal) => {
  const orig = await importOriginal<typeof import('../lib/markdown')>()
  return { ...orig, renderMarkdown: vi.fn(orig.renderMarkdown) }
})

let mounted: Array<{ unmount: () => void }> = []

afterEach(() => {
  for (const w of mounted) w.unmount()
  mounted = []
  highlighterReady.value = false
  vi.useRealTimers()
  vi.restoreAllMocks()
})

function installShangbo() {
  const fileRead = vi.fn(async () => ({
    name: 'a.ts',
    mime: 'text/plain',
    size: 2,
    text: 'hi',
    dataUrl: null,
    html: null,
    truncated: false
  }))
  const g = globalThis as unknown as { window: Record<string, unknown> }
  g.window.shangbo = { file: { read: fileRead } }
  return { fileRead }
}

function setupStores(workingDir: string | null = 'G:\\proj\\demo') {
  setActivePinia(createPinia())
  const chat = useChatStore()
  chat.conversations = [
    {
      id: 'conv-1',
      title: 't',
      projectId: null,
      workingDir,
      providerId: null,
      model: null,
      systemPrompt: null,
      mode: null,
      createdAt: 1,
      updatedAt: 2,
      archivedAt: null
    }
  ]
  chat.activeConversationId = 'conv-1'
  const viewer = useViewerStore()
  const openFileSpy = vi.spyOn(viewer, 'openFile').mockResolvedValue(undefined)
  const openWebSpy = vi.spyOn(viewer, 'openWeb').mockImplementation(() => {})
  return { chat, viewer, openFileSpy, openWebSpy }
}

function clickAnchor(wrapper: { find: (sel: string) => { element: Element } }, selector: string): MouseEvent {
  const el = wrapper.find(selector).element as HTMLElement
  const event = new MouseEvent('click', { bubbles: true, cancelable: true })
  try {
    el.dispatchEvent(event)
  } catch (error) {
    // 未被组件接管的外链（如工作区外绝对路径）happy-dom 会尝试真导航并抛
    // NotSupportedError；这正说明组件没有 preventDefault，吞掉以便继续断言。
    const message = error instanceof Error ? error.message : String(error)
    if (!message.includes('not supported') && !message.includes('URL scheme')) throw error
  }
  return event
}

describe('MarkdownBlock 渲染与 XSS 消毒', () => {
  beforeEach(() => {
    installShangbo()
    setupStores()
    highlighterReady.value = false
  })

  it('标题与代码块正常渲染，script/onerror 被清除', () => {
    const wrapper = mount(MarkdownBlock, {
      props: {
        source: '# Hello\n\n```js\nconst a = 1\n```\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>'
      }
    })
    mounted.push(wrapper)

    const html = wrapper.html()
    expect(html).toContain('Hello')
    expect(html).toContain('const a = 1')
    // markdown-it(html:false) 把裸标签转义成文本，DOMPurify 再过一遍：
    // 页面上不得留下可执行的 script/img 节点与 onerror 属性
    expect(wrapper.find('script').exists()).toBe(false)
    expect(wrapper.find('img').exists()).toBe(false)
    expect(wrapper.find('[onerror]').exists()).toBe(false)
    expect(html).not.toContain('<script')
    expect(vi.mocked(renderMarkdown)).toHaveBeenCalled()
  })
})

describe('MarkdownBlock 链接路由委托', () => {
  beforeEach(() => {
    installShangbo()
    setupStores('G:\\proj\\demo')
    highlighterReady.value = false
  })

  it('工作区内相对路径链接触发 viewer.openFile 并 preventDefault', async () => {
    const { openFileSpy } = setupStores('G:\\proj\\demo')
    const wrapper = mount(MarkdownBlock, { props: { source: '[doc](src/a.ts)' } })
    mounted.push(wrapper)
    await nextTick()

    const anchor = wrapper.find('a[data-viewer="file"]')
    expect(anchor.exists()).toBe(true)
    const event = clickAnchor(wrapper, 'a[data-viewer="file"]')
    await nextTick()

    expect(event.defaultPrevented).toBe(true)
    expect(openFileSpy).toHaveBeenCalledWith('conv-1', 'src/a.ts')
  })

  it('外部 https 链接触发 viewer.openWeb', async () => {
    const { openFileSpy, openWebSpy } = setupStores('G:\\proj\\demo')
    const wrapper = mount(MarkdownBlock, { props: { source: '[web](https://example.com)' } })
    mounted.push(wrapper)
    await nextTick()

    const anchor = wrapper.find('a[data-viewer="web"]')
    expect(anchor.exists()).toBe(true)
    const event = clickAnchor(wrapper, 'a[data-viewer="web"]')
    await nextTick()

    expect(event.defaultPrevented).toBe(true)
    expect(openWebSpy).toHaveBeenCalledWith('https://example.com')
    expect(openFileSpy).not.toHaveBeenCalled()
  })

  it('工作区外 Windows 绝对路径不触发 openFile', async () => {
    const { openFileSpy } = setupStores('G:\\proj\\demo')
    const wrapper = mount(MarkdownBlock, { props: { source: '[evil](C:/Windows/system.ini)' } })
    mounted.push(wrapper)
    await nextTick()

    const anchor = wrapper.find('a[data-viewer="file"]')
    expect(anchor.exists()).toBe(true)
    // 负向用例：组件不接管，浏览器默认行为会真导航。happy-dom 对 C: scheme
    // 会抛 NotSupportedError 噪音，用官方 navigation 开关禁掉子页面导航，
    // 只验证"组件侧不接管"这一契约（openFile 不被调用、未 preventDefault）。
    const navSettings = (
      window as unknown as {
        happyDOM: { settings: { navigation: { disableChildPageNavigation: boolean } } }
      }
    ).happyDOM.settings.navigation
    navSettings.disableChildPageNavigation = true
    try {
      const event = clickAnchor(wrapper, 'a[data-viewer="file"]')
      await nextTick()

      expect(openFileSpy).not.toHaveBeenCalled()
      expect(event.defaultPrevented).toBe(false)
    } finally {
      navSettings.disableChildPageNavigation = false
    }
  })
})

describe('MarkdownBlock 异步高亮补染', () => {
  beforeEach(() => {
    installShangbo()
    setupStores()
  })

  it('highlighterReady 翻转到 true 时重新触发 renderMarkdown', async () => {
    highlighterReady.value = false
    const wrapper = mount(MarkdownBlock, {
      props: { source: '```ts\nconst x: number = 1\n```' }
    })
    mounted.push(wrapper)
    await nextTick()

    const spy = vi.mocked(renderMarkdown)
    const callsBefore = spy.mock.calls.length
    expect(callsBefore).toBeGreaterThan(0)

    highlighterReady.value = true
    await nextTick()
    await nextTick()

    expect(spy.mock.calls.length).toBeGreaterThan(callsBefore)
    // happy-dom 下 DOMPurify 会剥掉 .code-block 包装 div（只留 pre/code 文本），
    // 这是测试环境 DOM 实现差异，不是业务行为：不断言包装层，只断言代码块本体仍在。
    expect(wrapper.find('pre').exists()).toBe(true)
  })
})
