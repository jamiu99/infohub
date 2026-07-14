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

export const WECHAT_CONTENT_PARSER_VERSION = 2

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

interface SourceRange {
  start: number
  /** 结束位置不包含在范围内。 */
  end: number
}

interface WechatPicture {
  url: string
  width?: number
  height?: number
}

interface WechatPicturePage {
  detected: boolean
  pictures: WechatPicture[]
  captionSource: string
}

function skipWhitespaceAndComments(source: string, from: number, limit = source.length): number {
  let cursor = from
  while (cursor < limit) {
    if (/\s/.test(source[cursor])) {
      cursor++
      continue
    }
    if (source.startsWith('//', cursor)) {
      const newline = source.indexOf('\n', cursor + 2)
      return newline === -1 || newline >= limit
        ? limit
        : skipWhitespaceAndComments(source, newline + 1, limit)
    }
    if (source.startsWith('/*', cursor)) {
      const close = source.indexOf('*/', cursor + 2)
      if (close === -1 || close + 2 > limit) return limit
      cursor = close + 2
      continue
    }
    break
  }
  return cursor
}

/**
 * 跳过 JavaScript 字符串。模板字符串在这里也只被当成不可解释的整体；我们不会执行
 * `${...}`，目标字段的静态值解析也明确不接受反引号。
 */
function skipJavascriptString(source: string, from: number, limit: number): number {
  const quote = source[from]
  let cursor = from + 1
  while (cursor < limit) {
    if (source[cursor] === '\\') {
      cursor += 2
      continue
    }
    if (source[cursor] === quote) return cursor + 1
    cursor++
  }
  return limit
}

/** 找到 `{...}` / `[...]` 的闭合位置；只做词法扫描，绝不求值页面脚本。 */
function findBalancedEnd(
  source: string,
  from: number,
  open: '{' | '[',
  close: '}' | ']',
  limit = source.length
): number | null {
  if (source[from] !== open) return null
  let depth = 1
  let cursor = from + 1
  while (cursor < limit) {
    const char = source[cursor]
    if (char === "'" || char === '"' || char === '`') {
      cursor = skipJavascriptString(source, cursor, limit)
      continue
    }
    if (source.startsWith('//', cursor)) {
      const newline = source.indexOf('\n', cursor + 2)
      cursor = newline === -1 ? limit : newline + 1
      continue
    }
    if (source.startsWith('/*', cursor)) {
      const commentEnd = source.indexOf('*/', cursor + 2)
      if (commentEnd === -1) return null
      cursor = commentEnd + 2
      continue
    }
    if (char === open) depth++
    else if (char === close && --depth === 0) return cursor + 1
    cursor++
  }
  return null
}

/** 定位 `window.xxx = {...}` 一类复合字面量赋值，跳过读取和比较表达式。 */
function findAssignedComposite(
  source: string,
  marker: string,
  open: '{' | '[',
  close: '}' | ']'
): SourceRange | null {
  let searchFrom = 0
  while (searchFrom < source.length) {
    const markerAt = source.indexOf(marker, searchFrom)
    if (markerAt === -1) return null
    let cursor = skipWhitespaceAndComments(source, markerAt + marker.length)
    if (source[cursor] !== '=') {
      searchFrom = markerAt + marker.length
      continue
    }
    cursor = skipWhitespaceAndComments(source, cursor + 1)
    // `===`、`=>` 或任意可执行表达式都不会被当成静态复合值。
    if (source[cursor] !== open) {
      searchFrom = markerAt + marker.length
      continue
    }
    const end = findBalancedEnd(source, cursor, open, close)
    if (end !== null) return { start: cursor, end }
    return null
  }
  return null
}

/** 找到当前顶层字段/数组项的逗号；嵌套表达式只跳过，不解释。 */
function findTopLevelComma(source: string, from: number, limit: number): number {
  let braces = 0
  let brackets = 0
  let parentheses = 0
  let cursor = from
  while (cursor < limit) {
    const char = source[cursor]
    if (char === "'" || char === '"' || char === '`') {
      cursor = skipJavascriptString(source, cursor, limit)
      continue
    }
    if (source.startsWith('//', cursor)) {
      const newline = source.indexOf('\n', cursor + 2)
      cursor = newline === -1 ? limit : newline + 1
      continue
    }
    if (source.startsWith('/*', cursor)) {
      const commentEnd = source.indexOf('*/', cursor + 2)
      if (commentEnd === -1) return limit
      cursor = commentEnd + 2
      continue
    }
    if (char === '{') braces++
    else if (char === '}') braces = Math.max(0, braces - 1)
    else if (char === '[') brackets++
    else if (char === ']') brackets = Math.max(0, brackets - 1)
    else if (char === '(') parentheses++
    else if (char === ')') parentheses = Math.max(0, parentheses - 1)
    else if (char === ',' && braces === 0 && brackets === 0 && parentheses === 0) return cursor
    cursor++
  }
  return limit
}

