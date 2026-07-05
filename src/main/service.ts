// 主服务：装配 store / 账号池 / collector / poller，注册 IPC。
// 安全约束（应 jamiu 要求）：默认【不】自动轮询，只在用户手动点刷新时采集，
// 且采集全局串行（见 Collector 的锁），杜绝并发请求影响真实账号。
import { ipcMain, BrowserWindow, app } from 'electron'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { makePaths } from '../core/paths'
import { Store } from '../core/store'
import { AccountPool } from '../core/agent/account-pool'
import { Collector } from '../core/agent/collector'
import { IPC } from '../shared/ipc'
import type { Source } from '../shared/contract'
import type { WxSearchResult } from '../shared/wechat'
import { saveAccounts, loadAccounts } from './secrets'
import { openWechatLogin, makeAccount } from './wechat-login'

export class Service {
  private store: Store
  private pool: AccountPool
  private collector: Collector
  private paths = makePaths(join(app.getPath('userData'), 'data'))

  constructor() {
    this.store = new Store(this.paths)
    this.pool = new AccountPool(loadAccounts(this.paths.wxAccounts), {
      persist: (a) => saveAccounts(this.paths.wxAccounts, a),
      onChange: () => this.broadcast('accounts-changed')
    })
    this.collector = new Collector(this.pool, this.store)
  }

  private broadcast(channel: string, ...args: unknown[]): void {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send(channel, ...args)
  }


  start(): void {
    this.registerIpc()
    // 注意：不启动任何自动轮询定时器。采集只由用户手动触发（source:refresh）。
  }

  private registerIpc(): void {
    // —— 账号 ——
    ipcMain.handle(IPC.accountList, () => this.pool.views())
    // 登录：开一个独立分区窗口，用户扫码登录一个号，关窗时抓取并入池。
    // 想加更多号就再点一次（各号独立分区，互不干扰）。见 wechat-login.ts。
    ipcMain.handle(IPC.accountLogin, async () => {
      const id = randomUUID().slice(0, 8)
      const partition = `persist:wx-${id}`
      const r = await openWechatLogin(partition)
      if (r) this.pool.add(makeAccount(id, partition, r, Date.now()))
      return this.pool.views()
    })
    // relogin：某账号失效时，复用其原分区重新登录刷新 token+cookie。
    ipcMain.handle(IPC.accountRelogin, async (_e, accountId: string) => {
      const acc = this.pool.get(accountId)
      if (!acc) return this.pool.views()
      const r = await openWechatLogin(acc.partition)
      if (r) this.pool.refreshCredentials(accountId, { token: r.token, cookies: r.cookies, nickname: r.nickname })
      return this.pool.views()
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
    // 无定时器需清理；采集是手动一次性的。保留方法供 main 在退出时调用。
  }
}
