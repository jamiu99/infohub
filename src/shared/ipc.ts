// IPC 契约：renderer 通过 preload 暴露的 window.api 调用 main。
// 单一事实来源，preload 与 renderer 类型都从这里取。

import type { Source, Article, DiscoverResult } from './contract'
import type { WechatCollectionSettings, WxAccountView } from './wechat'

/** 轮询/采集进度事件（main → renderer 推送） */
export interface IngestProgress {
  phase: 'idle' | 'polling' | 'waiting_quota'
  currentSource?: string
  queued: number
  nextRunAt?: number // 下一轮自动轮询时刻
  waitingUntil?: number // 全账号不可用时，预计恢复时刻
}

/** renderer 可调用的 API（在 preload 里实现为 ipcRenderer.invoke 包装） */
export interface InfohubApi {
  // —— 账号 ——
  account: {
    list(): Promise<WxAccountView[]>
    /** 打开登录窗口（独立分区），扫码登录一个号，关窗时入池。返回最新账号列表 */
    login(): Promise<WxAccountView[]>
    /** 重新登录失效账号（复用其原分区刷新凭证） */
    relogin(accountId: string): Promise<WxAccountView[]>
    remove(accountId: string): Promise<void>
    getCollectionSettings(): Promise<WechatCollectionSettings>
    /** 修改所有微信账号共用的本地小时保护上限，保存后立即生效。 */
    setHourlyRequestLimit(value: number): Promise<WechatCollectionSettings>
  }
  // —— 信源（关注的公众号 / RSS / …）——
  source: {
    list(): Promise<Source[]>
    /** 发现信源：wechat 按名搜、rss 试探 feed URL。返回统一候选 */
    search(type: string, query: string): Promise<DiscoverResult[]>
    /** 添加关注并后台采集。type 决定信源类型 */
    add(type: string, result: DiscoverResult): Promise<Source>
    remove(sourceId: string): Promise<void>
    /** 手动刷新单个号或全部（传 undefined 刷全部） */
    refresh(sourceId?: string): Promise<void>
  }
  // —— 文章 ——
  article: {
    list(opts?: { sourceId?: string; filter?: 'unread' | 'all' | 'archived' }): Promise<Article[]>
    get(id: string): Promise<Article | null>
    markRead(id: string, read: boolean): Promise<void>
    archive(id: string): Promise<void>
    unreadCounts(): Promise<Record<string, number>> // sourceId → 未读数
  }
  // —— 自动更新 ——
  update: {
    check(): Promise<void>
    install(): Promise<void>
  }
  // —— 事件订阅 ——
  on(channel: 'ingest-progress', cb: (p: IngestProgress) => void): () => void
  on(channel: 'accounts-changed', cb: () => void): () => void
  on(channel: 'articles-changed', cb: () => void): () => void
  on(channel: 'update-status', cb: (s: UpdateStatus) => void): () => void
}

/** 自动更新状态（main → renderer） */
export interface UpdateStatus {
  state: 'checking' | 'available' | 'none' | 'downloading' | 'ready' | 'error'
  version?: string
  percent?: number
  message?: string
}

/** IPC 通道名常量 */
export const IPC = {
  accountList: 'account:list',
  accountLogin: 'account:login',
  accountRelogin: 'account:relogin',
  accountRemove: 'account:remove',
  accountGetCollectionSettings: 'account:getCollectionSettings',
  accountSetHourlyRequestLimit: 'account:setHourlyRequestLimit',
  sourceList: 'source:list',
  sourceSearch: 'source:search',
  sourceAdd: 'source:add',
  sourceRemove: 'source:remove',
  sourceRefresh: 'source:refresh',
  articleList: 'article:list',
  articleGet: 'article:get',
  articleMarkRead: 'article:markRead',
  articleArchive: 'article:archive',
  articleUnreadCounts: 'article:unreadCounts'
} as const