function findTopLevelColon(source: string, from: number, limit: number): number | null {
  let braces = 0
  let brackets = 0
  let parentheses = 0
  let cursor = from
  while (cursor < limit) {
    const char = source[cursor]
    if (char === "'" || char === '"' || char === '`') {
      cursor = skipJavascriptString(source, cursor, limit)
      continue
    }
    if (source.startsWith('//', cursor)) {
      const newline = source.indexOf('\n', cursor + 2)
      cursor = newline === -1 ? limit : newline + 1
      continue
    }
    if (source.startsWith('/*', cursor)) {
      const commentEnd = source.indexOf('*/', cursor + 2)
      if (commentEnd === -1) return null
      cursor = commentEnd + 2
      continue
    }
    if (char === '{') braces++
    else if (char === '}') braces = Math.max(0, braces - 1)
    else if (char === '[') brackets++
    else if (char === ']') brackets = Math.max(0, brackets - 1)
    else if (char === '(') parentheses++
    else if (char === ')') parentheses = Math.max(0, parentheses - 1)
    else if (char === ':' && braces === 0 && brackets === 0 && parentheses === 0) return cursor
    cursor++
  }
  return null
}

/** 读取对象的直接属性；不会递归命中 watermark/share_cover 中同名字段。 */
function findDirectPropertyValue(objectSource: string, property: string): string | null {
  if (!objectSource.startsWith('{') || !objectSource.endsWith('}')) return null
  const limit = objectSource.length - 1
  let cursor = 1
  while (cursor < limit) {
    cursor = skipWhitespaceAndComments(objectSource, cursor, limit)
    if (objectSource[cursor] === ',') {
      cursor++
      continue
    }
    if (cursor >= limit) break
    const fieldEnd = findTopLevelComma(objectSource, cursor, limit)
    const colon = findTopLevelColon(objectSource, cursor, fieldEnd)
    if (colon !== null) {
      const key = objectSource.slice(cursor, colon).trim()
      if (key === property || key === `'${property}'` || key === `"${property}"`) {
        return objectSource.slice(colon + 1, fieldEnd).trim()
      }
    }
    cursor = fieldEnd + 1
  }
  return null
}

interface ParsedJavascriptString {
  value: string
  end: number
}

/** 只接受普通单/双引号字面量，并解码微信页面常见的 \xNN / \uNNNN。 */
function parseJavascriptStringLiteral(source: string, from = 0): ParsedJavascriptString | null {
  const quote = source[from]
  if (quote !== "'" && quote !== '"') return null
  let value = ''
  let cursor = from + 1
  while (cursor < source.length) {
    const char = source[cursor]
    if (char === quote) return { value, end: cursor + 1 }
    if (char !== '\\') {
      value += char
      cursor++
      continue
    }
    cursor++
    if (cursor >= source.length) return null
    const escaped = source[cursor]
    const simple: Record<string, string> = {
      n: '\n',
      r: '\r',
      t: '\t',
      b: '\b',
      f: '\f',
      v: '\v',
      '0': '\0'
    }
    if (escaped in simple) {
      value += simple[escaped]
      cursor++
      continue
    }
    if (escaped === '\n') {
      cursor++
      continue
    }
    if (escaped === '\r') {
      cursor += source[cursor + 1] === '\n' ? 2 : 1
      continue
    }
    if (escaped === 'x') {
      const hex = source.slice(cursor + 1, cursor + 3)
      if (!/^[0-9a-f]{2}$/i.test(hex)) return null
      value += String.fromCharCode(Number.parseInt(hex, 16))
      cursor += 3
      continue
    }
    if (escaped === 'u') {
      if (source[cursor + 1] === '{') {
        const close = source.indexOf('}', cursor + 2)
        if (close === -1) return null
        const hex = source.slice(cursor + 2, close)
        if (!/^[0-9a-f]{1,6}$/i.test(hex)) return null
        const point = Number.parseInt(hex, 16)
        if (point > 0x10ffff) return null
        value += String.fromCodePoint(point)
        cursor = close + 1
        continue
      }
      const hex = source.slice(cursor + 1, cursor + 5)
      if (!/^[0-9a-f]{4}$/i.test(hex)) return null
      value += String.fromCharCode(Number.parseInt(hex, 16))
      cursor += 5
      continue
    }
    // JavaScript 对未知单字符转义的结果就是该字符；这里仍只处理字面量，不执行表达式。
    value += escaped
    cursor++
  }
  return null
}

