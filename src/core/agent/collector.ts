// 采集编排器：串起 账号池 → ingest → process → store，含多账号轮换与限流延时。
// 见 docs/wechat-monitor.md#四轮询与调度。
import type { Source } from '../../shared/contract'
import type { WxSearchResult } from '../../shared/wechat'
import { searchBiz, listArticlesPage, toRawItem } from '../ingest/wechat'
import { normalizeWechat } from '../process/wechat'
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
  constructor(
    private pool: AccountPool,
    private store: Store,
    opts: { sleep?: (ms: number) => Promise<void> } = {}
  ) {
    this.wait = opts.sleep ?? sleep
  }

  /** 搜索公众号（吃一次配额，自动换号重试） */
  async search(query: string): Promise<WxSearchResult[]> {
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
  }

  /** 增量抓取单个公众号：翻页直到遇到已见文章或达页数上限 */
  async collectSource(source: Source, maxPages = RATE_LIMIT.incrementalMaxPages): Promise<CollectResult> {
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
