// 主服务：装配本地 Store、采集/维护任务、团队同步与类型化 IPC。
// 自动采集默认关闭；启用后仍受批次互斥、账号配额和微信请求门保护。
import { BrowserWindow, ipcMain } from 'electron'
import { randomUUID } from 'node:crypto'
import type { Paths } from '../core/paths'
import { Store } from '../core/store'
import { AccountPool } from '../core/collect/account-pool'
import { Collector } from '../core/collect/collector'
import { CollectionRunner } from '../core/collect/collection-runner'
import { AutoCollectScheduler } from '../core/collect/auto-collect-scheduler'
import { automaticCollectionFeedback } from '../core/collect/collection-feedback'
import { AdapterRegistry } from '../core/ingest/adapter'
import { WechatAdapter } from '../core/ingest/wechat-adapter'
import { RssAdapter } from '../core/ingest/rss-adapter'
import '../core/process/wechat'
import '../core/process/rss'
import { IPC } from '../shared/ipc'
import type { Source } from '../shared/contract'
import type { DiscoverResult } from '../core/ingest/adapter'
import { saveAccounts, loadAccounts } from './secrets'
import { openWechatLogin, makeAccount } from './wechat-login'
import { ensureDataGuide } from './data-guide'
import {
  loadSettings,
  saveSettings,
  toCollectionSettingsView,
  toWechatCollectionSettings,
  type InfohubSettings
} from '../core/settings'
import { validateWechatHourlyLimit } from '../core/collect/rate-limit'
import { validateAutoCollectIntervalMinutes, type CollectionScheduleStatus } from '../shared/collection'
import { TeamSyncClient } from '../core/team/sync-client'
import { applyRemoteArticle } from '../core/team/apply-remote'
import { clearTeamCredentials, loadTeamCredentials, saveTeamCredentials } from './team-secrets'
import {
  rssSourceId,
  validateTeamServerUrl,
  validateTeamSyncIntervalMinutes,
  type TeamJoinInput
} from '../shared/team'
import {
  validateArticleMaintenanceRequest,
  type ArticleMaintenanceItemResult,
  type ArticleMaintenanceResult
} from '../shared/maintenance'
import { userFacingError } from '../shared/errors'

export interface ServiceOptions {
  paths: Paths
}

export class Service {
  private store: Store
  private pool: AccountPool
  private collector: Collector
  private registry: AdapterRegistry
  private settings: InfohubSettings
  private team: TeamSyncClient
  private collectionRunner: CollectionRunner
  private autoCollect: AutoCollectScheduler
  private stopped = false
  private storeClosed = false
  private maintenanceRunning = false
  private maintenanceIdleWaiters = new Set<() => void>()
  private nextAutoRunAt?: number
  private lastAutoRunAt?: number
  private automaticRunning = false
  private collectionMessage?: string
  private collectionFeedbackState?: Extract<CollectionScheduleStatus['state'], 'error' | 'paused'>
  private readonly paths: Paths

