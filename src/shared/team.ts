import type { Article, Source } from './contract'

export const DEFAULT_TEAM_SERVER_URL = 'https://home.agent-wiki.cn:18038'

export function normalizeRssFeedUrl(value: unknown): string | null {
  if (typeof value !== 'string') return null
  try {
    const url = new URL(value)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    url.hash = ''
    url.searchParams.sort()
    return url.href
  } catch {
    return null
  }
}

function shortHash(value: string): string {
  let result = 0
  for (let index = 0; index < value.length; index++) {
    result = (result * 31 + value.charCodeAt(index)) | 0
  }
  return (result >>> 0).toString(36)
}

/** 新增 RSS 与团队 pull 共用同一 canonical ID，避免先同步后订阅时生成两份文章。 */
export function rssSourceId(feedUrl: string): string {
  return `rss-${shortHash(normalizeRssFeedUrl(feedUrl) ?? feedUrl)}`
}

function isSensitiveRssQueryKey(key: string): boolean {
  const compact = key.toLowerCase().replaceAll(/[-_]/g, '')
  return (
    compact === 'auth' ||
    compact === 'sig' ||
    compact === 'key' ||
    compact.includes('token') ||
    compact.includes('secret') ||
    compact.includes('password') ||
    compact.includes('passwd') ||
    compact.includes('credential') ||
    compact.includes('authorization') ||
    compact.includes('apikey') ||
    compact.includes('accesskey') ||
    compact.includes('signature')
  )
}

/** 私有 RSS 凭据不能借 Source 配置绕过同步 allowlist。 */
export function shareableRssFeedUrl(value: unknown): string | null {
  const normalized = normalizeRssFeedUrl(value)
  if (!normalized) return null
  const url = new URL(normalized)
  if (url.username || url.password) return null
  for (const key of url.searchParams.keys()) {
    if (isSensitiveRssQueryKey(key)) return null
  }
  return url.href
}

export interface TeamDevice {
  id: string
  memberName: string
  deviceName: string
}

export interface TeamJoinInput {
  serverUrl: string
  teamToken: string
  memberName: string
  deviceName: string
}

export interface TeamJoinResponse {
  instanceId: string
  teamName: string
  device: TeamDevice
  deviceToken: string
}

export interface TeamServerStatusResponse {
  instanceId: string
  teamName: string
  device: TeamDevice
}

export type TeamConnectionState = 'disabled' | 'not_joined' | 'ready' | 'syncing' | 'error'

export interface TeamStatus {
  state: TeamConnectionState
  enabled: boolean
  serverUrl: string
  instanceId?: string
  teamName?: string
  device?: TeamDevice
  lastSyncAt?: number
  pendingUploads: number
  quarantinedUploads: number
  error?: string
}

/** 写入文章文件的同步来源信息；文件仍是真相源，SQLite 可据此重建“我的”筛选。 */
export interface TeamArticleOrigin {
  remoteId?: string
  contributedByMe: boolean
  contributors?: TeamContributor[]
  /** 服务端返回的公开信源配置（wechat fakeid / rss feedUrl），用于文件侧重建。 */
  sourceConfig?: Record<string, unknown>
  /** 已取消对应本地 Source；团队副本保留，但 pull 不得恢复为“我的”。 */
  detachedFromLocalSource?: boolean
}

export interface TeamContributor {
  deviceId: string
  memberName: string
  deviceName: string
  collectedAt: number
}

export interface TeamSourcePayload {
  type: string
  name: string
  config: Record<string, unknown>
}

export interface TeamArticlePayload {
  externalId: string
  title: string
  body: string
  publishedAt: number
  sourceUrl: string
  ext?: Record<string, unknown>
  createdAt?: number
  updatedAt?: number
}

export interface TeamArticleUpload {
  eventId: string
  collectedAt: number
  source: TeamSourcePayload
  article: TeamArticlePayload
}

export interface TeamPushResponse {
  accepted: number
  cursor: number
}

export interface TeamArticleRecord {
  remoteId: string
  source: TeamSourcePayload & { id: string }
  article: Required<Pick<TeamArticlePayload, 'externalId' | 'title' | 'body' | 'publishedAt' | 'sourceUrl'>> &
    Pick<TeamArticlePayload, 'ext' | 'createdAt' | 'updatedAt'>
  contributors: TeamContributor[]
}

export interface TeamArticleChange {
  seq: number
  type: 'article.upsert'
  article: TeamArticleRecord
}

export interface TeamPullResponse {
  cursor: number
  hasMore: boolean
  changes: TeamArticleChange[]
}

export interface TeamDeviceCredentials extends TeamServerStatusResponse {
  serverUrl: string
  deviceToken: string
}

/** 公开同步契约只挑选明确字段；cookie/token/fingerprint/partition/raw 没有序列化入口。 */
export function toTeamSourcePayload(source: Source): TeamSourcePayload {
  const config: Record<string, unknown> = {}
  if (source.type === 'wechat' && typeof source.config.fakeid === 'string') {
    config.fakeid = source.config.fakeid
  } else if (source.type === 'rss') {
    const feedUrl = shareableRssFeedUrl(source.config.feedUrl)
    if (feedUrl) config.feedUrl = feedUrl
  }
  return { type: source.type, name: source.name, config }
}

const ARTICLE_EXT_KEYS: Record<string, ReadonlySet<string>> = {
  wechat: new Set(['fakeid', 'author_name', 'cover', 'digest', 'appmsgid', 'itemidx']),
  rss: new Set(['guid', 'summary'])
}

function safeExt(sourceType: string, ext: Record<string, unknown>): Record<string, unknown> {
  const keys = ARTICLE_EXT_KEYS[sourceType] ?? new Set<string>()
  const result: Record<string, unknown> = {}
  for (const key of keys) {
    const value = ext[key]
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'number' ||
      typeof value === 'boolean'
    ) {
      result[key] = value
    } else if (Array.isArray(value) && value.every((v) => typeof v === 'string')) {
      result[key] = value
    }
  }
  return result
}

export function toTeamArticlePayload(article: Article): TeamArticlePayload {
  return {
    externalId: article.externalId,
    title: article.title,
    body: article.body,
    publishedAt: article.publishedAt,
    sourceUrl: article.sourceUrl,
    ext: safeExt(article.source.type, article.ext ?? {}),
    createdAt: article.createdAt,
    updatedAt: article.updatedAt
  }
}

export function validateTeamServerUrl(value: unknown): string {
  if (typeof value !== 'string') throw new Error('团队服务器地址必须是 HTTPS URL')
  let url: URL
  try {
    url = new URL(value.trim())
  } catch {
    throw new Error('团队服务器地址格式无效')
  }
  if (url.protocol !== 'https:') throw new Error('团队服务器只允许使用 HTTPS')
  if (url.username || url.password || url.search || url.hash) {
    throw new Error('团队服务器地址不能包含账号、查询参数或片段')
  }
  return url.toString().replace(/\/$/, '')
}