/** 字段值必须完整地是一个字符串字面量；拼接、函数调用和模板字符串一律拒绝。 */
function parseStaticString(source: string): string | null {
  const trimmed = source.trim()
  const parsed = parseJavascriptStringLiteral(trimmed)
  if (!parsed || trimmed.slice(parsed.end).trim()) return null
  return parsed.value
}

/** 接受 `1188`、`'1188'` 和微信模板常见的 `'1188' * 1`，拒绝其他表达式。 */
function parseStaticPositiveNumber(source: string | null): number | undefined {
  if (!source) return undefined
  const trimmed = source.trim()
  const literal = parseJavascriptStringLiteral(trimmed)
  let raw: string
  let suffix: string
  if (literal) {
    raw = literal.value
    suffix = trimmed.slice(literal.end).trim()
  } else {
    const match = trimmed.match(/^([+]?(?:\d+(?:\.\d+)?|\.\d+))(.*)$/s)
    if (!match) return undefined
    raw = match[1]
    suffix = match[2].trim()
  }
  if (suffix && !/^\*\s*1$/.test(suffix)) return undefined
  if (!/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(raw)) return undefined
  const value = Number(raw)
  return Number.isFinite(value) && value > 0 && value <= 100_000 ? value : undefined
}

function splitArrayItems(arraySource: string): string[] {
  if (!arraySource.startsWith('[') || !arraySource.endsWith(']')) return []
  const out: string[] = []
  const limit = arraySource.length - 1
  let cursor = 1
  while (cursor < limit) {
    cursor = skipWhitespaceAndComments(arraySource, cursor, limit)
    if (arraySource[cursor] === ',') {
      cursor++
      continue
    }
    if (cursor >= limit) break
    const itemEnd = findTopLevelComma(arraySource, cursor, limit)
    const item = arraySource.slice(cursor, itemEnd).trim()
    if (item) out.push(item)
    cursor = itemEnd + 1
  }
  return out
}

function normalizePictureUrl(value: string, pageUrl: string): string | null {
  try {
    const parsed = new URL(value.replace(/&amp;/g, '&'), pageUrl)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null
  } catch {
    return null
  }
}

function parsePictureArray(arraySource: string, pageUrl: string): WechatPicture[] {
  const pictures: WechatPicture[] = []
  for (const item of splitArrayItems(arraySource)) {
    if (!item.startsWith('{')) continue
    const objectEnd = findBalancedEnd(item, 0, '{', '}')
    if (objectEnd === null || item.slice(objectEnd).trim()) continue
    const urlLiteral = findDirectPropertyValue(item, 'cdn_url')
    const url = urlLiteral && parseStaticString(urlLiteral)
    const normalized = url && normalizePictureUrl(url, pageUrl)
    if (!normalized) continue
    pictures.push({
      url: normalized,
      width: parseStaticPositiveNumber(findDirectPropertyValue(item, 'width')),
      height: parseStaticPositiveNumber(findDirectPropertyValue(item, 'height'))
    })
    // 微信前端本身只展示前 20 张；也避免异常页面制造超大派生文件。
    if (pictures.length >= 20) break
  }
  return pictures
}