  constructor(options: ServiceOptions) {
    this.paths = options.paths
    this.store = new Store(this.paths)
    this.settings = loadSettings(this.paths.settings)
    this.pool = new AccountPool(loadAccounts(this.paths.wxAccounts), {
      hourLimit: this.settings.wechat.hourlyRequestLimit,
      persist: (accounts) => saveAccounts(this.paths.wxAccounts, accounts),
      onChange: () => this.broadcast('accounts-changed')
    })
    this.team = new TeamSyncClient({
      paths: this.paths,
      serverUrl: this.settings.team.serverUrl,
      enabled: this.settings.team.enabled,
      autoSyncEnabled: this.settings.team.autoSyncEnabled,
      intervalMinutes: this.settings.team.intervalMinutes,
      credentials: loadTeamCredentials(this.paths.teamDevice),
      onCredentials: (credentials) => {
        if (credentials) saveTeamCredentials(this.paths.teamDevice, credentials)
        else clearTeamCredentials(this.paths.teamDevice)
      },
      onRemoteArticle: (record, mine) => {
        applyRemoteArticle(this.store, record, mine, this.store.listSources())
      },
      onRemoteArticlesChanged: () => this.broadcast('articles-changed'),
      onStatus: (status) => this.broadcast('team-status', status)
    })

    this.registry = new AdapterRegistry()
    this.registry.register(new WechatAdapter(this.pool))
    this.registry.register(new RssAdapter())
    this.collector = new Collector(this.registry, this.store, (source, article) => {
      this.team.enqueue(source, this.store.getArticleDetail(article.id) ?? article)
    })

    this.collectionRunner = new CollectionRunner({
      listSources: () => this.store.listSources(),
      shouldStop: () => this.stopped,
      collectSource: async (source) => {
        const result = await this.collector.collectSource(source)
        if (!this.stopped && result.newArticles + result.updatedArticles > 0) {
          this.broadcast('articles-changed')
        }
        return result
      },
      markFetchedAt: (sourceId, fetchedAt) => this.markSourceFetchedAt(sourceId, fetchedAt),
      onProgress: (progress) => this.broadcast('ingest-progress', progress),
      onError: (error, source) => console.error(`采集 ${source.name} 失败:`, error)
    })

    this.autoCollect = new AutoCollectScheduler({
      isBusy: () => this.collectionRunner.isBusy() || this.maintenanceRunning,
      run: async () => {
        this.automaticRunning = true
        this.collectionMessage = undefined
        this.collectionFeedbackState = undefined
        this.nextAutoRunAt = undefined
        this.broadcastCollectionStatus()
        try {
          const batch = await this.collectionRunner.runAutomatic()
          this.lastAutoRunAt = Date.now()
          const feedback = automaticCollectionFeedback(batch)
          this.collectionFeedbackState = feedback?.state
          this.collectionMessage = feedback?.message
        } finally {
          this.automaticRunning = false
          this.broadcastCollectionStatus()
        }
      },
      onScheduled: (nextRunAt) => {
        this.nextAutoRunAt = nextRunAt
        this.broadcastCollectionStatus()
      },
      onSkipped: (reason) => {
        this.nextAutoRunAt = undefined
        this.collectionFeedbackState = 'paused'
        this.collectionMessage =
          reason === 'late'
            ? '电脑刚从睡眠中恢复，本轮已跳过并重新等待完整周期。'
            : '已有采集或维护任务在运行，本轮已跳过。'
        this.broadcastCollectionStatus()
      },
      onError: (error) => {
        this.collectionFeedbackState = 'error'
        this.collectionMessage = userFacingError(error, '自动采集失败')
        this.broadcastCollectionStatus()
      }
    })
  }

  private broadcast(channel: string, ...args: unknown[]): void {
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send(channel, ...args)
  }

  private handle(channel: string, fn: (...args: unknown[]) => unknown): void {
    ipcMain.handle(channel, async (_event, ...args) => {
      try {
        return await fn(...args)
      } catch (error) {
        console.error(`[IPC ${channel}] 失败:`, error)
        throw error
      }
    })
  }

  private makeSourceId(type: string, result: DiscoverResult): string {
    const config = result.config as { fakeid?: string; feedUrl?: string }
    if (type === 'wechat' && config.fakeid) return `wx-${config.fakeid}`
    if (type === 'rss' && config.feedUrl) return rssSourceId(config.feedUrl)
    return `${type}-${randomUUID().slice(0, 8)}`
  }

  private seedTeamHistory(): void {
    if (!this.team.status().device) return
    this.team.seedExisting(
      this.store.listSources(),
      this.store.listContributedArticlesForSync()
    )
  }

  private markSourceFetchedAt(sourceId: string, fetchedAt: number): void {
    const sources = this.store.listSources()
    const index = sources.findIndex((source) => source.id === sourceId)
    if (index < 0) return
    sources[index] = { ...sources[index], lastFetchedAt: fetchedAt }
    this.store.saveSources(sources)
  }

  private collectionStatus(): CollectionScheduleStatus {
    const enabled = this.settings.collection.autoCollectEnabled
    return {
      state: !enabled
        ? 'disabled'
        : this.automaticRunning
          ? 'running'
          : this.collectionFeedbackState ?? 'scheduled',
      enabled,
      intervalMinutes: this.settings.collection.intervalMinutes,
      ...(this.nextAutoRunAt ? { nextRunAt: this.nextAutoRunAt } : {}),
      ...(this.lastAutoRunAt ? { lastRunAt: this.lastAutoRunAt } : {}),
      ...(this.collectionMessage ? { message: this.collectionMessage } : {})
    }
  }

  private broadcastCollectionStatus(): void {
    this.broadcast('collection-status', this.collectionStatus())
  }

  private configureAutoCollect(): void {
    this.autoCollect.configure({
      enabled: this.settings.collection.autoCollectEnabled,
      intervalMs: this.settings.collection.intervalMinutes * 60_000
    })
  }

