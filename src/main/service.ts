// 主服务：装配 store / 账号池 / adapter 注册表 / collector，注册 IPC。
// 安全约束（应 jamiu 要求）：默认【不】自动轮询，只在用户手动点刷新时采集，
// 且采集全局串行（见 Collector 的锁），杜绝并发请求影响真实账号。
import { ipcMain, BrowserWindow, app } from 'electron'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { makePaths } from '../core/paths'
import { Store } from '../core/store'
import { AccountPool } from '../core/collect/account-pool'
import { Collector } from '../core/collect/collector'
import { AdapterRegistry } from '../core/ingest/adapter'
import { WechatAdapter } from '../core/ingest/wechat-adapter'
import { RssAdapter } from '../core/ingest/rss-adapter'
import '../core/process/wechat' // 自注册 wechat normalizer
import '../core/process/rss' // 自注册 rss normalizer
import { IPC } from '../shared/ipc'
import type { Source } from '../shared/contract'
import type { DiscoverResult } from '../core/ingest/adapter'
import { saveAccounts, loadAccounts } from './secrets'
import { openWechatLogin, makeAccount } from './wechat-login'
import { ensureDataGuide } from './data-guide'

export class Service {
  private store: Store
  private pool: AccountPool
  private collector: Collector
  private registry: AdapterRegistry
  private stopped = false
  private paths = makePaths(join(app.getPath('userData'), 'data'))

  constructor() {
    this.store = new Store(this.paths)
    this.pool = new AccountPool(loadAccounts(this.paths.wxAccounts), {
      persist: (a) => saveAccounts(this.paths.wxAccounts, a),
      onChange: () => this.broadcast('accounts-changed')
    })
    // 注册各信源 adapter（加新信源只需在这里多注册一个）
    this.registry = new AdapterRegistry()
    this.registry.register(new WechatAdapter(this.pool))
    this.registry.register(new RssAdapter())
    this.collector = new Collector(this.registry, this.store)
  }

