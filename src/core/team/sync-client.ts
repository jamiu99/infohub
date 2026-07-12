import { createHash } from 'node:crypto'
import type { Article, Source } from '../../shared/contract'
import {
  toTeamArticlePayload,
  toTeamSourcePayload,
  validateTeamServerUrl,
  type TeamArticleRecord,
  type TeamArticleUpload,
  type TeamDeviceCredentials,
  type TeamJoinInput,
  type TeamJoinResponse,
  type TeamPullResponse,
  type TeamPushResponse,
  type TeamServerStatusResponse,
  type TeamStatus
} from '../../shared/team'
import type { Paths } from '../paths'
import { TeamSyncStorage } from './sync-storage'
import { teamUploadValidationError } from './sync-validation'

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export interface TeamSyncClientOptions {
  paths: Paths
  serverUrl: string
  enabled: boolean
  credentials?: TeamDeviceCredentials | null
  fetchImpl?: FetchLike
  now?: () => number
  onCredentials: (credentials: TeamDeviceCredentials | null) => void
  onRemoteArticle: (record: TeamArticleRecord, contributedByMe: boolean) => void
  onRemoteArticlesChanged?: () => void
  onStatus?: (status: TeamStatus) => void
}

const SYNC_INTERVAL_MS = 5 * 60 * 1000

class TeamHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

