// 正文抓取：拉公众号文章页（公开，无需登录）→ 保留原始页面与 #js_content HTML → 转 markdown。
// 见 docs/wechat-content.md。HTML sidecar 用于原始排版，Markdown 仍是稳定文本接口。
import {
  parse,
  serialize,
  serializeOuter,
  type DefaultTreeAdapterTypes
} from 'parse5'
import { userFacingError } from '../../shared/errors'

type HtmlNode = DefaultTreeAdapterTypes.Node
type HtmlElement = DefaultTreeAdapterTypes.Element

export interface FetchedArticleContent {
  /** 面向文件消费者和阅读版的 Markdown。 */
  body: string
  /** 保留 #js_content 外层、内联样式和微信自定义元素的正文 HTML。 */
  contentHtml?: string
  /** 未改写的完整公开页面响应，用于溯源和重新解析。 */
  pageHtml?: string
  status: 'complete' | 'partial' | 'failed'
  parserVersion: number
  error?: { code: string; message: string }
}

export const WECHAT_CONTENT_PARSER_VERSION = 1

function isElement(node: HtmlNode): node is HtmlElement {
  return 'tagName' in node && Array.isArray(node.attrs)
}

function findElementById(node: HtmlNode, id: string): HtmlElement | null {
  if (isElement(node) && node.attrs.some((attr) => attr.name === 'id' && attr.value === id)) {
    return node
  }
  if ('childNodes' in node) {
    for (const child of node.childNodes) {
      const found = findElementById(child, id)
      if (found) return found
    }
  }
  return null
}

function getAttribute(element: HtmlElement, name: string): string {
  return element.attrs.find((attr) => attr.name === name)?.value ?? ''
}

function setAttribute(element: HtmlElement, name: string, value: string): void {
  const current = element.attrs.find((attr) => attr.name === name)
  if (current) current.value = value
  else element.attrs.push({ name, value })
}

function absoluteResourceUrl(value: string, pageUrl: string): string {
  if (!value || value.startsWith('#') || /^(?:data|blob|mailto|tel|javascript):/i.test(value)) {
    return value
  }
  try {
    return new URL(value, pageUrl).href
  } catch {
    return value
  }
}

/**
 * 微信正文主要靠 data-src 懒加载。原始 pageHtml 保持完全不变；这里只改写展示 sidecar，
 * 让离开微信运行时后图片/媒体仍能直接加载，并补全相对 URL。
 */
function prepareContentElement(element: HtmlElement, pageUrl: string): void {
  const mediaTags = new Set(['img', 'iframe', 'video', 'audio', 'source'])
  if (mediaTags.has(element.tagName)) {
    const lazySource =
      getAttribute(element, 'data-src') ||
      getAttribute(element, 'data-original') ||
      getAttribute(element, 'data-backsrc')
    const source = lazySource || getAttribute(element, 'src')
    if (source) setAttribute(element, 'src', absoluteResourceUrl(source, pageUrl))

    const lazySrcset = getAttribute(element, 'data-srcset')
    if (lazySrcset && !getAttribute(element, 'srcset')) setAttribute(element, 'srcset', lazySrcset)
  }

  for (const name of ['href', 'poster']) {
    const value = getAttribute(element, name)
    if (value) setAttribute(element, name, absoluteResourceUrl(value, pageUrl))
  }
  if (element.tagName === 'a') {
    setAttribute(element, 'target', '_blank')
    setAttribute(element, 'rel', 'noopener noreferrer')
  }

  for (const child of element.childNodes) {
    if (isElement(child)) prepareContentElement(child, pageUrl)
  }
}

function parseContentElement(html: string): HtmlElement | null {
  return findElementById(parse(html), 'js_content')
}

const CONTENT_MEDIA_TAGS = new Set([
  'img',
  'video',
  'audio',
  'iframe',
  'svg',
  'canvas',
  'mp-common-mpaudio',
  'mpvoice',
  'mpvideo',
  'qqmusic'
])

