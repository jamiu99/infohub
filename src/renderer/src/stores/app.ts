// 前端状态：信源、文章、账号、进度。集中管理并订阅 main 推送。
import { reactive, readonly } from 'vue'
import type { Source, Article, ArticleDetail, DiscoverResult } from '../../../shared/contract'
import type { WechatCollectionSettings, WxAccountView } from '../../../shared/wechat'
import type { InfohubApi, IngestProgress, UpdateStatus } from '../../../shared/ipc'
import type { CollectionScheduleStatus, CollectionSettingsView } from '../../../shared/collection'
import type {
  ArticleMaintenanceRequest,
  ArticleMaintenanceResult
} from '../../../shared/maintenance'
import { userFacingError } from '../../../shared/errors'

type TeamStatus = Awaited<ReturnType<InfohubApi['team']['status']>>
type TeamJoinInput = Parameters<InfohubApi['team']['join']>[0]
type DataLibraryStatus = Awaited<ReturnType<InfohubApi['dataLibrary']['status']>>
type DataLibraryMoveResult = Awaited<ReturnType<InfohubApi['dataLibrary']['chooseAndMigrate']>>

interface State {
  sources: Source[]
  sourcesError: string
  unread: Record<string, number>
  accounts: WxAccountView[]
  accountsError: string
  wechatSettings: WechatCollectionSettings | null
  wechatSettingsError: string
  collectionSettings: CollectionSettingsView | null
  collectionSettingsError: string
  collectionStatus: CollectionScheduleStatus | null
  collectionStatusError: string
  dataLibrary: DataLibraryStatus | null
  dataLibraryLoading: boolean
  dataLibraryBusy: boolean
  dataLibraryError: string
  articles: Article[]
  articlesLoading: boolean
  articlesError: string
  articleMaintenanceBusy: boolean
  selectedSourceId: string | null // null = 全部
  selectedArticle: ArticleDetail | null
  filter: 'unread' | 'all' | 'archived'
  articleScope: 'mine' | 'team'
  team: TeamStatus | null
  teamLoading: boolean
  teamError: string
  progress: IngestProgress
  update: UpdateStatus | null
}

const state = reactive<State>({
  sources: [],
  sourcesError: '',
  unread: {},
  accounts: [],
  accountsError: '',
  wechatSettings: null,
  wechatSettingsError: '',
  collectionSettings: null,
  collectionSettingsError: '',
  collectionStatus: null,
  collectionStatusError: '',
  dataLibrary: null,
  dataLibraryLoading: true,
  dataLibraryBusy: false,
  dataLibraryError: '',
  articles: [],
  articlesLoading: true,
  articlesError: '',
  articleMaintenanceBusy: false,
  selectedSourceId: null,
  selectedArticle: null,
  filter: 'all',
  articleScope: 'mine',
  team: null,
  teamLoading: true,
  teamError: '',
  progress: { phase: 'idle', queued: 0 },
  update: null
})

const api = window.api
let articleRequestId = 0
let eventSubscriptionsInstalled = false

