import DOMPurify from 'dompurify'
import MarkdownIt from 'markdown-it'
import { ref } from 'vue'
import { createHighlighterCore, type HighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import type { BundledLanguage } from 'shiki'
// 按需语言包：只打 25 种常用语言，不再整包引入全量 ~300 语言。
// 经由 shiki/dist 内显式子路径引用（vue-tsc 无法解析 shiki/langs/* 通配导出，
// 但可解析 ./dist/* 精确映射；运行时走同一份 exports，无行为差异）。
import typescript from 'shiki/dist/langs/typescript.mjs'
import javascript from 'shiki/dist/langs/javascript.mjs'
import tsx from 'shiki/dist/langs/tsx.mjs'
import jsx from 'shiki/dist/langs/jsx.mjs'
import vue from 'shiki/dist/langs/vue.mjs'
import html from 'shiki/dist/langs/html.mjs'
import css from 'shiki/dist/langs/css.mjs'
import json from 'shiki/dist/langs/json.mjs'
import python from 'shiki/dist/langs/python.mjs'
import bash from 'shiki/dist/langs/bash.mjs'
import shellscript from 'shiki/dist/langs/shellscript.mjs'
import sql from 'shiki/dist/langs/sql.mjs'
import markdown from 'shiki/dist/langs/markdown.mjs'
import yaml from 'shiki/dist/langs/yaml.mjs'
import toml from 'shiki/dist/langs/toml.mjs'
import ini from 'shiki/dist/langs/ini.mjs'
import rust from 'shiki/dist/langs/rust.mjs'
import go from 'shiki/dist/langs/go.mjs'
import java from 'shiki/dist/langs/java.mjs'
import c from 'shiki/dist/langs/c.mjs'
import cpp from 'shiki/dist/langs/cpp.mjs'
import diff from 'shiki/dist/langs/diff.mjs'
import xml from 'shiki/dist/langs/xml.mjs'
import powershell from 'shiki/dist/langs/powershell.mjs'
import dockerfile from 'shiki/dist/langs/dockerfile.mjs'
import githubLight from 'shiki/dist/themes/github-light.mjs'
import githubDark from 'shiki/dist/themes/github-dark.mjs'

/**
 * Markdown → 安全 HTML。
 *
 * 两个关键取舍：
 *  1. 模型输出一律视为不可信内容，render 之后必须过 DOMPurify —— 提示注入可以
 *     诱导模型吐出 <script> 或 <img onerror>，直接 v-html 等于把本机交给它。
 *  2. 流式过程中关闭 Shiki 高亮：每来一个增量就重新高亮整段代码代价太高，
 *     等消息落地后再整体高亮一次。
 *
 * 瘦身说明：走 shiki/core + JavaScript 正则引擎（免 oniguruma WASM ~466KB），
 * 只注册 25 种常用语言 + 2 套主题。构建产物见 out/renderer/assets 对比。
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

/** 各语言垫片默认导出为 LanguageRegistration[]，归一化后传给 core。 */
const SHIKI_LANG_MODULES: unknown[] = [
  typescript,
  javascript,
  tsx,
  jsx,
  vue,
  html,
  css,
  json,
  python,
  bash,
  shellscript,
  sql,
  markdown,
  yaml,
  toml,
  ini,
  rust,
  go,
  java,
  c,
  cpp,
  diff,
  xml,
  powershell,
  dockerfile
]

let highlighterPromise: Promise<HighlighterCore | null> | null = null
let highlightEnabled = true

/**
 * fence 回调同步读取的实例。必须声明在 preloadHighlighter() 之前、
 * 并在内部先于 highlighterReady 翻转前赋值：若靠外层 `.then` 赋值，
 * 该微任务排在 `highlighterReady = true` 触发的 watch 重渲染之后，
 * 首轮补高亮会命中 null 而回退成纯文本（时序隐患）。
 */
let resolvedHighlighter: HighlighterCore | null = null

/** 响应式高亮就绪态：MarkdownBlock / FileViewer 监听它，异步初始化完成后触发已渲染代码块重高亮。 */
export const highlighterReady = ref(false)

/** 提前加载高亮器；失败不影响主流程，只是代码块不高亮。 */
export function preloadHighlighter(): Promise<HighlighterCore | null> {
  if (!highlighterPromise) {
    highlighterPromise = (async () => {
      try {
        const highlighter = await createHighlighterCore({
          themes: [githubLight, githubDark],
          langs: SHIKI_LANG_MODULES.flatMap((mod) => (Array.isArray(mod) ? mod : [mod])) as never[],
          engine: createJavaScriptRegexEngine()
        })
        resolvedHighlighter = highlighter
        highlighterReady.value = true
        return highlighter
      } catch (error) {
        console.error('[markdown] Shiki 初始化失败，代码块将不高亮', error)
        return null
      }
    })()
  }
  return highlighterPromise
}

void preloadHighlighter()

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
 * 把点击到的 href 换算成工程内相对路径：
 * - Windows 绝对路径（G:\proj\src\a.ts）必须落在 workingDir 之内才换算，
 *   越界或未绑定目录直接返回 null（禁止旧版硬截取盘符的错误换算）；
 * - 裸相对路径（src/a.ts）原样返回，由主进程 resolveViewerPath 再做边界校验。
 */
export function resolveViewerRelPath(
  href: string,
  workingDir: string | null | undefined
): string | null {
  let decoded = href
  try {
    decoded = decodeURIComponent(href)
  } catch {
    // 非法转义序列（如裸 %）时用原文，不抛错
  }
  const normalized = decoded.replace(/\\/g, '/')
  const isWinAbs = /^[A-Za-z]:\//.test(normalized)
  if (isWinAbs) {
    if (!workingDir) return null
    const root = workingDir.replace(/\\/g, '/').replace(/\/+$/, '')
    const lowerHref = normalized.toLowerCase()
    const lowerRoot = root.toLowerCase()
    if (lowerHref !== lowerRoot && !lowerHref.startsWith(lowerRoot + '/')) return null
    const rel = normalized.slice(root.length).replace(/^\/+/, '')
    return rel || null
  }
  // POSIX 绝对路径（/src/a.ts）视为工程根相对路径；裸相对路径直接返回。
  const rel = normalized.replace(/^\.\//, '').replace(/^\/+/, '')
  return rel || null
}

/**
 * Markdown 内容区统一点击委托：
 * - data-viewer=web：进右侧 iframe；
 * - data-viewer=file：按当前会话 workingDir 换算相对路径后进右侧；
 * 返回 true 表示已接管（调用方应 preventDefault）。
 */
export function handleViewerLinkClick(
  event: MouseEvent,
  open: { openWeb(url: string): void; openFile(conversationId: string, relPath: string): Promise<void> },
  conversationId: string | null,
  workingDir?: string | null
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
    const rel = resolveViewerRelPath(href, workingDir ?? null)
    if (rel) {
      void open.openFile(conversationId, rel)
      return true
    }
  }
  return false
}
