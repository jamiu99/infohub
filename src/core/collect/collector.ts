// 采集编排器：面向 SourceAdapter 接口，与具体信源解耦。见 docs/ingest.md。
// 本模块只负责任务串行化与数据管线，不包含任何模型或 AI 能力。
// 通用流程：adapter.fetch → 去重 → normalizer → adapter.enrichContent → store。
// 信源专属逻辑（wechat 账号池/限流、rss 解析）都在各自 adapter 里，这里不感知。
import type { Article, ArticleContentState, Source } from '../../shared/contract'
import type {
  AdapterRegistry,
  DiscoverResult,
  EnrichedArticleContent,
  SourceAdapter
} from '../ingest/adapter'
import { getNormalizer } from '../process/normalize'
import type { ArticleArtifacts, Store } from '../store'
import type {
  ArticleMaintenanceItemResult,
  ArticleMaintenanceMode
} from '../../shared/maintenance'

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

interface ContentMergeContext {
  origin: 'network' | 'offline'
  /** 离线解析实际读取的不可变快照；成功时提升为当前投影依据。 */
  replayPagePath?: string
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

  /** 等待已经进入串行链的任务完成；退出/迁移资料库前使用。 */
  drain(): Promise<void> {
    return this.chain.then(() => undefined)
  }

  /**
   * 强制重建单篇正文。offline 只读本机 page 快照，network 才重新请求公开文章页。
   * 只有 network 更新最近请求状态；offline 只重建投影，失败不会覆盖既有完整正文。
   */
  reprocessArticle(article: Article, mode: ArticleMaintenanceMode): Promise<ArticleMaintenanceItemResult> {
    return this.runExclusive(() => this.reprocessArticleImpl(article, mode))
  }

