// 采集编排器：面向 SourceAdapter 接口，与具体信源解耦。见 docs/ingest.md。
// 本模块只负责任务串行化与数据管线，不包含任何模型或 AI 能力。
// 通用流程：adapter.fetch → 去重 → normalizer → adapter.enrichContent → store。
// 信源专属逻辑（wechat 账号池/限流、rss 解析）都在各自 adapter 里，这里不感知。
import type { Article, Source } from '../../shared/contract'
import type {
  AdapterRegistry,
  DiscoverResult,
  EnrichedArticleContent,
  SourceAdapter
} from '../ingest/adapter'
import { getNormalizer } from '../process/normalize'
import type { ArticleArtifacts, Store } from '../store'

export interface CollectResult {
  sourceId: string
  newArticles: number
  /** 已存在文章本次补齐或升级了正文产物。 */
  updatedArticles: number
  status: 'ok' | 'no_account' | 'rate_limited' | 'auth_expired' | 'error'
  message?: string
}

interface ArticleEnrichment {
  article: Article
  artifacts: ArticleArtifacts
  attempted: boolean
  improved: boolean
}

export class Collector {
  // 全局串行锁（安全约束）：任何时刻只允许一个采集链在跑，杜绝并发打爆账号。
  private chain: Promise<unknown> = Promise.resolve()

  constructor(
    private registry: AdapterRegistry,
    private store: Store,
    private onLocalArticle?: (source: Source, article: ReturnType<Store['saveArticle']>) => void
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
      return {
        sourceId: source.id,
        newArticles: 0,
        updatedArticles: 0,
        status: 'error',
        message: `无 ${source.type} adapter`
      }
    }
    const normalize = getNormalizer(source.type)
    if (!normalize) {
      return {
        sourceId: source.id,
        newArticles: 0,
        updatedArticles: 0,
        status: 'error',
        message: `无 ${source.type} normalizer`
      }
    }

    // 1. adapter 拉原始条目（内部处理鉴权/限流/分页）
    const outcome = await adapter.fetch(source, { maxPages })

    // 2. 去重 + 归一化 + 补正文 + 入库
    let newCount = 0
    let updatedCount = 0
    for (const raw of outcome.items) {
      if (!raw.externalId) continue

      if (this.store.isSeen(source.id, raw.externalId)) {
        const existing = this.store.findArticleByExternalId(source.id, raw.externalId)
        if (!existing) continue

        // seen 只代表列表条目已入库；正文失败、缺 HTML 或解析器版本旧时仍需补抓。
        const enrichment = await this.enrichArticle(adapter, existing)
        // 文章可能先从团队同步到本地；本机真实采到时必须补记本机贡献并上传。
        const contributedNow = existing.team?.contributedByMe === false
        if (enrichment.attempted || contributedNow) {
          const next: Article = {
            ...enrichment.article,
            ...(contributedNow
              ? {
                  team: {
                    ...existing.team!,
                    contributedByMe: true,
                    detachedFromLocalSource: false
                  }
                }
              : {}),
            updatedAt:
              enrichment.improved || contributedNow ? Date.now() : existing.updatedAt
          }
          const saved = this.store.saveArticle(next, enrichment.artifacts)
          if (enrichment.improved || contributedNow) this.notifyLocalArticle(source, saved)
          if (enrichment.improved) updatedCount++
          if (contributedNow) newCount++
        }
        continue
      }

      this.store.saveRaw(raw)
      const article = normalize(raw, source)
      const enrichment = await this.enrichArticle(adapter, article)
      const saved = this.store.saveArticle(enrichment.article, enrichment.artifacts)
      this.notifyLocalArticle(source, saved)
      newCount++
    }

    return {
      sourceId: source.id,
      newArticles: newCount,
      updatedArticles: updatedCount,
      status: outcome.status,
      message: outcome.message
    }
  }

  private needsStructuredContent(adapter: SourceAdapter, article: Article): boolean {
    if (!adapter.enrichContent || !article.sourceUrl) return false
    const targetVersion = adapter.contentParserVersion ?? 1
    const hasDisplayHtml = Boolean(
      article.content?.contentHtmlPath && this.store.getArticleDetail(article.id)?.contentHtml
    )
    const hasLocalPage =
      article.source.type !== 'wechat' || this.store.hasArticlePageHtml(article)
    return (
      !article.content ||
      article.content.status !== 'complete' ||
      article.content.parserVersion < targetVersion ||
      !hasDisplayHtml ||
      !hasLocalPage
    )
  }

  private async enrichArticle(adapter: SourceAdapter, article: Article): Promise<ArticleEnrichment> {
    if (this.needsStructuredContent(adapter, article)) {
      const result = await adapter.enrichContent!(article.sourceUrl)
      return this.mergeStructuredContent(
        article,
        result,
        this.store.hasArticlePageHtml(article)
      )
    }

    return { article, artifacts: {}, attempted: false, improved: false }
  }

  private mergeStructuredContent(
    article: Article,
    result: EnrichedArticleContent,
    hadLocalPage: boolean
  ): ArticleEnrichment {
    const now = Date.now()
    const previous = article.content
    const hasDisplayHtml = Boolean(result.contentHtml)
    const previousContentHtml = previous?.contentHtmlPath
      ? this.store.getArticleDetail(article.id)?.contentHtml
      : undefined
    const hadDisplayHtml = Boolean(previousContentHtml)
    const complete = result.status === 'complete' && hasDisplayHtml
    // 新抓取失败不能覆盖一份已经可用的正文，只记录最近失败供下次刷新重试。
    const preserveExistingComplete =
      previous?.status === 'complete' && hadDisplayHtml && !complete
    const skipFailedPageForCompleteContent = preserveExistingComplete && hadLocalPage

    const content = preserveExistingComplete
      ? {
          ...previous,
          lastAttemptAt: now,
          error: result.error
        }
      : {
          ...previous,
          status: result.status,
          parserVersion: result.parserVersion,
          lastAttemptAt: now,
          ...(hasDisplayHtml ? { lastSuccessAt: now } : {}),
          error: result.error
        }

    const nextBody = preserveExistingComplete ? article.body : result.body || article.body
    const nextContentHtml = preserveExistingComplete ? undefined : result.contentHtml
    const improved =
      !preserveExistingComplete &&
      hasDisplayHtml &&
      (!hadDisplayHtml ||
        previous?.status !== 'complete' ||
        (previous?.parserVersion ?? 0) < result.parserVersion ||
        result.contentHtml !== previousContentHtml ||
        nextBody !== article.body)

    return {
      article: { ...article, body: nextBody, content },
      artifacts: {
        ...(nextContentHtml ? { contentHtml: nextContentHtml } : {}),
        ...(result.pageHtml !== undefined && !skipFailedPageForCompleteContent
          ? { pageHtml: result.pageHtml }
          : {})
      },
      attempted: true,
      improved
    }
  }

  private notifyLocalArticle(source: Source, article: ReturnType<Store['saveArticle']>): void {
    try {
      this.onLocalArticle?.(source, article)
    } catch (error) {
      // outbox 写入失败不能回滚已完成的本地采集；保留文章并记录错误供排查。
      console.error('团队同步队列写入失败:', error)
    }
  }
}
