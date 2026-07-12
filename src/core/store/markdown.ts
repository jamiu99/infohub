// 文章 <=> markdown（frontmatter 元数据 + 正文）。见 docs/storage.md。
// frontmatter 用 JSON 编码单值，避免引入 YAML 依赖，同时保证无歧义、可round-trip。
import type { Article } from '../../shared/contract'

const FM_DELIM = '---'

export function articleToMarkdown(a: Article): string {
  const meta: Record<string, unknown> = {
    id: a.id,
    externalId: a.externalId,
    title: a.title,
    publishedAt: a.publishedAt,
    sourceUrl: a.sourceUrl,
    source: a.source,
    ext: a.ext ?? {},
    ...(a.team ? { team: a.team } : {}),
    read: !!a.read,
    archived: !!a.archived,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt
  }
  // 只为兼容已有数据/外部注释；新采集文章不写空占位字段。
  if (a.summary !== undefined) meta.summary = a.summary
  if (a.score !== undefined) meta.score = a.score
  if (a.staleness !== undefined) meta.staleness = a.staleness
  if (a.provenance !== undefined) meta.provenance = a.provenance
  if (a.tags !== undefined) meta.tags = a.tags
  const lines = Object.entries(meta).map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
  return `${FM_DELIM}\n${lines.join('\n')}\n${FM_DELIM}\n\n${a.body ?? ''}`
}

export function parseArticleMarkdown(text: string, filePath: string): Article {
  const m = text.match(/^---\n([\s\S]*?)\n---\n?/)
  const meta: Record<string, unknown> = {}
  let body = text
  if (m) {
    body = text.slice(m[0].length).replace(/^\n+/, '')
    for (const line of m[1].split('\n')) {
      const idx = line.indexOf(':')
      if (idx === -1) continue
      const key = line.slice(0, idx).trim()
      const raw = line.slice(idx + 1).trim()
      try {
        meta[key] = JSON.parse(raw)
      } catch {
        meta[key] = raw
      }
    }
  }
  const source = (meta.source as Article['source']) ?? { id: '', type: '', name: '' }
  const sourceUrl = String(meta.sourceUrl ?? '')
  const ext = (meta.ext as Record<string, unknown>) ?? {}
  // v0.1.0 文件没有 externalId：wechat 用 sourceUrl，RSS 优先用 guid，最后退回文章 id。
  const externalId =
    String(meta.externalId ?? (source.type === 'rss' ? ext.guid : undefined) ?? sourceUrl) ||
    String(meta.id ?? '')
  return {
    id: String(meta.id ?? ''),
    externalId,
    title: String(meta.title ?? ''),
    body,
    publishedAt: Number(meta.publishedAt ?? 0),
    sourceUrl,
    source,
    summary: (meta.summary as string) ?? undefined,
    score: (meta.score as number) ?? undefined,
    staleness: (meta.staleness as Article['staleness']) ?? undefined,
    provenance: (meta.provenance as Article['provenance']) ?? undefined,
    tags: Array.isArray(meta.tags) ? (meta.tags as string[]) : undefined,
    ext,
    team: (meta.team as Article['team']) ?? undefined,
    read: !!meta.read,
    archived: !!meta.archived,
    filePath,
    createdAt: Number(meta.createdAt ?? 0),
    updatedAt: Number(meta.updatedAt ?? 0)
  }
}
