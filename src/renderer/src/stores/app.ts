// 前端状态：信源、文章、账号、进度。集中管理并订阅 main 推送。
import { reactive, readonly } from 'vue'
import type { Source, Article, DiscoverResult } from '../../../shared/contract'
import type { WechatCollectionSettings, WxAccountView } from '../../../shared/wechat'
import type { InfohubApi, IngestProgress, UpdateStatus } from '../../../shared/ipc'
import { userFacingError } from '../../../shared/errors'

type TeamStatus = Awaited<ReturnType<InfohubApi['team']['status']>>
type TeamJoinInput = Parameters<InfohubApi['team']['join']>[0]

interface State {
  sources: Source[]
  unread: Record<string, number>
  accounts: WxAccountView[]
  wechatSettings: WechatCollectionSettings | null
  articles: Article[]
  articlesLoading: boolean
  articlesError: string
  selectedSourceId: string | null // null = 全部
  selectedArticle: Article | null
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
  unread: {},
  accounts: [],
  wechatSettings: null,
  articles: [],
  articlesLoading: true,
  articlesError: '',
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

export const store = {
  state: readonly(state) as unknown as State,

  async init(): Promise<void> {
    await Promise.all([
      this.loadSources(),
      this.loadAccounts(),
      this.loadWechatSettings(),
      this.loadTeamStatus(),
      this.loadArticles()
    ])
    api.on('accounts-changed', () => void this.loadAccounts())
    api.on('articles-changed', () => void this.refreshAll())
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
    api.on('update-status', (s) => (state.update = s))
  },

  installUpdate(): void {
    void api.update.install()
  },

  checkUpdate(): void {
    void api.update.check()
  },

  async loadSources(): Promise<void> {
    state.sources = await api.source.list()
    state.unread = await api.article.unreadCounts()
  },

  async loadAccounts(): Promise<void> {
    state.accounts = await api.account.list()
  },

  async loadWechatSettings(): Promise<void> {
    state.wechatSettings = await api.account.getCollectionSettings()
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
    await Promise.all([this.loadSources(), this.loadArticles()])
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