  private broadcast(channel: string, ...args: unknown[]): void {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, ...args)
  }

  /** 包装 ipcMain.handle，捕获并打印异常（否则前端只见 rejected promise，主进程无日志难排查） */
  private handle(channel: string, fn: (...args: unknown[]) => unknown): void {
    ipcMain.handle(channel, async (_e, ...args) => {
      try {
        return await fn(...args)
      } catch (err) {
        console.error(`[IPC ${channel}] 失败:`, err)
        throw err
      }
    })
  }

  /** 由 type + config 派生稳定 source id（wechat 用 fakeid、rss 用 feedUrl 哈希） */
  private makeSourceId(type: string, result: DiscoverResult): string {
    const c = result.config as { fakeid?: string; feedUrl?: string }
    if (type === 'wechat' && c.fakeid) return `wx-${c.fakeid}`
    if (type === 'rss' && c.feedUrl) {
      let h = 0
      for (let i = 0; i < c.feedUrl.length; i++) h = (h * 31 + c.feedUrl.charCodeAt(i)) | 0
      return `rss-${(h >>> 0).toString(36)}`
    }
    return `${type}-${randomUUID().slice(0, 8)}`
  }

  /** 后台采集一个源：广播进度（polling→idle），完成后刷新文章流。不阻塞调用方。 */
  private async collectInBackground(source: Source): Promise<void> {
    this.broadcast('ingest-progress', { phase: 'polling', currentSource: source.name, queued: 1 })
    try {
      const r = await this.collector.collectSource(source)
      if (r.newArticles > 0) this.broadcast('articles-changed')
    } finally {
      this.broadcast('ingest-progress', { phase: 'idle', queued: 0 })
    }
  }

  /** 后台刷新：单个或全部源，串行采集并逐个广播进度。 */
  private async refreshInBackground(sourceId?: string): Promise<void> {
    const sources = this.store.listSources()
    const targets = sourceId ? sources.filter((s) => s.id === sourceId) : sources.filter((s) => s.enabled)
    let total = 0
    try {
      for (let i = 0; i < targets.length; i++) {
        const s = targets[i]
        this.broadcast('ingest-progress', {
          phase: 'polling',
          currentSource: s.name,
          queued: targets.length - i
        })
        const r = await this.collector.collectSource(s)
        total += r.newArticles
        if (r.newArticles > 0) this.broadcast('articles-changed') // 每源完成即刷新
      }
    } finally {
      this.broadcast('ingest-progress', { phase: 'idle', queued: 0 })
      if (total > 0) this.broadcast('articles-changed')
    }
  }


  start(): void {
    this.registerIpc()
    try {
      ensureDataGuide(this.paths)
    } catch (e) {
      console.error('ensureDataGuide failed:', (e as Error).message)
    }
    // 注意：不启动任何自动轮询定时器。采集只由用户手动触发（source:refresh）。
  }

  private registerIpc(): void {
    // 全部 handler 走 this.handle 包装（自动打印异常，便于排查）
    // —— 账号 ——
    this.handle(IPC.accountList, () => this.pool.views())
    // 登录：开一个独立分区窗口，用户扫码登录一个号，关窗时抓取并入池。
    this.handle(IPC.accountLogin, async () => {
      const id = randomUUID().slice(0, 8)
      const partition = `persist:wx-${id}`
      const r = await openWechatLogin(partition)
      if (r) this.pool.add(makeAccount(id, partition, r, Date.now()))
      return this.pool.views()
    })
    // relogin：某账号失效时，复用其原分区重新登录刷新 token+cookie。
    this.handle(IPC.accountRelogin, async (accountId) => {
      const acc = this.pool.get(accountId as string)
      if (!acc) return this.pool.views()
      const r = await openWechatLogin(acc.partition)
      if (r) this.pool.refreshCredentials(acc.id, { token: r.token, cookies: r.cookies, nickname: r.nickname })
      return this.pool.views()
    })
    this.handle(IPC.accountRemove, (id) => this.pool.remove(id as string))

    // —— 信源 ——
    this.handle(IPC.sourceList, () => this.store.listSources())
    this.handle(IPC.sourceSearch, (type, q) => this.collector.discover(type as string, q as string))
    this.handle(IPC.sourceAdd, (type, result) => {
      const t = type as string
      const res = result as DiscoverResult
      const sources = this.store.listSources()
      const source: Source = {
        id: this.makeSourceId(t, res),
        type: t,
        name: res.name,
        enabled: true,
        config: res.config
      }
      if (!sources.find((s) => s.id === source.id)) {
        sources.push(source)
        this.store.saveSources(sources)
      }
      // 立即返回（关注瞬间生效，UI 秒关弹窗）；首次采集放后台异步跑，完成再广播刷新。
      void this.collectInBackground(source)
      return source
    })
    this.handle(IPC.sourceRemove, (id) => {
      this.store.saveSources(this.store.listSources().filter((s) => s.id !== (id as string)))
      this.store.purgeSource(id as string)
      this.broadcast('articles-changed')
    })
    this.handle(IPC.sourceRefresh, (sourceId) => {
      void this.refreshInBackground(sourceId as string | undefined)
    })

    // —— 文章 ——
    this.handle(IPC.articleList, (opts) => {
      const followed = new Set(this.store.listSources().map((s) => s.id))
      return this.store.listArticles(opts as never).filter((a) => followed.has(a.source.id))
    })
    this.handle(IPC.articleGet, (id) => this.store.getArticle(id as string))
    this.handle(IPC.articleMarkRead, (id, read) => this.store.setRead(id as string, read as boolean))
    this.handle(IPC.articleArchive, (id) => this.store.setArchived(id as string, true))
    this.handle(IPC.articleUnreadCounts, () => this.store.unreadCounts())
  }

  stop(): void {
    if (this.stopped) return
    this.stopped = true
    // 无定时器；关闭 SQLite 连接，确保文件/索引写入完成。
    this.store.close()
  }
}