  private async reprocessArticleImpl(
    article: Article,
    mode: ArticleMaintenanceMode
  ): Promise<ArticleMaintenanceItemResult> {
    // Service 的批量枚举可能已经持续了一段时间；开始单篇处理时先重读，避免拿旧 URL/
    // team 状态发请求。网络返回后还会再重读一次，保护期间发生的阅读/归档/团队更新。
    const current = this.store.getArticle(article.id)
    const base = { articleId: article.id, title: current?.title ?? article.title }
    if (!current) {
      return { ...base, status: 'skipped', message: '文章已被删除，不再重新处理' }
    }
    if (current.team?.contributedByMe === false) {
      return { ...base, status: 'skipped', message: '仅来自团队的文章不会由本机重新抓取' }
    }
    const adapter = this.registry.get(current.source.type)
    if (!adapter || !current.sourceUrl) {
      return { ...base, status: 'skipped', message: '该文章没有可用的正文适配器或原文地址' }
    }

    let result: EnrichedArticleContent
    let replayPagePath: string | undefined
    if (mode === 'offline') {
      if (!adapter.parseContentPage) {
        return { ...base, status: 'skipped', message: '该信源不支持离线重新解析' }
      }
      const replay = this.store.getArticleReplayPage(article.id)
      if (!replay) {
        return { ...base, status: 'skipped', message: '本机没有可用于重放的原始页面快照' }
      }
      replayPagePath = replay.path
      result = adapter.parseContentPage(replay.pageHtml, current.sourceUrl)
    } else {
      if (!adapter.enrichContent) {
        return { ...base, status: 'skipped', message: '该信源不支持联网重新抓取正文' }
      }
      result = await adapter.enrichContent(current.sourceUrl)
    }

    const latest = this.store.getArticle(article.id)
    if (!latest) {
      return { ...base, status: 'skipped', message: '处理期间文章已被删除，结果未写入' }
    }
    if (latest.team?.contributedByMe === false) {
      return { ...base, status: 'skipped', message: '处理期间文章已变为团队副本，结果未写入' }
    }
    const enrichment = this.mergeStructuredContent(latest, result, {
      origin: mode,
      ...(replayPagePath ? { replayPagePath } : {})
    })
    const next: Article = {
      ...enrichment.article,
      updatedAt: enrichment.improved ? Date.now() : latest.updatedAt
    }
    const saved = this.store.saveArticle(next, enrichment.artifacts)
    if (enrichment.improved) {
      const source = this.store.listSources().find((item) => item.id === saved.source.id)
      if (source) this.notifyLocalArticle(source, saved)
      return { ...base, status: 'updated' }
    }
    if (result.status === 'failed' || result.status === 'partial') {
      return {
        ...base,
        status: 'failed',
        message: result.error?.message ?? '本次没有取得完整正文，已保留原有可用内容'
      }
    }
    return { ...base, status: 'unchanged', message: '重新处理完成，正文内容没有变化' }
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

      // Raw 是不可变证据层，不是“仅首次入库”的缓存。即使文章已经 seen，
      // 列表接口后来返回的不同载荷也应先按内容寻址留档，再决定是否更新 Article 投影。
      this.store.saveRaw(raw)

      if (this.store.isSeen(source.id, raw.externalId)) {
        const existing = this.store.findArticleByExternalId(source.id, raw.externalId)
        if (!existing) continue

        // seen 只代表列表条目已入库；正文失败、缺 HTML 或解析器版本旧时仍需补抓。
        const enrichment = await this.enrichArticle(adapter, existing, true)
        if (!enrichment) continue
        // 取消订阅期间返回的迟到网络结果不能把团队保留副本重新变成“我的”；真正重新订阅时
        // Source 已重新写回 sources.json，下面仍会正常恢复本机贡献。
        if (
          enrichment.article.team?.detachedFromLocalSource === true &&
          !this.store.listSources().some((item) => item.id === source.id && item.enabled)
        ) {
          continue
        }
        // 文章可能先从团队同步到本地；本机真实采到时必须补记本机贡献并上传。
        const contributedNow = enrichment.article.team?.contributedByMe === false
        if (enrichment.attempted || contributedNow) {
          const next: Article = {
            ...enrichment.article,
            ...(contributedNow
              ? {
                  team: {
                    ...enrichment.article.team!,
                    contributedByMe: true,
                    detachedFromLocalSource: false
                  }
                }
              : {}),
            updatedAt:
              enrichment.improved || contributedNow
                ? Date.now()
                : enrichment.article.updatedAt
          }
          const saved = this.store.saveArticle(next, enrichment.artifacts)
          if (enrichment.improved || contributedNow) this.notifyLocalArticle(source, saved)
          if (enrichment.improved) updatedCount++
          if (contributedNow) newCount++
        }
        continue
      }

      const article = normalize(raw, source)
      const enrichment = await this.enrichArticle(adapter, article)
      if (!enrichment) continue
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

  private async enrichArticle(
    adapter: SourceAdapter,
    article: Article,
    persisted = false
  ): Promise<ArticleEnrichment | null> {
    if (this.needsStructuredContent(adapter, article)) {
      const result = await adapter.enrichContent!(article.sourceUrl)
      const latest = persisted ? this.store.getArticle(article.id) : article
      return latest
        ? this.mergeStructuredContent(latest, result, { origin: 'network' })
        : null
    }

    const latest = persisted ? this.store.getArticle(article.id) : article
    return latest
      ? { article: latest, artifacts: {}, attempted: false, improved: false }
      : null
  }

  private mergeStructuredContent(
    article: Article,
    result: EnrichedArticleContent,
    context: ContentMergeContext
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
    const lastAttemptAt = context.origin === 'network' ? now : (previous?.lastAttemptAt ?? now)

    const content: ArticleContentState = preserveExistingComplete
      ? {
          ...previous!,
          lastAttemptAt,
          error: context.origin === 'network' ? result.error : previous?.error
        }
      : {
          ...previous,
          status: result.status,
          parserVersion: result.parserVersion,
          lastAttemptAt,
          ...(complete ? { lastSuccessAt: now } : {}),
          ...(context.origin === 'offline' && complete && context.replayPagePath
            ? { pageHtmlPath: context.replayPagePath }
            : {}),
          error: context.origin === 'network' ? result.error : previous?.error
        }

    const nextBody = preserveExistingComplete ? article.body : result.body || article.body
    const nextContentHtml = preserveExistingComplete ? undefined : result.contentHtml
    const improved =
      !preserveExistingComplete &&
      complete &&
      (!hadDisplayHtml ||
        previous?.status !== 'complete' ||
        (previous?.parserVersion ?? 0) < result.parserVersion ||
        result.contentHtml !== previousContentHtml ||
        nextBody !== article.body)

    return {
      article: { ...article, body: nextBody, content },
      artifacts: {
        ...(nextContentHtml ? { contentHtml: nextContentHtml } : {}),
        ...(context.origin === 'network' && result.pageHtml !== undefined
          ? {
              pageHtml: result.pageHtml,
              // 只有完整解析才能替换成功页面；失败/partial 永远只追加诊断快照。
              promotePageHtml: complete
            }
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
