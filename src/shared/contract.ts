// 数据契约 —— 模块解耦的"接头暗号"。改字段务必同步 docs/contract.md。
// 所有时间统一 UTC 毫秒时间戳（存 UTC，展示本地时区）。
import type { TeamArticleOrigin } from './team'

/** 信源定义 */
export interface Source {
  id: string
  type: 'wechat' | 'rss' | (string & {}) // 可拓展：未来 adapter 自定义 type
  name: string
  enabled: boolean
  config: Record<string, unknown> // wechat: { fakeid }; rss: { feedUrl }
  lastFetchedAt?: number
}

/** 信源发现候选（搜索公众号 / 试探 RSS feed 的结果），跨进程传给 UI */
export interface DiscoverResult {
  config: Record<string, unknown> // 建 Source 用（wechat: fakeid; rss: feedUrl）
  name: string
  meta?: Record<string, unknown> // 展示用（头像/签名/条目数）
}

/** 原始采集产物（未清洗），ingest 层唯一输出 */
export interface RawItem {
  sourceId: string
  sourceType: string
  fetchedAt: number
  externalId: string // 信源内唯一 id（wechat: link；rss: guid）→ 去重键
  raw: Record<string, unknown> // 原始字段整包
}

export type Staleness = 'fresh' | 'aging' | 'stale'

/** 统一结构 —— 系统核心数据结构，所有信源归一到它 */
export interface Article {
  id: string
  externalId: string // 信源内去重键；写入文件，保证 seen_items 可重建
  title: string
  body: string // markdown 正文
  publishedAt: number
  sourceUrl: string
  source: { id: string; type: string; name: string }

  // 兼容旧文件/外部工具的可选注释；infohub 本身不生成这些字段
  summary?: string
  score?: number
  staleness?: Staleness
  provenance?: { verified: boolean; note?: string }
  tags?: string[]

  // 可拓展字段：不同信源特色元数据
  ext: Record<string, unknown>

  /** 团队同步来源；旧文件无此字段时视为本机历史数据。 */
  team?: TeamArticleOrigin

  // 存储/状态元信息
  filePath?: string
  read?: boolean
  archived?: boolean
  createdAt: number
  updatedAt: number
}
