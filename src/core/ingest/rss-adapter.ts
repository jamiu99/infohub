// RSS adapter：公开抓取，无需账号/限流。config.feedUrl 指向 feed 地址。
import type { Source } from '../../shared/contract'
import type { SourceAdapter, DiscoverResult, FetchOutcome } from './adapter'
import { fetchFeed, entryToRawItem } from './rss'

export class RssAdapter implements SourceAdapter {
  readonly type = 'rss'

  constructor(private opts: { fetchImpl?: typeof fetch } = {}) {}

  /** RSS 没有搜索，但支持"给一个 feed URL 试探"，返回该 feed 作为唯一候选。 */
  async discover(query: string): Promise<DiscoverResult[]> {
    const url = query.trim()
    if (!/^https?:\/\//i.test(url)) return [] // 只接受 URL
    const feed = await fetchFeed(url, this.opts.fetchImpl)
    if (!feed) return []
    return [{ config: { feedUrl: url }, name: feed.title, meta: { entries: feed.entries.length } }]
  }

  async fetch(source: Source): Promise<FetchOutcome> {
    const feedUrl = (source.config as { feedUrl?: string }).feedUrl
    if (!feedUrl) return { items: [], status: 'error', message: '缺少 feedUrl' }
    const feed = await fetchFeed(feedUrl, this.opts.fetchImpl)
    if (!feed) return { items: [], status: 'error', message: 'feed 拉取/解析失败' }
    return { items: feed.entries.map((e) => entryToRawItem(source.id, e)), status: 'ok' }
  }
  // RSS entry 的 content/summary 已在 normalizer 里用作正文，无需详情补抓。
}
