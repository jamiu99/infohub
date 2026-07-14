// 微信公众号 adapter：把 wechat 接口 + 账号池 + 限流封装成统一 SourceAdapter。
// 账号池/限流/换号重试这些 wechat 专属逻辑都收在这里，collector 不再关心。
import type { Source, RawItem } from '../../shared/contract'
import type { SourceAdapter, DiscoverResult, FetchOutcome } from './adapter'
import type { AccountPool } from '../collect/account-pool'
import { RATE_LIMIT } from '../collect/rate-limit'
import { searchBiz, listArticlesPage, toRawItem } from './wechat'
import { fetchArticleContent, WECHAT_CONTENT_PARSER_VERSION } from '../process/content'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export class WechatAdapter implements SourceAdapter {
  readonly type = 'wechat'
  readonly contentParserVersion = WECHAT_CONTENT_PARSER_VERSION

  private wait: (ms: number) => Promise<void>
  constructor(
    private pool: AccountPool,
    opts: { sleep?: (ms: number) => Promise<void> } = {}
  ) {
    this.wait = opts.sleep ?? sleep
  }

  readiness(): { ready: boolean; reason?: string } {
    return this.pool.pick()
      ? { ready: true }
      : { ready: false, reason: '无可用账号（未登录或全部限流/失效）' }
  }

  /** 公众号列表只给摘要；详情页同时保留 page HTML、正文 HTML 和 Markdown。 */
  enrichContent(sourceUrl: string) {
    return fetchArticleContent(sourceUrl)
  }

  /** 搜公众号（换号重试） */
  async discover(query: string): Promise<DiscoverResult[]> {
    for (let attempt = 0; attempt < 3; attempt++) {
      const account = this.pool.pick()
      if (!account) return []
      const r = await searchBiz(account, query)
      this.pool.noteRequest(account.id)
      if (r.ok) {
        return r.data.map((it) => ({
          config: { fakeid: it.fakeid, alias: it.alias, signature: it.signature },
          name: it.nickname,
          meta: { roundHeadImg: it.roundHeadImg, signature: it.signature, alias: it.alias }
        }))
      }
      const { retry } = this.pool.handleResult(account.id, r)
      if (!retry) return []
      await this.wait(RATE_LIMIT.accountIntervalMs)
    }
    return []
  }

  /** 增量拉取：翻页直到达上限或页空。账号池/限流/换号都在内部处理。 */
  async fetch(source: Source, opts: { maxPages?: number } = {}): Promise<FetchOutcome> {
    const fakeid = (source.config as { fakeid?: string }).fakeid
    if (!fakeid) return { items: [], status: 'error', message: '缺少 fakeid' }

    const maxPages = opts.maxPages ?? RATE_LIMIT.incrementalMaxPages
    const items: RawItem[] = []

    for (let page = 0; page < maxPages; page++) {
      const account = this.pool.pick()
      if (!account) return { items, status: 'no_account' }

      const begin = page * RATE_LIMIT.pageSize
      const r = await listArticlesPage(account, fakeid, begin, RATE_LIMIT.pageSize)
      this.pool.noteRequest(account.id)

      if (!r.ok) {
        const { retry } = this.pool.handleResult(account.id, r)
        if (retry) {
          page-- // 换号重试本页
          await this.wait(RATE_LIMIT.accountIntervalMs)
          continue
        }
        const status = r.reason === 'freq_control' ? 'rate_limited' : r.reason === 'expired' ? 'auth_expired' : 'error'
        return { items, status, message: r.message }
      }

      if (r.data.items.length === 0) break
      for (const it of r.data.items) {
        const raw = toRawItem(source.id, it)
        if (raw.externalId) items.push(raw)
      }
      if (r.data.items.length < RATE_LIMIT.pageSize) break
      await this.wait(RATE_LIMIT.requestIntervalMs) // 同账号翻页间隔
    }
    return { items, status: 'ok' }
  }
}
