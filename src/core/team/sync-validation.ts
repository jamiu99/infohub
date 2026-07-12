import type { TeamArticleUpload } from '../../shared/team'
import { shareableRssFeedUrl } from '../../shared/team'

export const TEAM_MAX_ARTICLE_BODY_BYTES = 2 * 1024 * 1024
const TEAM_MAX_EXT_BYTES = 128 * 1024

const FORBIDDEN_KEYS = [
  'cookie',
  'fingerprint',
  'partition',
  'session',
  'password',
  'credential',
  'authorization'
]

function exactKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  const keys = new Set(allowed)
  return Object.keys(value).every((key) => keys.has(key))
}

function safeTimestamp(value: unknown): boolean {
  return Number.isSafeInteger(value) && Number(value) >= 0
}

function safeString(value: unknown, max: number, allowEmpty = false): boolean {
  return (
    typeof value === 'string' &&
    value.trim().length <= max &&
    (allowEmpty || value.trim().length > 0)
  )
}

function safeJson(value: unknown, depth = 0): boolean {
  if (depth > 12) return false
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (Array.isArray(value)) {
    return value.length <= 1000 && value.every((item) => safeJson(item, depth + 1))
  }
  if (!value || typeof value !== 'object') return false
  return Object.entries(value).every(([key, child]) => {
    const compact = key.toLowerCase().replaceAll(/[-_]/g, '')
    if (
      compact.endsWith('token') ||
      FORBIDDEN_KEYS.some((forbidden) => compact.includes(forbidden))
    ) {
      return false
    }
    return safeJson(child, depth + 1)
  })
}

/** 与服务端 v1 allowlist 对齐；返回原因表示该事件必须本地隔离，不能反复堵住队列。 */
export function teamUploadValidationError(value: unknown): string | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return '事件不是对象'
  const item = value as Record<string, unknown>
  if (!exactKeys(item, ['eventId', 'collectedAt', 'source', 'article'])) return '事件包含未知字段'
  if (
    !safeString(item.eventId, 200) ||
    !/^[A-Za-z0-9._:-]+$/.test(String(item.eventId))
  ) {
    return 'eventId 格式无效'
  }
  if (!safeTimestamp(item.collectedAt)) return 'collectedAt 不是有效时间戳'

  if (!item.source || typeof item.source !== 'object' || Array.isArray(item.source)) {
    return 'Source 不是对象'
  }
  const source = item.source as Record<string, unknown>
  if (!exactKeys(source, ['type', 'name', 'config'])) return 'Source 包含未知字段'
  if (!safeString(source.name, 200)) return 'Source 名称无效'
  if (!source.config || typeof source.config !== 'object' || Array.isArray(source.config)) {
    return 'Source 配置无效'
  }
  const config = source.config as Record<string, unknown>
  if (source.type === 'wechat') {
    if (!exactKeys(config, ['fakeid']) || !safeString(config.fakeid, 512)) {
      return '微信公众号 Source 缺少有效 fakeid'
    }
  } else if (source.type === 'rss') {
    if (
      !exactKeys(config, ['feedUrl']) ||
      !safeString(config.feedUrl, 4096) ||
      !shareableRssFeedUrl(config.feedUrl)
    ) {
      return 'RSS Source URL 无效或可能包含私有凭据'
    }
  } else {
    return '团队同步目前只支持微信公众号和 RSS'
  }

  if (!item.article || typeof item.article !== 'object' || Array.isArray(item.article)) {
    return 'Article 不是对象'
  }
  const article = item.article as Record<string, unknown>
  if (
    !exactKeys(article, [
      'externalId',
      'title',
      'body',
      'publishedAt',
      'sourceUrl',
      'ext',
      'createdAt',
      'updatedAt'
    ])
  ) {
    return 'Article 包含未知字段'
  }
  if (!safeString(article.externalId, 4096)) return 'Article externalId 无效'
  if (!safeString(article.title, 500, true)) return 'Article 标题过长'
  if (typeof article.body !== 'string') return 'Article 正文不是字符串'
  if (Buffer.byteLength(article.body, 'utf8') > TEAM_MAX_ARTICLE_BODY_BYTES) {
    return 'Article 正文超过 2 MiB'
  }
  if (!safeTimestamp(article.publishedAt)) return 'Article publishedAt 无效'
  if (!safeString(article.sourceUrl, 4096, true)) return 'Article sourceUrl 过长'
  if (article.createdAt !== undefined && !safeTimestamp(article.createdAt)) {
    return 'Article createdAt 无效'
  }
  if (article.updatedAt !== undefined && !safeTimestamp(article.updatedAt)) {
    return 'Article updatedAt 无效'
  }
  const ext = article.ext ?? {}
  if (!ext || typeof ext !== 'object' || Array.isArray(ext) || !safeJson(ext)) {
    return 'Article ext 包含不安全字段'
  }
  if (Buffer.byteLength(JSON.stringify(ext), 'utf8') > TEAM_MAX_EXT_BYTES) {
    return 'Article ext 超过 128 KiB'
  }
  return null
}

export function isValidTeamArticleUpload(value: unknown): value is TeamArticleUpload {
  return teamUploadValidationError(value) === null
}
