// 采集编排器：面向 SourceAdapter 接口，与具体信源解耦。见 docs/ingest.md。
// 本模块只负责任务串行化与数据管线，不包含任何模型或 AI 能力。
// 通用流程：adapter.fetch → 去重 → normalizer 归一化 → adapter.enrichBody 补正文 → store。
// 信源专属逻辑（wechat 账号池/限流、rss 解析）都在各自 adapter 里，这里不感知。
import type { Source } from '../../shared/contract'
import type { AdapterRegistry, DiscoverResult } from '../ingest/adapter'
import { getNormalizer } from '../process/normalize'
import type { Store } from '../store'

export interface CollectResult {
  sourceId: string
  newArticles: number
  status: 'ok' | 'no_account' | 'rate_limited' | 'auth_expired' | 'error'
  message?: string
}

export class Collector {
  // 全局串行锁（安全约束）：任何时刻只允许一个采集链在跑，杜绝并发打爆账号。
  private chain: Promise<unknown> = Promise.resolve()

  constructor(
    private registry: AdapterRegistry,
    private store: Store
  ) {}

  /** 把任务排到串行链尾，保证全局互斥执行 */
  private runExclusive<T>(task: () => Promise<T>): Promise<T> {
    const run = this.chain.then(task, task)
    this.chain = run.then(
      () => undefined,
      () => undefined
    )
    return run
  }

  /** 搜索发现（按 type 分派给支持 discover 的 adapter）。全局串行。 */
  discover(type: string, query: string): Promise<DiscoverResult[]> {
    return this.runExclusive(async () => {
      const adapter = this.registry.get(type)
      if (!adapter?.discover) return []
      return adapter.discover(query)
    })
  }

  /** 增量采集单个源（全局串行入口） */
  collectSource(source: Source, maxPages?: number): Promise<CollectResult> {
    return this.runExclusive(() => this.collectSourceImpl(source, maxPages))
  }

  private async collectSourceImpl(source: Source, maxPages?: number): Promise<CollectResult> {
    const adapter = this.registry.get(source.type)
    if (!adapter) {
      return { sourceId: source.id, newArticles: 0, status: 'error', message: `无 ${source.type} adapter` }
    }
    const normalize = getNormalizer(source.type)
    if (!normalize) {
      return { sourceId: source.id, newArticles: 0, status: 'error', message: `无 ${source.type} normalizer` }
    }

    // 1. adapter 拉原始条目（内部处理鉴权/限流/分页）
    const outcome = await adapter.fetch(source, { maxPages })

    // 2. 去重 + 归一化 + 补正文 + 入库
    let newCount = 0
    for (const raw of outcome.items) {
      if (!raw.externalId || this.store.isSeen(source.id, raw.externalId)) continue
      this.store.saveRaw(raw)
      const article = normalize(raw, source)
      // 正文补全（adapter 可选实现；wechat 抓原文页，rss 通常 entry 自带无需抓）
      if (!article.body && adapter.enrichBody && article.sourceUrl) {
        const body = await adapter.enrichBody(article.sourceUrl)
        if (body) article.body = body
      }
      this.store.saveArticle(article)
      newCount++
    }

    return { sourceId: source.id, newArticles: newCount, status: outcome.status, message: outcome.message }
  }
}
