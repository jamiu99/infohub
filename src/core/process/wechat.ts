// 处理层：wechat RawItem → 统一 Article。见 docs/process.md、docs/contract.md。
// 确定性归一化：字段映射 + UTC 时间；正文由采集管线后续补全。
import type { RawItem, Article, Source } from '../../shared/contract'
import { createHash } from 'node:crypto'
import { registerNormalizer } from './normalize'

/** 由 sourceId + externalId 派生稳定全局 id */
function makeArticleId(source: Source, item: RawItem): string {
  const raw = item.raw
  const aid = String(raw.aid ?? '').trim()
  const appmsgid = String(raw.appmsgid ?? raw.mid ?? '').trim()
  const itemidx = String(raw.itemidx ?? raw.idx ?? '1').trim() || '1'
  const fallback = createHash('sha256').update(item.externalId).digest('hex').slice(0, 24)
  const messageKey = aid || (appmsgid ? `${appmsgid}_${itemidx}` : fallback)
  return `wechat-${(source.config as { fakeid?: string }).fakeid ?? source.id}-${messageKey}`.replace(
    /[^\w-]/g,
    ''
  )
}

export function normalizeWechat(item: RawItem, source: Source): Article {
  const raw = item.raw
  const now = Date.now()
  const createTime = Number(raw.create_time ?? 0)
  return {
    id: makeArticleId(source, item),
    externalId: item.externalId,
    title: String(raw.title ?? '(无标题)'),
    body: '', // 正文待后续阶段抓 link 页面填充
    publishedAt: createTime ? createTime * 1000 : now, // 微信是秒 → UTC ms
    sourceUrl: String(raw.link ?? ''),
    source: { id: source.id, type: 'wechat', name: source.name },
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

registerNormalizer('wechat', normalizeWechat)