function extractWechatPicturePage(html: string, pageUrl: string): WechatPicturePage {
  const cgiRange = findAssignedComposite(html, 'window.cgiDataNew', '{', '}')
  let captionSource = ''
  let pictures: WechatPicture[] = []
  let detected = false

  if (cgiRange) {
    const objectSource = html.slice(cgiRange.start, cgiRange.end)
    const pictureList = findDirectPropertyValue(objectSource, 'picture_page_info_list')
    if (pictureList !== null) {
      detected = true
      const trimmed = pictureList.trim()
      if (trimmed.startsWith('[')) {
        const end = findBalancedEnd(trimmed, 0, '[', ']')
        if (end !== null && !trimmed.slice(end).trim()) {
          pictures = parsePictureArray(trimmed, pageUrl)
        }
      }
    }
    captionSource =
      parseStaticString(findDirectPropertyValue(objectSource, 'content_noencode') ?? '') ??
      parseStaticString(findDirectPropertyValue(objectSource, 'desc') ?? '') ??
      ''
  }

  // 一些图片消息只在后续脚本暴露 window.picture_page_info_list；同样只读静态数组。
  if (pictures.length === 0) {
    const legacyRange = findAssignedComposite(html, 'window.picture_page_info_list', '[', ']')
    if (legacyRange) {
      detected = true
      pictures = parsePictureArray(html.slice(legacyRange.start, legacyRange.end), pageUrl)
    }
  }

  return { detected, pictures, captionSource }
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

function picturePageContentHtml(data: WechatPicturePage): string {
  const figures = data.pictures
    .map((picture, index) => {
      const dimensions = `${picture.width ? ` width="${picture.width}"` : ''}${
        picture.height ? ` height="${picture.height}"` : ''
      }`
      return `<figure style="margin:0 auto 18px"><img src="${escapeHtml(picture.url)}"${dimensions} alt="图片 ${
        index + 1
      }" loading="lazy" style="display:block;max-width:100%;height:auto;margin:0 auto"></figure>`
    })
    .join('')
  const plainCaption = data.captionSource
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(?:p|div|section|li)>/gi, '\n')
  const caption = strip(plainCaption)
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  const captionHtml = caption
    ? `<div class="infohub-wechat-picture-caption" style="white-space:pre-wrap;line-height:1.75">${escapeHtml(
        caption
      )}</div>`
    : ''
  return `<div id="js_content" data-infohub-wechat-variant="picture" style="visibility:visible!important;opacity:1!important">${figures}${captionHtml}</div>`
}

function picturePageMarkdown(data: WechatPicturePage): string {
  const images = data.pictures.map((picture) => `![](${picture.url})`).join('\n\n')
  const caption = data.captionSource ? htmlToMarkdown(data.captionSource) : ''
  return [images, caption].filter(Boolean).join('\n\n')
}

/**
 * 纯解析入口：输入一次未改写的公众号页面，输出可重建的 Markdown/HTML 投影。
 * 经典 #js_content 优先；没有经典正文时再识别 item_show_type=8 的图片消息数据。
 */
export function parseWechatArticleContent(html: string, pageUrl: string): FetchedArticleContent {
  const contentElement = parseContentElement(html)
  if (contentElement && hasMeaningfulContent(contentElement)) {
    const contentHtml = extractDisplayContentHtml(html, pageUrl)!
    return {
      body: htmlToMarkdown(contentHtml),
      contentHtml,
      pageHtml: html,
      status: 'complete',
      parserVersion: WECHAT_CONTENT_PARSER_VERSION
    }
  }

  const picturePage = extractWechatPicturePage(html, pageUrl)
  if (picturePage.pictures.length > 0) {
    return {
      body: picturePageMarkdown(picturePage),
      contentHtml: picturePageContentHtml(picturePage),
      pageHtml: html,
      status: 'complete',
      parserVersion: WECHAT_CONTENT_PARSER_VERSION
    }
  }
  if (picturePage.detected) {
    return {
      body: '',
      pageHtml: html,
      status: 'failed',
      parserVersion: WECHAT_CONTENT_PARSER_VERSION,
      error: {
        code: 'picture_content_invalid',
        message: '检测到公众号图片消息，但没有找到可安全读取的正文图片'
      }
    }
  }
  if (contentElement) {
    return {
      body: '',
      pageHtml: html,
      status: 'failed',
      parserVersion: WECHAT_CONTENT_PARSER_VERSION,
      error: { code: 'content_empty', message: '公众号正文容器为空，稍后刷新时会重试' }
    }
  }
  return {
    body: '',
    pageHtml: html,
    status: 'failed',
    parserVersion: WECHAT_CONTENT_PARSER_VERSION,
    error: { code: 'content_missing', message: '页面中没有找到公众号正文 #js_content' }
  }
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
    // 只要服务端返回了页面就先保留原始响应；HTTP 错误页、验证页同样是诊断快照。
    const html = await res.text()
    if (!res.ok) {
      return {
        body: '',
        pageHtml: html,
        status: 'failed',
        parserVersion: WECHAT_CONTENT_PARSER_VERSION,
        error: { code: 'http_error', message: `公众号原文请求失败（HTTP ${res.status ?? '未知'}）` }
      }
    }
    return parseWechatArticleContent(html, res.url || url)
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
