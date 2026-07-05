// 采集编排器：串起 账号池 → ingest → process → store，含多账号轮换与限流延时。
// 见 docs/wechat-monitor.md#四轮询与调度。
import type { Source } from '../../shared/contract'
import type { WxSearchResult } from '../../shared/wechat'
import { searchBiz, listArticlesPage, toRawItem } from '../ingest/wechat'
import { normalizeWechat } from '../process/wechat'
import { fetchArticleBody } from '../process/content'
import type { AccountPool } from './account-pool'
import type { Store } from '../store'
import { RATE_LIMIT } from './rate-limit'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export interface CollectResult {
  sourceId: string
  newArticles: number
  status: 'ok' | 'no_account' | 'error'
  message?: string
}

export class Collector {
  private wait: (ms: number) => Promise<void>
  // 全局串行锁（安全约束）：任何时刻只允许一个 wechat 请求链在跑，杜绝并发打爆账号。
  // 所有对外入口都经 runExclusive 排队，即使 UI 连点也不会并发。
  private chain: Promise<unknown> = Promise.resolve()

  constructor(
    private pool: AccountPool,
    private store: Store,
    opts: { sleep?: (ms: number) => Promise<void> } = {}
  ) {
    this.wait = opts.sleep ?? sleep
  }

  /** 把任务排到串行链尾，保证全局互斥执行 */
  private runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task, task)
    // 无论成功失败都让链继续（吞掉错误只为解锁，不影响 run 的真实结果）
    this.chain = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  /** 搜索公众号（吃一次配额，自动换号重试）。全局串行。 */
  search(query: string): Promise<WxSearchResult[]> {
    return this.runExclusive(async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const account = this.pool.pick()
        if (!account) return []
        const r = await searchBiz(account, query)
        this.pool.noteRequest(account.id)
        if (r.ok) return r.data
        const { retry } = this.pool.handleResult(account.id, r)
        if (!retry) return []
        await this.wait(RATE_LIMIT.accountIntervalMs)
      }
      return []
    })
  }

  /** 增量抓取单个公众号（全局串行入口） */
  collectSource(source: Source, maxPages = RATE_LIMIT.incrementalMaxPages): Promise<CollectResult> {
    return this.runExclusive(() => this.collectSourceImpl(source, maxPages))
  }

  private async collectSourceImpl(source: Source, maxPages: number): Promise<CollectResult> {
    const fakeid = (source.config as { fakeid?: string }).fakeid
    if (!fakeid) return { sourceId: source.id, newArticles: 0, status: 'error', message: '缺少 fakeid' }

    let newCount = 0
    for (let page = 0; page < maxPages; page++) {
      const account = this.pool.pick()
      if (!account) return { sourceId: source.id, newArticles: newCount, status: 'no_account' }

      const begin = page * RATE_LIMIT.pageSize
      const r = await listArticlesPage(account, fakeid, begin, RATE_LIMIT.pageSize)
      this.pool.noteRequest(account.id)

      if (!r.ok) {
        const { retry } = this.pool.handleResult(account.id, r)
        if (retry) {
          page-- // 该页换号重试
          await this.wait(RATE_LIMIT.accountIntervalMs)
          continue
        }
        return { sourceId: source.id, newArticles: newCount, status: 'error', message: r.message }
      }

      if (r.data.items.length === 0) break

      let hitSeen = false
      for (const item of r.data.items) {
        const raw = toRawItem(source.id, item)
        if (!raw.externalId) continue
        if (this.store.isSeen(source.id, raw.externalId)) {
          hitSeen = true // 增量：碰到已见即可停（列表按时间倒序）
          continue
        }
        this.store.saveRaw(raw)
        const article = normalizeWechat(raw, source)
        // 阶段2：抓正文页转 markdown（公开页，无需登录态；失败不阻塞入库）
        const body = await fetchArticleBody(article.sourceUrl)
        if (body) article.body = body
        const saved = this.store.saveArticle(article)
        this.store.markSeen(source.id, raw.externalId, saved.id)
        newCount++
      }
      if (hitSeen) break

      await this.wait(RATE_LIMIT.requestIntervalMs) // 同账号翻页间隔
    }
    return { sourceId: source.id, newArticles: newCount, status: 'ok' }
  }
}
