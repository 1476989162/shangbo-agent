import DOMPurify from 'dompurify'
import MarkdownIt from 'markdown-it'
import type { BundledLanguage, Highlighter } from 'shiki'

/**
 * Markdown → 安全 HTML。
 *
 * 两个关键取舍：
 *  1. 模型输出一律视为不可信内容，render 之后必须过 DOMPurify —— 提示注入可以
 *     诱导模型吐出 <script> 或 <img onerror>，直接 v-html 等于把本机交给它。
 *  2. 流式过程中关闭 Shiki 高亮：每来一个增量就重新高亮整段代码代价太高，
 *     等消息落地后再整体高亮一次。
 */

const LANGS: BundledLanguage[] = [
  'typescript',
  'javascript',
  'tsx',
  'jsx',
  'vue',
  'html',
  'css',
  'json',
  'python',
  'bash',
  'shellscript',
  'sql',
  'markdown',
  'yaml',
  'toml',
  'ini',
  'rust',
  'go',
  'java',
  'c',
  'cpp',
  'diff',
  'xml',
  'powershell',
  'dockerfile'
]

let highlighterPromise: Promise<Highlighter | null> | null = null
let highlightEnabled = true

/** 提前加载高亮器；失败不影响主流程，只是代码块不高亮。 */
export function preloadHighlighter(): Promise<Highlighter | null> {
  if (!highlighterPromise) {
    highlighterPromise = import('shiki')
      .then((shiki) =>
        shiki.createHighlighter({
          themes: ['github-light', 'github-dark'],
          langs: LANGS
        })
      )
      .catch((error) => {
        console.error('[markdown] Shiki 初始化失败，代码块将不高亮', error)
        return null
      })
  }
  return highlighterPromise
}

let resolvedHighlighter: Highlighter | null = null
void preloadHighlighter().then((instance) => {
  resolvedHighlighter = instance
})

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}

function currentTheme(): 'github-light' | 'github-dark' {
  return highlightTheme === 'dark' ? 'github-dark' : 'github-light'
}

let highlightTheme: 'light' | 'dark' = 'light'

const md = new MarkdownIt({
  html: false,
  linkify: true,
  breaks: true
})

md.renderer.rules.fence = (tokens, index) => {
  const token = tokens[index]
  const requested = token.info.trim().split(/\s+/)[0]?.toLowerCase() ?? ''
  const lang = requested || 'text'
  const code = token.content

  const canHighlight =
    highlightEnabled &&
    resolvedHighlighter !== null &&
    (LANGS as string[]).includes(requested)

  if (canHighlight && resolvedHighlighter) {
    try {
      const html = resolvedHighlighter.codeToHtml(code, {
        lang: requested as BundledLanguage,
        theme: currentTheme()
      })
      return `<div class="code-block" data-lang="${escapeHtml(lang)}">${html}</div>`
    } catch {
      // 落到下面的纯文本分支
    }
  }

  return `<div class="code-block" data-lang="${escapeHtml(lang)}"><pre><code>${escapeHtml(code)}</code></pre></div>`
}

const renderToken = md.renderer.rules.link_open
md.renderer.rules.link_open = (tokens, index, options, env, self) => {
  tokens[index].attrSet('target', '_blank')
  tokens[index].attrSet('rel', 'noopener noreferrer')
  // 右侧查看器：http(s) 与工程内文件链接加标记，前端点击委托统一进右侧。
  const rawHref = tokens[index].attrGet('href') ?? ''
  const href = typeof rawHref === 'string' ? rawHref : String(rawHref)
  if (/^https?:\/\//i.test(href)) {
    tokens[index].attrSet('data-viewer', 'web')
  } else if (/^[A-Za-z]:[\\/]/.test(href) || href.startsWith('/') || /^[^\s]+\.[A-Za-z0-9]{1,5}$/.test(href)) {
    tokens[index].attrSet('data-viewer', 'file')
  }
  return renderToken
    ? renderToken(tokens, index, options, env, self)
    : self.renderToken(tokens, index, options)
}

export function renderMarkdown(
  source: string,
  options: { highlight: boolean; dark: boolean }
): string {
  highlightEnabled = options.highlight
  highlightTheme = options.dark ? 'dark' : 'light'
  const html = md.render(source)
  return DOMPurify.sanitize(html, {
    ADD_ATTR: ['target', 'data-lang', 'data-viewer']
  })
}

/**
 * Markdown 内容区统一点击委托：
 * - data-viewer=web：进右侧 iframe；
 * - data-viewer=file：按工程内相对路径进右侧；
 * 返回 true 表示已接管（调用方应 preventDefault）。
 */
export function handleViewerLinkClick(
  event: MouseEvent,
  open: { openWeb(url: string): void; openFile(conversationId: string, relPath: string): Promise<void> },
  conversationId: string | null
): boolean {
  const target = (event.target as HTMLElement | null)?.closest?.('a[data-viewer]')
  if (!target) return false
  const anchor = target as HTMLAnchorElement
  const kind = anchor.getAttribute('data-viewer')
  const href = anchor.getAttribute('href') ?? ''
  if (!href) return false
  if (kind === 'web' && /^https?:\/\//i.test(href)) {
    open.openWeb(href)
    return true
  }
  if (kind === 'file' && conversationId) {
    const rel = href.replace(/^[A-Za-z]:[\\/]/, '').replace(/^\/+/, '')
    if (rel) {
      void open.openFile(conversationId, decodeURIComponent(rel))
      return true
    }
  }
  return false
}