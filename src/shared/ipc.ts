// IPC 契约：renderer 通过 preload 暴露的 window.api 调用 main。
// 单一事实来源，preload 与 renderer 类型都从这里取。

import type { Source, Article, ArticleDetail, DiscoverResult } from './contract'
import type { WechatCollectionSettings, WxAccountView } from './wechat'
import type { TeamJoinInput, TeamStatus } from './team'
import type { CollectionScheduleStatus, CollectionSettingsView } from './collection'
import type { ArticleMaintenanceRequest, ArticleMaintenanceResult } from './maintenance'
import type { DataLibraryMoveResult, DataLibraryStatus } from './data-library'

/** 轮询/采集进度事件（main → renderer 推送） */
export interface IngestProgress {
  phase: 'idle' | 'polling' | 'waiting_quota'
  origin?: 'manual' | 'automatic' | 'initial' | 'maintenance'
  currentSource?: string
  queued: number
  nextRunAt?: number // 下一轮自动轮询时刻
  waitingUntil?: number // 全账号不可用时，预计恢复时刻
}

export interface ArticleListOptions {
  sourceId?: string
  filter?: 'unread' | 'all' | 'archived'
  scope?: 'mine' | 'team'
}

export interface MarkAllReadOptions {
  sourceId?: string
  scope?: 'mine' | 'team'
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
  // —— 内容采集计划（与软件自动更新无关）——
  collection: {
    getSettings(): Promise<CollectionSettingsView>
    updateSettings(input: {
      autoCollectEnabled: boolean
      intervalMinutes: number
    }): Promise<CollectionSettingsView>
    status(): Promise<CollectionScheduleStatus>
  }
  // —— 可迁移的内容资料库 ——
  dataLibrary: {
    status(): Promise<DataLibraryStatus>
    open(): Promise<void>
    /** 选择空目录，排队到下次启动迁移；应用会安全关闭后自动重启。 */
    chooseAndMigrate(): Promise<DataLibraryMoveResult>
  }
  // —— 信源（关注的公众号 / RSS / …）——
  source: {
    list(): Promise<Source[]>
    /** 发现信源：wechat 按名搜、rss 试探 feed URL。返回统一候选 */
    search(type: string, query: string): Promise<DiscoverResult[]>
    /** 添加关注并后台采集。type 决定信源类型 */
    add(type: string, result: DiscoverResult): Promise<Source>
    /** 控制该信源是否参加“全部拉取”和自动采集；单源手动拉取仍可执行。 */
    setEnabled(sourceId: string, enabled: boolean): Promise<Source>
    remove(sourceId: string): Promise<void>
    /** 拉取单个来源或全部 enabled 来源的最新列表；不负责历史回溯。 */
    refresh(sourceId?: string): Promise<void>
  }
  // —— 文章 ——
  article: {
    list(opts?: ArticleListOptions): Promise<Article[]>
    get(id: string): Promise<ArticleDetail | null>
    markRead(id: string, read: boolean): Promise<void>
    /** 将当前来源/阅读范围内所有未归档文章标为已读，不受列表 500 条上限影响。 */
    markAllRead(opts?: MarkAllReadOptions): Promise<number>
    archive(id: string): Promise<void>
    unreadCounts(): Promise<Record<string, number>> // sourceId → 未读数
    /** 从本机快照离线重建，或重新请求原文；原始快照永不被覆盖。 */
    reprocess(input: ArticleMaintenanceRequest): Promise<ArticleMaintenanceResult>
  }
  // —— 团队同步 ——
  team: {
    status(): Promise<TeamStatus>
    join(input: TeamJoinInput): Promise<TeamStatus>
    leave(): Promise<TeamStatus>
    syncNow(): Promise<TeamStatus>
  }
  // —— 自动更新 ——
  update: {
    check(): Promise<void>
    install(): Promise<void>
  }
  // —— 事件订阅 ——
  on(channel: 'ingest-progress', cb: (p: IngestProgress) => void): () => void
  on(channel: 'collection-status', cb: (s: CollectionScheduleStatus) => void): () => void
  on(channel: 'accounts-changed', cb: () => void): () => void
  on(channel: 'articles-changed', cb: () => void): () => void
  on(channel: 'team-status', cb: (status: TeamStatus) => void): () => void
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
  collectionGetSettings: 'collection:getSettings',
  collectionUpdateSettings: 'collection:updateSettings',
  collectionStatus: 'collection:status',
  dataLibraryStatus: 'dataLibrary:status',
  dataLibraryOpen: 'dataLibrary:open',
  dataLibraryChooseAndMigrate: 'dataLibrary:chooseAndMigrate',
  sourceList: 'source:list',
  sourceSearch: 'source:search',
  sourceAdd: 'source:add',
  sourceSetEnabled: 'source:setEnabled',
  sourceRemove: 'source:remove',
  sourceRefresh: 'source:refresh',
  articleList: 'article:list',
  articleGet: 'article:get',
  articleMarkRead: 'article:markRead',
  articleMarkAllRead: 'article:markAllRead',
  articleArchive: 'article:archive',
  articleUnreadCounts: 'article:unreadCounts',
  articleReprocess: 'article:reprocess',
  teamStatus: 'team:status',
  teamJoin: 'team:join',
  teamLeave: 'team:leave',
  teamSyncNow: 'team:syncNow'
} as const
