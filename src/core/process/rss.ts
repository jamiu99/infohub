// 处理层：rss RawItem → 统一 Article。见 docs/process.md、docs/contract.md。
import type { RawItem, Article, Source } from '../../shared/contract'
import { registerNormalizer } from './normalize'
import { htmlToMarkdown } from './content'

function makeArticleId(source: Source, guid: string): string {
  // guid 可能是 URL 或任意串，hash 成稳定短 id
  let h = 0
  for (let i = 0; i < guid.length; i++) h = (h * 31 + guid.charCodeAt(i)) | 0
  return `rss-${source.id}-${(h >>> 0).toString(36)}`
}

export function normalizeRss(item: RawItem, source: Source): Article {
  const raw = item.raw as {
    title?: string
    link?: string
    guid?: string
    published?: number
    summary?: string
    content?: string
  }
  const now = Date.now()
  // 正文：优先 content（全文），退回 summary；都是 HTML → 转 markdown
  const html = raw.content || raw.summary || ''
  const body = html ? htmlToMarkdown(html) : ''
  return {
    id: makeArticleId(source, raw.guid || raw.link || String(now)),
    title: raw.title ?? '(无标题)',
    body,
    publishedAt: raw.published ?? now,
    sourceUrl: raw.link ?? '',
    source: { id: source.id, type: 'rss', name: source.name },
    tags: [],
    ext: { guid: raw.guid, summary: raw.summary },
    read: false,
    archived: false,
    createdAt: now,
    updatedAt: now
  }
}

registerNormalizer('rss', normalizeRss)