/** 空壳 #js_content 不能标记为完成，否则后续刷新不会再补抓正文。 */
function hasMeaningfulContent(node: HtmlNode): boolean {
  if (node.nodeName === '#text' && 'value' in node) {
    return node.value.replaceAll('\u00a0', ' ').trim().length > 0
  }
  if (isElement(node)) {
    if (node.tagName === 'script' || node.tagName === 'style') return false
    if (CONTENT_MEDIA_TAGS.has(node.tagName)) return true
    if (/background(?:-image)?\s*:[^;]*url\(/i.test(getAttribute(node, 'style'))) return true
  }
  return 'childNodes' in node && node.childNodes.some(hasMeaningfulContent)
}

/** 从完整 HTML 中截取正文容器 #js_content 的内部 HTML */
export function extractContentHtml(html: string): string | null {
  const content = parseContentElement(html)
  return content ? serialize(content) : null
}

/** 提取并准备可直接展示的 #js_content（包含外层节点和微信内联样式）。 */
export function extractDisplayContentHtml(html: string, pageUrl: string): string | null {
  const content = parseContentElement(html)
  if (!content) return null
  prepareContentElement(content, pageUrl)
  // 经典图文常由微信运行时脚本把正文从 hidden 切到 visible；离线 iframe 不执行脚本，
  // 因此只覆盖这两个运行时显示态，其他原始内联排版继续保留。
  const style = getAttribute(content, 'style')
  setAttribute(
    content,
    'style',
    `${style}${style.trim() && !style.trim().endsWith(';') ? ';' : ''}visibility:visible!important;opacity:1!important;`
  )
  return serializeOuter(content)
}

const decode = (s: string): string =>
  s
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))

/** 极简 HTML → markdown。覆盖 p/br/h1-6/img/a/strong/em/blockquote/li。 */
export function htmlToMarkdown(html: string): string {
  let s = html
  // 图片：必须明确优先 data-src，避免 src 是透明占位图。
  s = s.replace(/<img\b[^>]*>/gi, (tag) => {
    const read = (name: string): string =>
      tag.match(new RegExp(`\\b${name}=["']([^"']+)["']`, 'i'))?.[1] ?? ''
    const url = read('data-src') || read('data-original') || read('data-backsrc') || read('src')
    return url ? `\n![](${url})\n` : ''
  })
  // 链接
  s = s.replace(/<a[^>]*?href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href, txt) => `[${strip(txt)}](${href})`)
  // 标题
  s = s.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_m, lv, txt) => `\n${'#'.repeat(Number(lv))} ${strip(txt)}\n`)
  // 加粗/强调
  s = s.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, txt) => `**${strip(txt)}**`)
  s = s.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, (_m, _t, txt) => `*${strip(txt)}*`)
  // 引用
  s = s.replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_m, txt) => `\n> ${strip(txt)}\n`)
  // 列表项
  s = s.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_m, txt) => `\n- ${strip(txt)}`)
  // 段落/换行 → 换行
  s = s.replace(/<\/(p|div|section|br)[^>]*>/gi, '\n')
  s = s.replace(/<br\s*\/?>/gi, '\n')
  // 去掉剩余标签
  s = s.replace(/<[^>]+>/g, '')
  s = decode(s)
  // 压缩多余空行/空格
  s = s
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  return s
}

/** 去掉一段 HTML 里的标签，取纯文本（用于链接/标题内文） */
function strip(html: string): string {
  return decode(html.replace(/<[^>]+>/g, '')).trim()
}

/** 抓取完整公开页面、正文 HTML 和 Markdown。失败返回结构化状态，不阻塞元数据入库。 */
export async function fetchArticleContent(
  url: string,
  fetchImpl: typeof fetch = fetch
): Promise<FetchedArticleContent> {
  try {
    const res = await fetchImpl(url, {
      headers: {
        'user-agent':
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/137.0.0.0 Safari/537.36'
      },
      signal: AbortSignal.timeout(15_000)
    })
    if (!res.ok) {
      return {
        body: '',
        status: 'failed',
        parserVersion: WECHAT_CONTENT_PARSER_VERSION,
        error: { code: 'http_error', message: `公众号原文请求失败（HTTP ${res.status ?? '未知'}）` }
      }
    }
    const html = await res.text()
    const contentElement = parseContentElement(html)
    if (!contentElement) {
      return {
        body: '',
        pageHtml: html,
        status: 'failed',
        parserVersion: WECHAT_CONTENT_PARSER_VERSION,
        error: { code: 'content_missing', message: '页面中没有找到公众号正文 #js_content' }
      }
    }
    if (!hasMeaningfulContent(contentElement)) {
      return {
        body: '',
        pageHtml: html,
        status: 'failed',
        parserVersion: WECHAT_CONTENT_PARSER_VERSION,
        error: { code: 'content_empty', message: '公众号正文容器为空，稍后刷新时会重试' }
      }
    }
    const contentHtml = extractDisplayContentHtml(html, res.url || url)!
    const md = htmlToMarkdown(contentHtml)
    return {
      body: md,
      contentHtml,
      pageHtml: html,
      status: 'complete',
      parserVersion: WECHAT_CONTENT_PARSER_VERSION
    }
  } catch (error) {
    return {
      body: '',
      status: 'failed',
      parserVersion: WECHAT_CONTENT_PARSER_VERSION,
      error: {
        code: 'fetch_failed',
        message: userFacingError(error, '公众号正文抓取失败')
      }
    }
  }
}
