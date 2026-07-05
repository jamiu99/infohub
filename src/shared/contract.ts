// 数据契约 —— 模块解耦的"接头暗号"。改字段务必同步 docs/contract.md。
// 所有时间统一 UTC 毫秒时间戳（存 UTC，展示本地时区）。

/** 信源定义 */
export interface Source {
  id: string
  type: 'wechat' | 'rss' | (string & {}) // 可拓展：未来 adapter 自定义 type
  name: string
  enabled: boolean
  config: Record<string, unknown> // wechat: { fakeid }; rss: { feedUrl }
  lastFetchedAt?: number
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
  title: string
  body: string // markdown 正文
  publishedAt: number
  sourceUrl: string
  source: { id: string; type: string; name: string }

  // 处理层产出的增强字段（可空）
  summary?: string
  score?: number
  staleness?: Staleness
  provenance?: { verified: boolean; note?: string }
  tags?: string[]

  // 可拓展字段：不同信源特色元数据
  ext: Record<string, unknown>

  // 存储/状态元信息
  filePath?: string
  read?: boolean
  archived?: boolean
  createdAt: number
  updatedAt: number
}