export class TeamSyncClient {
  private storage: TeamSyncStorage
  private fetchImpl: FetchLike
  private now: () => number
  private serverUrl: string
  private enabled: boolean
  private credentials: TeamDeviceCredentials | null
  private lastSyncAt?: number
  private lastError?: string
  private syncing: Promise<TeamStatus> | null = null
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private options: TeamSyncClientOptions) {
    this.storage = new TeamSyncStorage(options.paths)
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? Date.now
    this.serverUrl = validateTeamServerUrl(options.serverUrl)
    this.enabled = options.enabled
    this.credentials = options.credentials ?? null
  }

  configure(input: { serverUrl: string; enabled: boolean }): void {
    this.serverUrl = validateTeamServerUrl(input.serverUrl)
    this.enabled = input.enabled
    this.emit()
  }

  status(): TeamStatus {
    const credentialMatches = this.credentials?.serverUrl === this.serverUrl
    let state: TeamStatus['state'] = 'not_joined'
    if (!this.enabled) state = 'disabled'
    else if (this.syncing) state = 'syncing'
    else if (this.lastError) state = 'error'
    else if (this.credentials && credentialMatches) state = 'ready'
    return {
      state,
      enabled: this.enabled,
      serverUrl: this.serverUrl,
      instanceId: credentialMatches ? this.credentials?.instanceId : undefined,
      teamName: credentialMatches ? this.credentials?.teamName : undefined,
      device: credentialMatches ? this.credentials?.device : undefined,
      lastSyncAt: this.lastSyncAt,
      pendingUploads: this.storage.pendingCount(),
      quarantinedUploads: this.storage.quarantineCount(),
      error: this.lastError
    }
  }

  async join(input: TeamJoinInput): Promise<TeamStatus> {
    const serverUrl = validateTeamServerUrl(input.serverUrl)
    const memberName = input.memberName.trim()
    const deviceName = input.deviceName.trim()
    if (!input.teamToken.trim() || !memberName || !deviceName) {
      throw new Error('团队 token、成员名和设备名不能为空')
    }
    const response = await this.requestJson<TeamJoinResponse>(
      serverUrl,
      '/api/v1/join',
      { method: 'POST', body: JSON.stringify({ teamToken: input.teamToken, memberName, deviceName }) },
      null
    )
    if (!response.deviceToken || !response.instanceId || !response.device?.id) {
      throw new Error('团队服务器返回了无效的设备凭据')
    }
    const credentials: TeamDeviceCredentials = {
      serverUrl,
      instanceId: response.instanceId,
      teamName: response.teamName,
      device: response.device,
      deviceToken: response.deviceToken
    }
    if (this.credentials?.instanceId !== credentials.instanceId || this.credentials.serverUrl !== serverUrl) {
      this.storage.reset()
    }
    this.options.onCredentials(credentials)
    this.credentials = credentials
    this.serverUrl = serverUrl
    this.enabled = true
    this.lastError = undefined
    this.emit()
    return this.status()
  }

  leave(): TeamStatus {
    this.options.onCredentials(null)
    this.credentials = null
    this.enabled = false
    this.lastError = undefined
    this.lastSyncAt = undefined
    this.storage.reset()
    this.emit()
    return this.status()
  }

  /** 本地文章落盘后仅写可靠队列，不进行网络请求，因此采集链不会被网络阻塞。 */
  enqueue(source: Source, article: Article, emitStatus = true): boolean {
    if (!this.enabled || !this.credentials || this.credentials.serverUrl !== this.serverUrl) return false
    const sourcePayload = toTeamSourcePayload(source)
    const articlePayload = toTeamArticlePayload(article)
    const eventId = createHash('sha256')
      .update(JSON.stringify({
        version: 1,
        instanceId: this.credentials.instanceId,
        deviceId: this.credentials.device.id,
        source: sourcePayload,
        article: articlePayload
      }))
      .digest('hex')
    const item = {
      eventId,
      collectedAt: this.now(),
      source: sourcePayload,
      article: articlePayload
    }
    if (this.storage.isQuarantined(eventId)) return false
    const invalid = teamUploadValidationError(item)
    if (invalid) {
      this.storage.quarantine(item, invalid)
      console.warn(`团队同步事件已隔离 (${article.id}): ${invalid}`)
      if (emitStatus) this.emit()
      return false
    }
    const queued = this.storage.enqueue(item)
    if (queued && emitStatus) this.emit()
    return queued
  }

  seedExisting(sources: Source[], articles: Article[]): number {
    const sourceById = new Map(sources.map((source) => [source.id, source]))
    let seeded = 0
    for (const article of articles) {
      const source = sourceById.get(article.source.id)
      if (!source || article.team?.contributedByMe === false) continue
      try {
        if (this.enqueue(source, article, false)) seeded++
      } catch (error) {
        // 单篇队列文件异常不应影响本地数据，也不应阻止其余历史文章继续排队。
        console.error(`历史文章加入团队队列失败 (${article.id}):`, error)
      }
    }
    if (seeded > 0) this.emit()
    return seeded
  }

  syncNow(): Promise<TeamStatus> {
    if (this.syncing) return this.syncing
    if (!this.enabled || !this.credentials || this.credentials.serverUrl !== this.serverUrl) {
      return Promise.resolve(this.status())
    }
    const run = this.performSync().then(() => {
      this.syncing = null
      this.emit()
      return this.status()
    })
    this.syncing = run
    this.emit()
    return run
  }

  start(intervalMs = SYNC_INTERVAL_MS): void {
    if (this.timer) return
    void this.syncNow()
    this.timer = setInterval(() => void this.syncNow(), intervalMs)
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = null
  }

  private async performSync(): Promise<void> {
    try {
      await this.refreshServerStatus()
      await this.pushPending()
      await this.pullChanges()
      this.lastSyncAt = this.now()
      this.lastError = undefined
    } catch (error) {
      this.lastError = error instanceof Error ? error.message : String(error)
    }
  }

  private async refreshServerStatus(): Promise<void> {
    const response = await this.requestJson<TeamServerStatusResponse>(
      this.serverUrl,
      '/api/v1/status',
      { method: 'GET' },
      this.credentials!.deviceToken
    )
    if (!response.instanceId || response.instanceId !== this.credentials!.instanceId) {
      throw new Error('团队服务器实例已变化，请退出后重新加入')
    }
    const next: TeamDeviceCredentials = {
      ...this.credentials!,
      teamName: response.teamName,
      device: response.device
    }
    if (
      next.teamName !== this.credentials!.teamName ||
      JSON.stringify(next.device) !== JSON.stringify(this.credentials!.device)
    ) {
      this.options.onCredentials(next)
      this.credentials = next
    }
  }

  private async pushPending(): Promise<void> {
    while (true) {
      const items = this.storage.readBatch(100)
      if (items.length === 0) return
      await this.pushBatch(items)
      this.emit()
    }
  }

  private async pushBatch(items: TeamArticleUpload[]): Promise<void> {
    try {
      await this.requestJson<TeamPushResponse>(
        this.serverUrl,
        '/api/v1/sync/push',
        { method: 'POST', body: JSON.stringify({ items }) },
        this.credentials!.deviceToken
      )
      // HTTP 成功表示整批事件已被服务端幂等处理；accepted 包含幂等重复项，不能据此保留事件。
      this.storage.acknowledge(items.map((item) => item.eventId))
    } catch (error) {
      const permanent =
        error instanceof TeamHttpError && [400, 409, 413, 422].includes(error.status)
      if (!permanent) throw error
      if (items.length === 1) {
        this.storage.quarantine(items[0], error.message)
        return
      }
      const middle = Math.floor(items.length / 2)
      await this.pushBatch(items.slice(0, middle))
      await this.pushBatch(items.slice(middle))
    }
  }

  private async pullChanges(): Promise<void> {
    let cursor = this.storage.cursor()
    let changed = false
    while (true) {
      const response = await this.requestJson<TeamPullResponse>(
        this.serverUrl,
        `/api/v1/sync/pull?cursor=${cursor}&limit=200`,
        { method: 'GET' },
        this.credentials!.deviceToken
      )
      if (!Number.isInteger(response.cursor) || response.cursor < cursor || !Array.isArray(response.changes)) {
        throw new Error('团队服务器返回了无效的同步游标')
      }
      if (response.hasMore && response.cursor === cursor) {
        throw new Error('团队服务器同步游标没有前进')
      }
      for (const change of response.changes) {
        if (change.type !== 'article.upsert') continue
        const mine = change.article.contributors.some(
          (contributor) => contributor.deviceId === this.credentials!.device.id
        )
        this.options.onRemoteArticle(change.article, mine)
        changed = true
      }
      cursor = response.cursor
      this.storage.saveCursor(cursor)
      if (!response.hasMore) {
        if (changed) this.options.onRemoteArticlesChanged?.()
        return
      }
    }
  }

  private async requestJson<T>(
    serverUrl: string,
    path: string,
    init: RequestInit,
    deviceToken: string | null
  ): Promise<T> {
    const headers = new Headers(init.headers)
    headers.set('content-type', 'application/json')
    if (deviceToken) headers.set('authorization', `Bearer ${deviceToken}`)
    const response = await this.fetchImpl(`${serverUrl}${path}`, {
      ...init,
      headers,
      signal: init.signal ?? AbortSignal.timeout(15_000)
    })
    if (!response.ok) {
      let detail = ''
      try {
        const body = (await response.json()) as {
          error?: string | { message?: string }
          message?: string
        }
        detail = body.message ?? (typeof body.error === 'string' ? body.error : body.error?.message) ?? ''
      } catch {
        // 无 JSON 错误体时只报告状态码。
      }
      throw new TeamHttpError(
        response.status,
        `团队服务器请求失败 (${response.status})${detail ? `：${detail}` : ''}`
      )
    }
    return (await response.json()) as T
  }

  private emit(): void {
    this.options.onStatus?.(this.status())
  }
}