export const store = {
  state: readonly(state) as unknown as State,

  async init(): Promise<void> {
    // 先订阅再读取初始快照，避免任一 IPC 失败时整个应用失去后续恢复事件。
    if (!eventSubscriptionsInstalled) {
      eventSubscriptionsInstalled = true
      api.on('accounts-changed', () => void this.loadAccounts())
      api.on('articles-changed', () => {
        void this.refreshAll().catch((error) => {
          state.articlesError = userFacingError(error, '更新文章列表失败')
        })
      })
      api.on('team-status', (status) => {
        state.team = status
        state.teamLoading = false
        state.teamError = status.error ? userFacingError(status.error, '团队同步异常') : ''
        if (!status.device && state.articleScope === 'team') {
          state.articleScope = 'mine'
          state.selectedArticle = null
          void this.loadArticles()
        }
      })
      api.on('ingest-progress', (p) => (state.progress = p))
      api.on('collection-status', (status) => {
        state.collectionStatus = status
        state.collectionStatusError = ''
      })
      api.on('update-status', (s) => (state.update = s))
    }

    const results = await Promise.allSettled([
      this.loadSources(),
      this.loadAccounts(),
      this.loadWechatSettings(),
      this.loadCollectionSettings(),
      this.loadCollectionStatus(),
      this.loadDataLibraryStatus(),
      this.loadTeamStatus(),
      this.loadArticles()
    ])
    for (const result of results) {
      if (result.status === 'rejected') console.error('初始化局部状态失败:', result.reason)
    }
  },

  installUpdate(): void {
    void api.update.install()
  },

  checkUpdate(): void {
    void api.update.check()
  },

  async loadSources(): Promise<void> {
    state.sourcesError = ''
    try {
      const [sources, unread] = await Promise.all([
        api.source.list(),
        api.article.unreadCounts()
      ])
      state.sources = sources
      state.unread = unread
    } catch (error) {
      state.sourcesError = userFacingError(error, '信源列表加载失败')
    }
  },

  async loadAccounts(): Promise<void> {
    state.accountsError = ''
    try {
      state.accounts = await api.account.list()
    } catch (error) {
      state.accountsError = userFacingError(error, '账号列表加载失败')
    }
  },

  async loadWechatSettings(): Promise<void> {
    state.wechatSettingsError = ''
    try {
      state.wechatSettings = await api.account.getCollectionSettings()
    } catch (error) {
      state.wechatSettingsError = userFacingError(error, '账号采集设置加载失败')
    }
  },

  async loadCollectionSettings(): Promise<void> {
    state.collectionSettingsError = ''
    try {
      state.collectionSettings = await api.collection.getSettings()
    } catch (error) {
      state.collectionSettingsError = userFacingError(error, '自动采集设置加载失败')
    }
  },

  async loadCollectionStatus(): Promise<void> {
    state.collectionStatusError = ''
    try {
      state.collectionStatus = await api.collection.status()
    } catch (error) {
      state.collectionStatusError = userFacingError(error, '自动采集状态加载失败')
    }
  },

  async loadDataLibraryStatus(): Promise<void> {
    state.dataLibraryLoading = true
    state.dataLibraryError = ''
    try {
      state.dataLibrary = await api.dataLibrary.status()
    } catch (error) {
      state.dataLibraryError = userFacingError(error, '无法读取数据资料库状态')
    } finally {
      state.dataLibraryLoading = false
    }
  },

  async openDataLibrary(): Promise<void> {
    if (state.dataLibraryBusy) return
    state.dataLibraryBusy = true
    state.dataLibraryError = ''
    try {
      await api.dataLibrary.open()
    } catch (error) {
      state.dataLibraryError = userFacingError(error, '打开数据资料库失败')
      throw new Error(state.dataLibraryError)
    } finally {
      state.dataLibraryBusy = false
    }
  },

  async chooseAndMigrateDataLibrary(): Promise<DataLibraryMoveResult> {
    if (state.dataLibraryBusy) return { state: 'cancelled' }
    state.dataLibraryBusy = true
    state.dataLibraryError = ''
    try {
      return await api.dataLibrary.chooseAndMigrate()
    } catch (error) {
      state.dataLibraryError = userFacingError(error, '迁移数据资料库失败')
      throw new Error(state.dataLibraryError)
    } finally {
      state.dataLibraryBusy = false
    }
  },

  async loadArticles(): Promise<void> {
    const requestId = ++articleRequestId
    state.articlesLoading = true
    state.articlesError = ''
    try {
      const articles = await api.article.list({
        sourceId: state.selectedSourceId ?? undefined,
        filter: state.filter,
        scope: state.articleScope
      })
      if (requestId === articleRequestId) state.articles = articles
    } catch (error) {
      if (requestId === articleRequestId) {
        state.articles = []
        state.articlesError = userFacingError(error, '文章加载失败')
      }
    } finally {
      if (requestId === articleRequestId) state.articlesLoading = false
    }
  },

  async loadTeamStatus(): Promise<void> {
    state.teamLoading = true
    state.teamError = ''
    try {
      state.team = await api.team.status()
      state.teamError = state.team.error
        ? userFacingError(state.team.error, '无法读取团队状态')
        : ''
    } catch (error) {
      state.teamError = userFacingError(error, '无法读取团队状态')
    } finally {
      state.teamLoading = false
    }
  },

  async refreshAll(): Promise<void> {
    const selectedId = state.selectedArticle?.id
    const [, , selected] = await Promise.all([
      this.loadSources(),
      this.loadArticles(),
      selectedId ? api.article.get(selectedId) : Promise.resolve(null)
    ])
    // 采集可能刚为当前文章补齐 HTML；列表刷新时同时替换详情，避免必须重新点选。
    if (selectedId && state.selectedArticle?.id === selectedId) state.selectedArticle = selected
  },

  async selectSource(id: string | null): Promise<void> {
    state.selectedSourceId = id
    state.selectedArticle = null
    await this.loadArticles()
  },

  async setFilter(f: State['filter']): Promise<void> {
    state.filter = f
    await this.loadArticles()
  },

  async setArticleScope(scope: State['articleScope']): Promise<void> {
    if (scope === 'team' && !state.team?.device) return
    state.articleScope = scope
    state.selectedArticle = null
    await this.loadArticles()
  },

  async openArticle(id: string): Promise<void> {
    const a = await api.article.get(id)
    state.selectedArticle = a
    if (a && !a.read) {
      await api.article.markRead(id, true)
      await this.loadSources()
      const item = state.articles.find((x) => x.id === id)
      if (item) item.read = true
    }
  },

  async markCurrentArticlesRead(): Promise<number> {
    const count = await api.article.markAllRead({
      ...(state.selectedSourceId ? { sourceId: state.selectedSourceId } : {}),
      scope: state.articleScope
    })
    if (state.selectedArticle && !state.selectedArticle.archived) state.selectedArticle.read = true
    await Promise.all([this.loadSources(), this.loadArticles()])
    return count
  },

  async reprocessArticles(input: ArticleMaintenanceRequest): Promise<ArticleMaintenanceResult> {
    if (state.articleMaintenanceBusy) {
      throw new Error('已有历史正文维护任务正在执行，请等待完成后再试。')
    }

    state.articleMaintenanceBusy = true
    try {
      const result = await api.article.reprocess(input)
      // 重抓会更新正文派生文件，同时刷新列表和当前已打开的详情。
      await this.refreshAll()
      return result
    } finally {
      state.articleMaintenanceBusy = false
    }
  },

  // —— 账号 ——
  async login(): Promise<void> {
    await api.account.login()
    await this.loadAccounts()
  },
  async relogin(id: string): Promise<void> {
    await api.account.relogin(id)
    await this.loadAccounts()
  },
  async setHourlyRequestLimit(value: number): Promise<void> {
    state.wechatSettings = await api.account.setHourlyRequestLimit(value)
    await this.loadAccounts()
  },
  async updateCollectionSettings(input: {
    autoCollectEnabled: boolean
    intervalMinutes: number
  }): Promise<void> {
    state.collectionSettings = await api.collection.updateSettings(input)
    await this.loadCollectionStatus()
  },

  // —— 团队同步 ——
  async joinTeam(input: TeamJoinInput): Promise<void> {
    state.teamLoading = true
    state.teamError = ''
    try {
      state.team = await api.team.join(input)
      state.teamError = state.team.error ? userFacingError(state.team.error, '加入团队失败') : ''
      if (!state.team.device) throw new Error(state.teamError || '加入团队失败')
      await this.refreshAll()
    } catch (error) {
      state.teamError = userFacingError(error, '加入团队失败')
      throw new Error(state.teamError)
    } finally {
      state.teamLoading = false
    }
  },

  async syncTeam(): Promise<void> {
    state.teamLoading = true
    state.teamError = ''
    try {
      state.team = await api.team.syncNow()
      state.teamError = state.team.error ? userFacingError(state.team.error, '团队同步失败') : ''
      if (state.team.state === 'error') throw new Error(state.teamError || '同步失败')
      await this.refreshAll()
    } catch (error) {
      state.teamError = userFacingError(error, '团队同步失败')
      throw new Error(state.teamError)
    } finally {
      state.teamLoading = false
    }
  },

  async leaveTeam(): Promise<void> {
    state.teamLoading = true
    state.teamError = ''
    try {
      state.team = await api.team.leave()
      state.articleScope = 'mine'
      state.selectedArticle = null
      await this.refreshAll()
    } catch (error) {
      state.teamError = userFacingError(error, '退出团队失败')
      throw new Error(state.teamError)
    } finally {
      state.teamLoading = false
    }
  },

  // —— 信源 ——
  async search(type: string, q: string): Promise<DiscoverResult[]> {
    return api.source.search(type, q)
  },
  async addSource(type: string, r: DiscoverResult): Promise<void> {
    // r 来自 reactive 的 results，是 Vue Proxy；IPC 结构化克隆无法克隆 Proxy
    // （报 "An object could not be cloned"）→ 先深拷成纯对象再传。
    const plain = JSON.parse(JSON.stringify(r)) as DiscoverResult
    await api.source.add(type, plain)
    await this.refreshAll()
  },
  async setSourceEnabled(id: string, enabled: boolean): Promise<void> {
    await api.source.setEnabled(id, enabled)
    await this.loadSources()
  },
  async removeSource(id: string): Promise<void> {
    await api.source.remove(id)
    if (state.selectedSourceId === id) state.selectedSourceId = null
    await this.refreshAll()
  },
  async refresh(sourceId?: string): Promise<void> {
    // 后台采集：立即返回，进度由 ingest-progress 事件驱动（见 ArticleFlow 进度条）。
    await api.source.refresh(sourceId)
  }
}