  private runInitialCollection(sourceId: string): void {
    if (this.maintenanceRunning || this.stopped) return
    void this.collectionRunner.runInitialWhenIdle(sourceId).catch((error) => {
      if (!this.stopped) console.error('新增信源首次采集失败:', error)
    })
  }

  private runManualCollection(sourceId?: string): void {
    if (this.maintenanceRunning) throw new Error('正在重新处理历史文章，请完成后再刷新信源')
    void this.collectionRunner.runManual(sourceId)
  }

  private maintenanceArticles(
    request: ReturnType<typeof validateArticleMaintenanceRequest>
  ): ReturnType<Store['listArticlesForMaintenance']> {
    if (request.scope === 'article') {
      const article = this.store.getArticle(request.articleId!)
      return article ? [article] : []
    }
    const articles = this.store.listArticlesForMaintenance({
      ...(request.scope === 'source' ? { sourceId: request.sourceId } : {}),
      mineOnly: true
    })
    return articles.filter((article) => {
      const adapter = this.registry.get(article.source.type)
      return request.mode === 'offline'
        ? Boolean(adapter?.parseContentPage)
        : Boolean(adapter?.enrichContent)
    })
  }

  private async reprocessArticles(rawRequest: unknown): Promise<ArticleMaintenanceResult> {
    const request = validateArticleMaintenanceRequest(rawRequest)
    if (this.maintenanceRunning || this.collectionRunner.isBusy()) {
      throw new Error('已有采集或历史维护任务正在运行，请稍后再试')
    }
    this.maintenanceRunning = true
    let articlesChanged = false
    const items: ArticleMaintenanceItemResult[] = []
    const counts = { total: 0, updated: 0, unchanged: 0, failed: 0, skipped: 0 }
    const record = (item: ArticleMaintenanceItemResult): void => {
      counts.total++
      counts[item.status]++
      // IPC 只返回有限诊断样本；总计数仍覆盖完整批次。
      if (items.length < 200) items.push(item)
    }
    try {
      const articles = this.maintenanceArticles(request)
      for (let index = 0; index < articles.length; index++) {
        // 退出/资料库迁移只等待当前文章安全落盘，不再开始后续长批任务。
        if (this.stopped) break
        const article = articles[index]
        this.broadcast('ingest-progress', {
          phase: 'polling',
          origin: 'maintenance',
          currentSource: article.source.name,
          queued: articles.length - index
        })
        if (article.team?.contributedByMe === false) {
          record({
            articleId: article.id,
            title: article.title,
            status: 'skipped',
            message: '仅来自团队的文章不会由本机重新抓取'
          })
          continue
        }
        try {
          const result = await this.collector.reprocessArticle(article, request.mode)
          record(result)
          if (result.status === 'updated') articlesChanged = true
        } catch (error) {
          record({
            articleId: article.id,
            title: article.title,
            status: 'failed',
            message: userFacingError(error, '重新处理正文失败')
          })
        }
      }
    } finally {
      this.maintenanceRunning = false
      for (const resolve of this.maintenanceIdleWaiters) resolve()
      this.maintenanceIdleWaiters.clear()
      if (articlesChanged && !this.stopped) this.broadcast('articles-changed')
      this.broadcast('ingest-progress', {
        phase: 'idle',
        origin: 'maintenance',
        queued: 0
      })
    }
    return {
      mode: request.mode,
      scope: request.scope,
      total: counts.total,
      updated: counts.updated,
      unchanged: counts.unchanged,
      failed: counts.failed,
      skipped: counts.skipped,
      items
    }
  }

  start(): void {
    this.registerIpc()
    try {
      ensureDataGuide(this.paths)
    } catch (error) {
      console.error('生成资料库说明失败:', error)
    }
    try {
      this.seedTeamHistory()
    } catch (error) {
      console.error('启动时恢复历史团队数据失败:', error)
    }
    this.team.start()
    this.configureAutoCollect()
  }

  /** 系统唤醒时放弃错过的轮次，重新等待一个完整周期。 */
  resume(): void {
    this.autoCollect.resume()
  }

