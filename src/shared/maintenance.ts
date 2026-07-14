/** 历史正文维护：只重建 infohub 的派生产物，不修改任何原始快照。 */
export type ArticleMaintenanceMode = 'offline' | 'network'

export type ArticleMaintenanceScope = 'article' | 'source' | 'all'

export interface ArticleMaintenanceRequest {
  mode: ArticleMaintenanceMode
  scope: ArticleMaintenanceScope
  articleId?: string
  sourceId?: string
}

export type ArticleMaintenanceItemStatus =
  | 'updated'
  | 'unchanged'
  | 'failed'
  | 'skipped'

export interface ArticleMaintenanceItemResult {
  articleId: string
  title: string
  status: ArticleMaintenanceItemStatus
  message?: string
}

export interface ArticleMaintenanceResult {
  mode: ArticleMaintenanceMode
  scope: ArticleMaintenanceScope
  total: number
  updated: number
  unchanged: number
  failed: number
  skipped: number
  items: ArticleMaintenanceItemResult[]
}

export function validateArticleMaintenanceRequest(value: unknown): ArticleMaintenanceRequest {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('重新处理参数无效')
  }
  const input = value as Record<string, unknown>
  if (input.mode !== 'offline' && input.mode !== 'network') {
    throw new Error('重新处理模式必须是离线解析或联网抓取')
  }
  if (input.scope !== 'article' && input.scope !== 'source' && input.scope !== 'all') {
    throw new Error('重新处理范围无效')
  }
  const articleId = typeof input.articleId === 'string' ? input.articleId.trim() : ''
  const sourceId = typeof input.sourceId === 'string' ? input.sourceId.trim() : ''
  if (input.scope === 'article' && !articleId) throw new Error('重新处理单篇文章时缺少文章 ID')
  if (input.scope === 'source' && !sourceId) throw new Error('重新处理信源时缺少信源 ID')
  return {
    mode: input.mode,
    scope: input.scope,
    ...(articleId ? { articleId } : {}),
    ...(sourceId ? { sourceId } : {})
  }
}
