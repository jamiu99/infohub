import { createHash } from 'node:crypto'
import type { Article, ArticleDetail, Source } from '../../shared/contract'
import { userFacingError } from '../../shared/errors'
import {
  toTeamArticlePayload,
  toTeamSourcePayload,
  TEAM_SYNC_INTERVAL,
  validateTeamServerUrl,
  validateTeamSyncIntervalMinutes,
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
type TimerHandle = ReturnType<typeof setTimeout>
type SetTimeoutLike = (callback: () => void, delay: number) => TimerHandle
type ClearTimeoutLike = (timer: TimerHandle) => void

export interface TeamSyncClientOptions {
  paths: Paths
  serverUrl: string
  enabled: boolean
  autoSyncEnabled?: boolean
  intervalMinutes?: number
  credentials?: TeamDeviceCredentials | null
  fetchImpl?: FetchLike
  now?: () => number
  setTimeoutImpl?: SetTimeoutLike
  clearTimeoutImpl?: ClearTimeoutLike
  onCredentials: (credentials: TeamDeviceCredentials | null) => void
  onRemoteArticle: (record: TeamArticleRecord, contributedByMe: boolean) => void
  onRemoteArticlesChanged?: () => void
  onStatus?: (status: TeamStatus) => void
}

const TEAM_API_PREFIX = '/api/v2'
const TEAM_PULL_LIMIT = 50

class TeamHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

export class TeamSyncClient {
  private storage: TeamSyncStorage
  private fetchImpl: FetchLike
  private now: () => number
  private setTimeoutImpl: SetTimeoutLike
  private clearTimeoutImpl: ClearTimeoutLike
  private serverUrl: string
  private enabled: boolean
  private autoSyncEnabled: boolean
  private intervalMinutes: number
  private credentials: TeamDeviceCredentials | null
  private lastSyncAt?: number
  private lastError?: string
  private nextSyncAt?: number
  private syncing: Promise<TeamStatus> | null = null
  private timer: TimerHandle | null = null
  private started = false

  constructor(private options: TeamSyncClientOptions) {
    this.storage = new TeamSyncStorage(options.paths)
    this.fetchImpl = options.fetchImpl ?? fetch
    this.now = options.now ?? Date.now
    this.setTimeoutImpl = options.setTimeoutImpl ?? ((callback, delay) => setTimeout(callback, delay))
    this.clearTimeoutImpl = options.clearTimeoutImpl ?? ((timer) => clearTimeout(timer))
    this.serverUrl = validateTeamServerUrl(options.serverUrl)
    this.enabled = options.enabled
    this.autoSyncEnabled = options.autoSyncEnabled ?? true
    this.intervalMinutes = validateTeamSyncIntervalMinutes(
      options.intervalMinutes ?? TEAM_SYNC_INTERVAL.defaultMinutes
    )
    this.credentials = options.credentials ?? null
  }

  configure(input: { serverUrl: string; enabled: boolean }): void {
    this.serverUrl = validateTeamServerUrl(input.serverUrl)
    this.enabled = input.enabled
    this.emit()
  }

  /**
   * 自动同步只控制定时网络请求，不改变团队连接、outbox 入队或手动 syncNow。
   * 开启时立即同步一次；修改已开启的周期则从保存时重新等待完整周期。
   */
  configureSchedule(input: { autoSyncEnabled: boolean; intervalMinutes: number }): void {
    const intervalMinutes = validateTeamSyncIntervalMinutes(input.intervalMinutes)
    const wasEnabled = this.autoSyncEnabled
    this.autoSyncEnabled = input.autoSyncEnabled === true
    this.intervalMinutes = intervalMinutes
    this.clearSchedule()

    if (!this.started) {
      this.emit()
      return
    }
    if (!this.autoSyncEnabled) {
      this.emit()
      return
    }
    if (!wasEnabled) {
      this.emit()
      void this.syncNow()
      return
    }
    // 当前轮完成时会按新周期排下一轮；没有正在同步时现在就重置倒计时。
    if (!this.syncing) this.scheduleNext()
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
      autoSyncEnabled: this.autoSyncEnabled,
      intervalMinutes: this.intervalMinutes,
      nextSyncAt: this.nextSyncAt,
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
      `${TEAM_API_PREFIX}/join`,
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
  enqueue(source: Source, article: Article | ArticleDetail, emitStatus = true): boolean {
    if (!this.enabled || !this.credentials || this.credentials.serverUrl !== this.serverUrl) return false
    // 团队 v2 DTO 没有 partial/failed 状态，远端收到 contentHtml 会登记为 complete。
    // 因此新版微信文章只有完整解析后才能入队；没有 content 状态的旧历史文件仍按原契约处理。
    if (
      source.type === 'wechat' &&
      article.content &&
      article.content.status !== 'complete'
    ) {
      return false
    }
    const sourcePayload = toTeamSourcePayload(source)
    const articlePayload = toTeamArticlePayload(article)
    const eventId = createHash('sha256')
      .update(JSON.stringify({
        version: 2,
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

  seedExisting(sources: Source[], articles: Array<Article | ArticleDetail>): number {
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
    // 手动同步也重置自动倒计时，避免刚完成后又命中旧 timer。
    this.clearSchedule()
    if (!this.enabled || !this.credentials || this.credentials.serverUrl !== this.serverUrl) {
      this.scheduleNext()
      this.emit()
      return Promise.resolve(this.status())
    }
    const run = this.performSync().then(() => {
      this.syncing = null
      this.scheduleNext()
      this.emit()
      return this.status()
    })
    this.syncing = run
    this.emit()
    return run
  }

  start(): void {
    if (this.started) return
    this.started = true
    if (this.autoSyncEnabled) void this.syncNow()
    else this.emit()
  }

  stop(): void {
    this.started = false
    this.clearSchedule()
  }

  /** 停止后续定时器并等待当前网络同步及其本地写入收尾。 */
  async stopAndWait(): Promise<void> {
    this.stop()
    await this.syncing
  }

  private clearSchedule(): void {
    if (this.timer !== null) this.clearTimeoutImpl(this.timer)
    this.timer = null
    this.nextSyncAt = undefined
  }

  private scheduleNext(): void {
    if (!this.started || !this.autoSyncEnabled) return
    this.clearSchedule()
    const delay = this.intervalMinutes * 60_000
    this.nextSyncAt = this.now() + delay
    this.timer = this.setTimeoutImpl(() => {
      this.timer = null
      this.nextSyncAt = undefined
      void this.syncNow()
    }, delay)
  }

  private async performSync(): Promise<void> {
    try {
      await this.refreshServerStatus()
      await this.pushPending()
      await this.pullChanges()
      this.lastSyncAt = this.now()
      this.lastError = undefined
    } catch (error) {
      this.lastError = userFacingError(error, '团队同步失败')
    }
  }

  private async refreshServerStatus(): Promise<void> {
    const response = await this.requestJson<TeamServerStatusResponse>(
      this.serverUrl,
      `${TEAM_API_PREFIX}/status`,
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
      const items = this.storage.readBatch()
      if (items.length === 0) return
      await this.pushBatch(items)
      this.emit()
    }
  }

  private async pushBatch(items: TeamArticleUpload[]): Promise<void> {
    try {
      await this.requestJson<TeamPushResponse>(
        this.serverUrl,
        `${TEAM_API_PREFIX}/sync/push`,
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
        `${TEAM_API_PREFIX}/sync/pull?cursor=${cursor}&limit=${TEAM_PULL_LIMIT}`,
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
      const versionHint = response.status === 404 && path.startsWith(TEAM_API_PREFIX)
        ? '：服务器未提供团队 API v2，请先升级团队服务端'
        : detail ? `：${detail}` : ''
      throw new TeamHttpError(response.status, `团队服务器请求失败 (${response.status})${versionHint}`)
    }
    return (await response.json()) as T
  }

  private emit(): void {
    this.options.onStatus?.(this.status())
  }
}
