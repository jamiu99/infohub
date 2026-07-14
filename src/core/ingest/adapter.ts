// 统一采集接口。每种信源 = 一个 SourceAdapter，实现同一契约。
// 加新信源 = 加一个 adapter，collector / store / process 都不动。见 docs/ingest.md。
import type {
  Source,
  RawItem,
  DiscoverResult,
  ArticleContentStatus
} from '../../shared/contract'

export type { DiscoverResult }

/** 一次采集的产物 */
export interface FetchOutcome {
  items: RawItem[]
  /** 采集是否受阻（账号失效/限流等），供 collector 决定重试/提示 */
  status: 'ok' | 'no_account' | 'rate_limited' | 'auth_expired' | 'error'
  message?: string
}

/** 文章详情页的结构化补全结果；完整页面只在本机 raw/ 留档。 */
export interface EnrichedArticleContent {
  body: string
  contentHtml?: string
  pageHtml?: string
  status: ArticleContentStatus
  parserVersion: number
  error?: { code: string; message: string }
}

/**
 * 信源适配器。每种信源实现它。
 * - 有的 adapter 需要鉴权/配额（wechat：内部持有账号池 + 限流）
 * - 有的无需鉴权（rss：公开抓取）
 * 这些差异【封装在 adapter 内部】，collector 只面向此接口，不关心细节。
 */
export interface SourceAdapter {
  /** 信源类型标识，与 Source.type 对应 */
  readonly type: string

  /** 是否支持搜索发现（wechat 支持按名搜；rss 一般直接给 URL，不支持） */
  discover?(query: string): Promise<DiscoverResult[]>

  /** 拉取一个源的原始条目（增量）。adapter 内部处理鉴权/限流/分页。 */
  fetch(source: Source, opts?: { maxPages?: number }): Promise<FetchOutcome>

  /**
   * 采集就绪状态：collector 采集前可查询。
   * 如 wechat 无可用账号时返回 not_ready，UI 提示登录。
   */
  readiness?(): { ready: boolean; reason?: string }

  /** 当前正文解析器版本；版本升级后允许手动刷新重跑旧产物。 */
  contentParserVersion?: number

  /**
   * 可选：补全 Markdown、可展示正文 HTML 和完整页面快照。
   * 返回 failed 也可以携带 pageHtml，供以后离线重新解析。
   */
  enrichContent?(sourceUrl: string): Promise<EnrichedArticleContent>

}

/** adapter 注册表：按 type 找 adapter */
export class AdapterRegistry {
  private map = new Map<string, SourceAdapter>()

  register(adapter: SourceAdapter): void {
    this.map.set(adapter.type, adapter)
  }

  get(type: string): SourceAdapter | undefined {
    return this.map.get(type)
  }

  has(type: string): boolean {
    return this.map.has(type)
  }

  types(): string[] {
    return [...this.map.keys()]
  }
}
