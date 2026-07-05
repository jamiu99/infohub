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
import { openWechatSwitcher, makeAccount, identityKey } from './wechat-login'
import type { CapturedIdentity } from './wechat-login'

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

  /** 捕获到一个身份：按 identityKey 找已有账号则更新其 token/cookie，否则新建。 */
  private upsertCaptured(id: CapturedIdentity): void {
    const key = identityKey(id)
    const existing = this.pool.list().find((a) => a.identityKey === key)
    if (existing) {
      this.pool.refreshCredentials(existing.id, {
        token: id.token,
        cookies: id.cookies,
        nickname: id.nickname ?? existing.nickname
      })
    } else {
      const acc = makeAccount(randomUUID().slice(0, 8), id, Date.now())
      acc.identityKey = key
      this.pool.add(acc)
    }
  }

  start(): void {
    this.registerIpc()
    // 注意：不启动任何自动轮询定时器。采集只由用户手动触发（source:refresh）。
  }

  private registerIpc(): void {
    // —— 账号 ——
    ipcMain.handle(IPC.accountList, () => this.pool.views())
    // 登录/切换：只扫一次码，用户在窗口内"切换账号"切到旗下各号，
    // 每切一个自动捕获 token 入池（按 identityKey 去重/更新）。见 wechat-login.ts。
    ipcMain.handle(IPC.accountLogin, async () => {
      await openWechatSwitcher((id) => this.upsertCaptured(id))
      return this.pool.views()
    })
    // relogin：某账号 token 失效时，同样打开切换窗口刷新（切到该号即自动更新其 token）
    ipcMain.handle(IPC.accountRelogin, async () => {
      await openWechatSwitcher((id) => this.upsertCaptured(id))
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