  private registerIpc(): void {
    // —— 账号 ——
    this.handle(IPC.accountList, () => this.pool.views())
    this.handle(IPC.accountLogin, async () => {
      const id = randomUUID().slice(0, 8)
      const partition = `persist:wx-${id}`
      const result = await openWechatLogin(partition)
      if (result) this.pool.add(makeAccount(id, partition, result, Date.now()))
      return this.pool.views()
    })
    this.handle(IPC.accountRelogin, async (accountId) => {
      const account = this.pool.get(accountId as string)
      if (!account) return this.pool.views()
      const result = await openWechatLogin(account.partition)
      if (result) {
        this.pool.refreshCredentials(account.id, {
          token: result.token,
          cookies: result.cookies,
          nickname: result.nickname
        })
      }
      return this.pool.views()
    })
    this.handle(IPC.accountRemove, (id) => this.pool.remove(id as string))
    this.handle(IPC.accountGetCollectionSettings, () => toWechatCollectionSettings(this.settings))
    this.handle(IPC.accountSetHourlyRequestLimit, (rawValue) => {
      const hourlyRequestLimit = validateWechatHourlyLimit(rawValue)
      const next: InfohubSettings = { ...this.settings, wechat: { hourlyRequestLimit } }
      saveSettings(this.paths.settings, next)
      this.settings = next
      this.pool.setHourLimit(hourlyRequestLimit)
      return toWechatCollectionSettings(this.settings)
    })

    // —— 自动采集计划 ——
    this.handle(IPC.collectionGetSettings, () => toCollectionSettingsView(this.settings))
    this.handle(IPC.collectionStatus, () => this.collectionStatus())
    this.handle(IPC.collectionUpdateSettings, (rawInput) => {
      if (!rawInput || typeof rawInput !== 'object') throw new Error('自动采集设置无效')
      const input = rawInput as { autoCollectEnabled?: unknown; intervalMinutes?: unknown }
      const next: InfohubSettings = {
        ...this.settings,
        collection: {
          autoCollectEnabled: input.autoCollectEnabled === true,
          intervalMinutes: validateAutoCollectIntervalMinutes(input.intervalMinutes)
        }
      }
      saveSettings(this.paths.settings, next)
      this.settings = next
      this.collectionMessage = undefined
      this.collectionFeedbackState = undefined
      this.configureAutoCollect()
      return toCollectionSettingsView(this.settings)
    })

    // —— 信源 ——
    this.handle(IPC.sourceList, () => this.store.listSources())
    this.handle(IPC.sourceSearch, (type, query) =>
      this.collector.discover(type as string, query as string)
    )
    this.handle(IPC.sourceAdd, (type, result) => {
      const sourceType = type as string
      const candidate = result as DiscoverResult
      const sources = this.store.listSources()
      const source: Source = {
        id: this.makeSourceId(sourceType, candidate),
        type: sourceType,
        name: candidate.name,
        enabled: true,
        config: candidate.config
      }
      if (!sources.find((item) => item.id === source.id)) {
        sources.push(source)
        this.store.saveSources(sources)
      }
      this.runInitialCollection(source.id)
      return source
    })
    this.handle(IPC.sourceSetEnabled, (rawSourceId, rawEnabled) => {
      const sourceId = typeof rawSourceId === 'string' ? rawSourceId.trim() : ''
      if (!sourceId || typeof rawEnabled !== 'boolean') throw new Error('信源启停参数无效')
      const sources = this.store.listSources()
      const index = sources.findIndex((source) => source.id === sourceId)
      if (index < 0) throw new Error('信源不存在或已取消关注')
      const source = { ...sources[index], enabled: rawEnabled }
      sources[index] = source
      this.store.saveSources(sources)
      return source
    })
    this.handle(IPC.sourceRemove, (id) => {
      const sourceId = id as string
      this.store.saveSources(this.store.listSources().filter((source) => source.id !== sourceId))
      this.store.purgeSource(sourceId)
      this.broadcast('articles-changed')
    })
    this.handle(IPC.sourceRefresh, (sourceId) => {
      this.runManualCollection(sourceId as string | undefined)
    })

    // —— 文章与历史维护 ——
    this.handle(IPC.articleList, (opts) => {
      const options = opts as {
        sourceId?: string
        filter?: 'unread' | 'all' | 'archived'
        scope?: 'mine' | 'team'
      } | undefined
      const articles = this.store.listArticles(options)
      if (options?.scope === 'team') return articles
      const followed = new Set(this.store.listSources().map((source) => source.id))
      return articles.filter((article) => followed.has(article.source.id))
    })
    // 阅读页先取 Markdown；体积更大的公众号 HTML 仅在用户选择原始排版时读取。
    this.handle(IPC.articleGet, (id) => this.store.getArticle(id as string))
    this.handle(IPC.articleGetContentHtml, (id) =>
      this.store.getArticleContentHtml(id as string)
    )
    this.handle(IPC.articleMarkRead, (id, read) =>
      this.store.setRead(id as string, read as boolean)
    )
    this.handle(IPC.articleMarkAllRead, (rawOptions) => {
      if (
        rawOptions !== undefined &&
        (!rawOptions || typeof rawOptions !== 'object' || Array.isArray(rawOptions))
      ) {
        throw new Error('批量已读范围无效')
      }
      const input = (rawOptions ?? {}) as { sourceId?: unknown; scope?: unknown }
      if (input.sourceId !== undefined && typeof input.sourceId !== 'string') {
        throw new Error('批量已读来源无效')
      }
      const sourceId = typeof input.sourceId === 'string' ? input.sourceId.trim() : ''
      const scope = input.scope ?? 'mine'
      if (scope !== 'mine' && scope !== 'team') throw new Error('批量已读范围无效')
      return this.store.markAllRead({
        ...(sourceId ? { sourceId } : {}),
        scope
      })
    })
    this.handle(IPC.articleArchive, (id) => this.store.setArchived(id as string, true))
    this.handle(IPC.articleUnreadCounts, () => this.store.unreadCounts())
    this.handle(IPC.articleReprocess, (request) => this.reprocessArticles(request))

    // —— 团队同步 ——
    this.handle(IPC.teamStatus, () => this.team.status())
    this.handle(IPC.teamUpdateSettings, (rawInput) => {
      if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) {
        throw new Error('团队自动同步设置无效')
      }
      const input = rawInput as { autoSyncEnabled?: unknown; intervalMinutes?: unknown }
      if (typeof input.autoSyncEnabled !== 'boolean') {
        throw new Error('请选择是否开启团队自动同步')
      }
      const next: InfohubSettings = {
        ...this.settings,
        team: {
          ...this.settings.team,
          autoSyncEnabled: input.autoSyncEnabled,
          intervalMinutes: validateTeamSyncIntervalMinutes(input.intervalMinutes)
        }
      }
      saveSettings(this.paths.settings, next)
      this.settings = next
      this.team.configureSchedule({
        autoSyncEnabled: next.team.autoSyncEnabled,
        intervalMinutes: next.team.intervalMinutes
      })
      return this.team.status()
    })
    this.handle(IPC.teamJoin, async (rawInput) => {
      const input = rawInput as TeamJoinInput
      const serverUrl = validateTeamServerUrl(input.serverUrl)
      const status = await this.team.join({ ...input, serverUrl })
      const next: InfohubSettings = {
        ...this.settings,
        team: { ...this.settings.team, serverUrl, enabled: true }
      }
      try {
        saveSettings(this.paths.settings, next)
      } catch (error) {
        this.team.leave()
        throw error
      }
      this.settings = next
      this.team.configure(next.team)
      setImmediate(() => {
        if (this.stopped) return
        try {
          this.seedTeamHistory()
        } catch (error) {
          console.error('历史团队数据排队失败:', error)
        }
        void this.team.syncNow()
      })
      return status
    })
    this.handle(IPC.teamLeave, () => {
      const next: InfohubSettings = {
        ...this.settings,
        team: { ...this.settings.team, enabled: false }
      }
      saveSettings(this.paths.settings, next)
      this.settings = next
      return this.team.leave()
    })
    this.handle(IPC.teamSyncNow, () => this.team.syncNow())
  }

  /** 数据目录迁移重启前等待所有已进入采集链的写入完成，再关闭 SQLite。 */
  async prepareForRestart(): Promise<void> {
    if (!this.stopped) {
      this.stopped = true
      this.autoCollect.stop()
      this.team.stop()
    }
    await Promise.all([
      this.collectionRunner.waitForIdle(),
      this.waitForMaintenance(),
      this.team.stopAndWait()
    ])
    await this.collector.drain()
    if (!this.storeClosed) {
      this.storeClosed = true
      this.store.close()
    }
  }

  stop(): Promise<void> {
    return this.prepareForRestart()
  }

  private waitForMaintenance(): Promise<void> {
    if (!this.maintenanceRunning) return Promise.resolve()
    return new Promise((resolve) => this.maintenanceIdleWaiters.add(resolve))
  }
}
