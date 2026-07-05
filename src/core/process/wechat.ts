// 处理层：wechat RawItem → 统一 Article。见 docs/process.md、docs/contract.md。
// 阶段 1 归一化（必做）：字段映射 + 时间 UTC。正文抓取/AI 增强为后续阶段。
import type { RawItem, Article, Source } from '../../shared/contract'

/** 由 sourceId + externalId 派生稳定全局 id */
function makeArticleId(source: Source, raw: Record<string, unknown>): string {
  const aid = String(raw.aid ?? raw.appmsgid ?? '')
  return `wechat-${(source.config as { fakeid?: string }).fakeid ?? source.id}-${aid}`.replace(
    /[^\w-]/g,
    ''
  )
}

export function normalizeWechat(item: RawItem, source: Source): Article {
  const raw = item.raw
  const now = Date.now()
  const createTime = Number(raw.create_time ?? 0)
  return {
    id: makeArticleId(source, raw),
    title: String(raw.title ?? '(无标题)'),
    body: '', // 正文待后续阶段抓 link 页面填充
    publishedAt: createTime ? createTime * 1000 : now, // 微信是秒 → UTC ms
    sourceUrl: String(raw.link ?? ''),
    source: { id: source.id, type: 'wechat', name: source.name },
    tags: [],
    ext: {
      fakeid: (source.config as { fakeid?: string }).fakeid,
      author_name: raw.author_name,
      cover: raw.cover,
      digest: raw.digest,
      appmsgid: raw.appmsgid,
      itemidx: raw.itemidx
    },
    read: false,
    archived: false,
    createdAt: now,
    updatedAt: now
  }
}
