import type { Article, Source } from '../../shared/contract'
import { createHash } from 'node:crypto'
import { normalizeRssFeedUrl, rssSourceId, type TeamArticleRecord } from '../../shared/team'
import type { Store } from '../store'

export function localSourceId(record: TeamArticleRecord, localSources: Source[] = []): string {
  if (record.source.type === 'wechat' && typeof record.source.config.fakeid === 'string') {
    const existing = localSources.find(
      (source) => source.type === 'wechat' && source.config.fakeid === record.source.config.fakeid
    )
    if (existing) return existing.id
    return `wx-${record.source.config.fakeid}`
  }
  if (record.source.type === 'rss' && typeof record.source.config.feedUrl === 'string') {
    const canonical = normalizeRssFeedUrl(record.source.config.feedUrl)
    const existing = localSources.find(
      (source) =>
        source.type === 'rss' && normalizeRssFeedUrl(source.config.feedUrl) === canonical
    )
    if (existing) return existing.id
    return rssSourceId(record.source.config.feedUrl)
  }
  return `team-${record.source.id}`
}

/** 合并 pull 文章：保留本地阅读/归档状态，也绝不把既有本机贡献降级为团队-only。 */
export function applyRemoteArticle(
  store: Store,
  record: TeamArticleRecord,
  contributedByCurrentDevice: boolean,
  localSources: Source[] = []
): Article {
  const sourceId = localSourceId(record, localSources)
  const existing = store.findArticleByExternalId(sourceId, record.article.externalId)
  const source: Article['source'] = {
    id: sourceId,
    type: record.source.type,
    name: record.source.name
  }
  const now = Date.now()
  const detached = existing?.team?.detachedFromLocalSource === true
  const contributedByMe = detached
    ? false
    : existing
      ? existing.team?.contributedByMe !== false || contributedByCurrentDevice
      : contributedByCurrentDevice
  const remoteUpdatedAt = record.article.updatedAt ?? now
  const keepLocalBody = existing && existing.team?.contributedByMe !== false
  const body = !existing
    ? record.article.body
    : keepLocalBody
      ? existing.body || record.article.body
      : remoteUpdatedAt >= existing.updatedAt
        ? record.article.body || existing.body
        : existing.body || record.article.body
  const incoming: Article = {
    id: existing?.id ?? `team-${createHash('sha256').update(record.remoteId).digest('hex')}`,
    externalId: record.article.externalId,
    title: record.article.title,
    body,
    publishedAt: record.article.publishedAt,
    sourceUrl: record.article.sourceUrl,
    source,
    ext: record.article.ext ?? {},
    team: {
      remoteId: record.remoteId,
      contributedByMe,
      contributors: record.contributors,
      sourceConfig: record.source.config,
      ...(detached ? { detachedFromLocalSource: true } : {})
    },
    read: existing?.read ?? false,
    archived: existing?.archived ?? false,
    filePath: existing?.filePath,
    createdAt: existing?.createdAt ?? record.article.createdAt ?? now,
    updatedAt: Math.max(existing?.updatedAt ?? 0, remoteUpdatedAt)
  }
  // 这些字段属于本地/外部注释，不在团队传输 DTO 中；合并时原样保留。
  if (existing?.summary !== undefined) incoming.summary = existing.summary
  if (existing?.score !== undefined) incoming.score = existing.score
  if (existing?.staleness !== undefined) incoming.staleness = existing.staleness
  if (existing?.provenance !== undefined) incoming.provenance = existing.provenance
  if (existing?.tags !== undefined) incoming.tags = existing.tags
  return store.saveArticle(incoming)
}
