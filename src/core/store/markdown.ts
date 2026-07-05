// 文章 <=> markdown（frontmatter 元数据 + 正文）。见 docs/storage.md。
// frontmatter 用 JSON 编码单值，避免引入 YAML 依赖，同时保证无歧义、可round-trip。
import type { Article } from '../../shared/contract'

const FM_DELIM = '---'

export function articleToMarkdown(a: Article): string {
  const meta: Record<string, unknown> = {
    id: a.id,
    title: a.title,
    publishedAt: a.publishedAt,
    sourceUrl: a.sourceUrl,
    source: a.source,
    summary: a.summary ?? null,
    score: a.score ?? null,
    staleness: a.staleness ?? null,
    provenance: a.provenance ?? null,
    tags: a.tags ?? [],
    ext: a.ext ?? {},
    read: !!a.read,
    archived: !!a.archived,
    createdAt: a.createdAt,
    updatedAt: a.updatedAt
  }
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
  return {
    id: String(meta.id ?? ''),
    title: String(meta.title ?? ''),
    body,
    publishedAt: Number(meta.publishedAt ?? 0),
    sourceUrl: String(meta.sourceUrl ?? ''),
    source,
    summary: (meta.summary as string) ?? undefined,
    score: (meta.score as number) ?? undefined,
    staleness: (meta.staleness as Article['staleness']) ?? undefined,
    provenance: (meta.provenance as Article['provenance']) ?? undefined,
    tags: (meta.tags as string[]) ?? [],
    ext: (meta.ext as Record<string, unknown>) ?? {},
    read: !!meta.read,
    archived: !!meta.archived,
    filePath,
    createdAt: Number(meta.createdAt ?? 0),
    updatedAt: Number(meta.updatedAt ?? 0)
  }
}
