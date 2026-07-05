// 前端状态：信源、文章、账号、进度。集中管理并订阅 main 推送。
import { reactive, readonly } from 'vue'
import type { Source, Article } from '../../../shared/contract'
import type { WxAccountView, WxSearchResult } from '../../../shared/wechat'
import type { IngestProgress } from '../../../shared/ipc'

interface State {
  sources: Source[]
  unread: Record<string, number>
  accounts: WxAccountView[]
  articles: Article[]
  selectedSourceId: string | null // null = 全部
  selectedArticle: Article | null
  filter: 'unread' | 'all' | 'archived'
  progress: IngestProgress
  loading: boolean
}

const state = reactive<State>({
  sources: [],
  unread: {},
  accounts: [],
  articles: [],
  selectedSourceId: null,
  selectedArticle: null,
  filter: 'all',
  progress: { phase: 'idle', queued: 0 },
  loading: false
})

const api = window.api

export const store = {
  state: readonly(state) as unknown as State,

  async init(): Promise<void> {
    await Promise.all([this.loadSources(), this.loadAccounts(), this.loadArticles()])
    api.on('accounts-changed', () => void this.loadAccounts())
    api.on('articles-changed', () => void this.refreshAll())
    api.on('ingest-progress', (p) => (state.progress = p))
  },

  async loadSources(): Promise<void> {
    state.sources = await api.source.list()
    state.unread = await api.article.unreadCounts()
  },

  async loadAccounts(): Promise<void> {
    state.accounts = await api.account.list()
  },

  async loadArticles(): Promise<void> {
    state.articles = await api.article.list({
      sourceId: state.selectedSourceId ?? undefined,
      filter: state.filter
    })
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

  // —— 信源 ——
  async search(q: string): Promise<WxSearchResult[]> {
    return api.source.search(q)
  },
  async addSource(r: WxSearchResult): Promise<void> {
    await api.source.add(r)
    await this.refreshAll()
  },
  async removeSource(id: string): Promise<void> {
    await api.source.remove(id)
    if (state.selectedSourceId === id) state.selectedSourceId = null
    await this.refreshAll()
  },
  async refresh(sourceId?: string): Promise<void> {
    state.loading = true
    try {
      await api.source.refresh(sourceId)
      await this.refreshAll()
    } finally {
      state.loading = false
    }
  }
}
