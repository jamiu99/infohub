// 轻量 markdown → HTML，仅覆盖 infohub 正文需要的格式。
// 外部内容采用三层防护：原始 HTML 转义、http(s) URL 白名单、DOMPurify allowlist。
import DOMPurify from 'dompurify'
import { normalizeHttpUrl } from '../../shared/url'

const ALLOWED_TAGS = [
  'p',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'strong',
  'em',
  'a',
  'img',
  'blockquote',
  'ul',
  'li'
]
const ALLOWED_ATTR = ['href', 'src', 'alt', 'target', 'rel', 'loading', 'decoding']

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

/** 文章链接/图片只允许绝对 http(s)，拒绝 javascript:/data:/file: 等 scheme。 */
export function safeExternalUrl(value: string): string | null {
  return normalizeHttpUrl(value)
}

function inline(source: string): string {
  // 用私有区字符暂存我们生成的安全标签，避免后续文本转义破坏它们。
  const fragments: string[] = []
  const stash = (html: string): string => {
    const index = fragments.push(html) - 1
    return `\uE000${index}\uE001`
  }

  let text = source.replace(/[\uE000\uE001]/g, '')
  text = text.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, (_match, alt: string, rawUrl: string) => {
    const url = safeExternalUrl(rawUrl)
    if (!url) return alt
    return stash(
      `<img src="${escapeHtml(url)}" alt="${escapeHtml(alt)}" loading="lazy" decoding="async">`
    )
  })
  text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, label: string, rawUrl: string) => {
    const url = safeExternalUrl(rawUrl)
    if (!url) return label
    return stash(
      `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(label)}</a>`
    )
  })

  let html = escapeHtml(text)
  html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  html = html.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>')
  return html.replace(/\uE000(\d+)\uE001/g, (_match, index: string) => fragments[Number(index)] ?? '')
}

function sanitize(html: string): string {
  // node:test 没有 DOM；纯 renderer 已完成转义和 URL 白名单，浏览器运行时再叠加 DOMPurify。
  if (typeof window === 'undefined') return html
  return String(
    DOMPurify.sanitize(html, {
      ALLOWED_TAGS,
      ALLOWED_ATTR,
      ALLOW_ARIA_ATTR: false,
      ALLOW_DATA_ATTR: false,
      ALLOW_UNKNOWN_PROTOCOLS: false,
      ALLOWED_URI_REGEXP: /^https?:\/\//i
    })
  )
}

export function renderMarkdown(md: string): string {
  const lines = md.split('\n')
  const out: string[] = []
  let inList = false
  const closeList = (): void => {
    if (inList) {
      out.push('</ul>')
      inList = false
    }
  }
  for (const raw of lines) {
    const line = raw.trimEnd()
    if (!line.trim()) {
      closeList()
      continue
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/)
    if (h) {
      closeList()
      const level = h[1].length
      out.push(`<h${level}>${inline(h[2])}</h${level}>`)
      continue
    }
    if (/^>\s?/.test(line)) {
      closeList()
      out.push(`<blockquote>${inline(line.replace(/^>\s?/, ''))}</blockquote>`)
      continue
    }
    if (/^[-*]\s+/.test(line)) {
      if (!inList) {
        out.push('<ul>')
        inList = true
      }
      out.push(`<li>${inline(line.replace(/^[-*]\s+/, ''))}</li>`)
      continue
    }
    closeList()
    out.push(`<p>${inline(line)}</p>`)
  }
  closeList()
  return sanitize(out.join('\n'))
}
