// RSS/Atom 解析（无三方依赖，正则解析常见结构）。公开抓取，无需鉴权/限流。
import type { RawItem } from '../../shared/contract'

export interface RssEntry {
  title: string
  link: string
  guid: string
  published?: number // UTC ms
  summary?: string
  content?: string // 正文（若 feed 提供）
}

export interface RssFeed {
  title: string
  entries: RssEntry[]
}

function decode(s: string): string {
  return s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
    .trim()
}

function tag(block: string, name: string): string | undefined {
  // 支持带命名空间/属性的标签，取第一个匹配
  const m = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'))
  return m ? decode(m[1]) : undefined
}

/** atom link 可能是 <link href="..."/> 形式 */
function atomLink(block: string): string | undefined {
  const m = block.match(/<link[^>]*href=["']([^"']+)["'][^>]*\/?>/i)
  return m ? m[1] : undefined
}

function toMs(s?: string): number | undefined {
  if (!s) return undefined
  const t = Date.parse(s)
  return Number.isNaN(t) ? undefined : t
}

export function parseFeed(xml: string): RssFeed {
  const feedTitle = tag(xml, 'title') ?? 'RSS'
  const entries: RssEntry[] = []

  // RSS: <item>...</item>；Atom: <entry>...</entry>
  const blocks = [
    ...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi),
    ...xml.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi)
  ]
  for (const b of blocks) {
    const block = b[1]
    const link = tag(block, 'link') || atomLink(block) || ''
    const guid = tag(block, 'guid') || tag(block, 'id') || link
    const published = toMs(tag(block, 'pubDate') || tag(block, 'published') || tag(block, 'updated'))
    const content =
      tag(block, 'content:encoded') || tag(block, 'content') || undefined
    entries.push({
      title: tag(block, 'title') ?? '(无标题)',
      link,
      guid,
      published,
      summary: tag(block, 'description') || tag(block, 'summary'),
      content
    })
  }
  return { title: feedTitle, entries }
}

/** 拉取并解析一个 feed */
export async function fetchFeed(feedUrl: string, fetchImpl: typeof fetch = fetch): Promise<RssFeed | null> {
  try {
    const res = await fetchImpl(feedUrl, {
      headers: { 'user-agent': 'infohub/0.1 (+rss)', accept: 'application/rss+xml, application/xml, text/xml, */*' }
    })
    if (!res.ok) return null
    return parseFeed(await res.text())
  } catch {
    return null
  }
}

export function entryToRawItem(sourceId: string, entry: RssEntry): RawItem {
  return {
    sourceId,
    sourceType: 'rss',
    fetchedAt: Date.now(),
    externalId: entry.guid || entry.link,
    raw: { ...entry }
  }
}
