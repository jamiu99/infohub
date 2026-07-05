// 主服务：装配 store / 账号池 / collector / poller，注册 IPC，管理定时轮询。
import { ipcMain, BrowserWindow, app } from 'electron'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { makePaths } from '../core/paths'
import { Store } from '../core/store'
import { AccountPool } from '../core/agent/account-pool'
import { Collector } from '../core/agent/collector'
import { Poller } from '../core/agent/poller'
import { IPC } from '../shared/ipc'
import type { IngestProgress } from '../shared/ipc'
import type { Source } from '../shared/contract'
import type { WxSearchResult } from '../shared/wechat'
import { saveAccounts, loadAccounts } from './secrets'
import { openWechatLogin, makeAccount } from './wechat-login'

const AUTO_POLL_INTERVAL_MS = 3 * 60 * 60 * 1000 // 每 3 小时自动轮询一轮

export class Service {
  private store: Store
  private pool: AccountPool
  private collector: Collector
  private poller: Poller
  private paths = makePaths(join(app.getPath('userData'), 'data'))
  private pollTimer?: NodeJS.Timeout
  private nextRunAt?: number

  constructor() {
    this.store = new Store(this.paths)
    this.pool = new AccountPool(loadAccounts(this.paths.wxAccounts), {
      persist: (a) => saveAccounts(this.paths.wxAccounts, a),
      onChange: () => this.broadcast('accounts-changed')
    })
    this.collector = new Collector(this.pool, this.store)
    this.poller = new Poller(this.collector, this.pool, {
      onProgress: (p) => this.broadcast('ingest-progress', p)
    })
  }

  private broadcast(channel: string, ...args: unknown[]): void {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, ...args)
  }

  start(): void {
    this.registerIpc()
    this.scheduleAutoPoll()
  }

  private scheduleAutoPoll(): void {
    this.nextRunAt = Date.now() + AUTO_POLL_INTERVAL_MS
    this.pollTimer = setInterval(() => void this.runPoll(), AUTO_POLL_INTERVAL_MS)
  }

  private async runPoll(): Promise<void> {
    this.nextRunAt = Date.now() + AUTO_POLL_INTERVAL_MS
    const r = await this.poller.runOnce(this.store.listSources(), this.nextRunAt)
    if (r.total > 0) this.broadcast('articles-changed')
  }

  private registerIpc(): void {
    // —— 账号 ——
    ipcMain.handle(IPC.accountList, () => this.pool.views())
    ipcMain.handle(IPC.accountLogin, async () => {
      const id = randomUUID().slice(0, 8)
      const partition = `persist:wx-${id}`
      const r = await openWechatLogin(partition)
      this.pool.add(makeAccount(id, partition, r, Date.now()))
      return this.pool.views().find((v) => v.id === id)!
    })
    ipcMain.handle(IPC.accountRelogin, async (_e, accountId: string) => {
      const acc = this.pool.get(accountId)
      if (!acc) throw new Error('账号不存在')
      const r = await openWechatLogin(acc.partition)
      this.pool.refreshCredentials(accountId, { token: r.token, cookies: r.cookies, nickname: r.nickname })
      return this.pool.views().find((v) => v.id === accountId)!
    })
    ipcMain.handle(IPC.accountRemove, (_e, id: string) => this.pool.remove(id))

    // —— 信源 ——
    ipcMain.handle(IPC.sourceList, () => this.store.listSources())
    ipcMain.handle(IPC.sourceSearch, (_e, q: string) => this.collector.search(q))
    ipcMain.handle(IPC.sourceAdd, async (_e, result: WxSearchResult) => {
      const sources = this.store.listSources()
      const source: Source = {
        id: `wx-${result.fakeid}`,
        type: 'wechat',
        name: result.nickname,
        enabled: true,
        config: { fakeid: result.fakeid, alias: result.alias, signature: result.signature }
      }
      if (!sources.find((s) => s.id === source.id)) {
        sources.push(source)
        this.store.saveSources(sources)
      }
      // 立即抓一次
      const r = await this.collector.collectSource(source)
      if (r.newArticles > 0) this.broadcast('articles-changed')
      return source
    })
    ipcMain.handle(IPC.sourceRemove, (_e, id: string) => {
      this.store.saveSources(this.store.listSources().filter((s) => s.id !== id))
    })
    ipcMain.handle(IPC.sourceRefresh, async (_e, sourceId?: string) => {
      const sources = this.store.listSources()
      const targets = sourceId ? sources.filter((s) => s.id === sourceId) : sources
      let total = 0
      for (const s of targets) {
        const r = await this.collector.collectSource(s)
        total += r.newArticles
      }
      if (total > 0) this.broadcast('articles-changed')
    })

    // —— 文章 ——
    ipcMain.handle(IPC.articleList, (_e, opts) => this.store.listArticles(opts))
    ipcMain.handle(IPC.articleGet, (_e, id: string) => this.store.getArticle(id))
    ipcMain.handle(IPC.articleMarkRead, (_e, id: string, read: boolean) => this.store.setRead(id, read))
    ipcMain.handle(IPC.articleArchive, (_e, id: string) => this.store.setArchived(id, true))
    ipcMain.handle(IPC.articleUnreadCounts, () => this.store.unreadCounts())
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer)
  }
}
