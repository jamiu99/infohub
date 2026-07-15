<script setup lang="ts">
import { computed, ref } from 'vue'
import { store } from '../stores/app'
import { relativeTime, clockTime } from '../util'
import { userFacingError } from '../../../shared/errors'

const articles = computed(() => store.state.articles)
const selectedId = computed(() => store.state.selectedArticle?.id)
const progress = computed(() => store.state.progress)
const busy = computed(() => progress.value.phase !== 'idle')
const busyLabel = computed(() =>
  progress.value.origin === 'maintenance' ? '处理历史中…' : '拉取中…'
)
const teamAvailable = computed(() => Boolean(store.state.team?.device))
const markingRead = ref(false)
const readMessage = ref('')
const readError = ref(false)
const filterOptions = [
  { value: 'all' as const, label: '全部' },
  { value: 'unread' as const, label: '未读' },
  { value: 'archived' as const, label: '归档' }
]

const title = computed(() => {
  const id = store.state.selectedSourceId
  if (!id) return '全部来源'
  return store.state.sources.find((source) => source.id === id)?.name ?? '全部来源'
})

const unreadInList = computed(() =>
  articles.value.filter((article) => !article.read && !article.archived).length
)
const listSummary = computed(() => {
  if (store.state.filter === 'archived') return `${articles.value.length} 篇已归档`
  return `${articles.value.length} 篇 · ${unreadInList.value} 篇未读`
})
const markReadTitle = computed(() =>
  store.state.selectedSourceId
    ? `将“${title.value}”下所有未归档文章标为已读`
    : '将当前阅读范围内所有来源的未归档文章标为已读'
)

function pullLatest(): void {
  readMessage.value = ''
  void store.refresh(store.state.selectedSourceId ?? undefined)
}

async function markAllRead(): Promise<void> {
  if (markingRead.value || store.state.filter === 'archived') return
  markingRead.value = true
  readMessage.value = ''
  try {
    const count = await store.markCurrentArticlesRead()
    readError.value = false
    readMessage.value = count > 0 ? `已将 ${count} 篇文章标为已读。` : '当前范围已经全部读完。'
  } catch (error) {
    readError.value = true
    readMessage.value = userFacingError(error, '批量标记已读失败')
  } finally {
    markingRead.value = false
  }
}
</script>

<template>
  <div class="wrap">
    <header>
      <div class="title-row">
        <div class="title-copy">
          <span class="eyebrow">READING QUEUE</span>
          <h2 :title="title">{{ title }}</h2>
          <p>{{ listSummary }}</p>
        </div>
        <button
          :disabled="busy"
          class="pull-latest"
          title="只拉取最新列表，不回溯未入库历史"
          @click="pullLatest"
        >
          {{ busy ? busyLabel : '拉取最新' }}
        </button>
      </div>

      <div class="tools">
        <div class="scope-tabs" aria-label="文章归属范围">
          <button
            :class="{ active: store.state.articleScope === 'mine' }"
            :aria-pressed="store.state.articleScope === 'mine'"
            @click="store.setArticleScope('mine')"
          >
            我的
          </button>
          <button
            :class="{ active: store.state.articleScope === 'team' }"
            :aria-pressed="store.state.articleScope === 'team'"
            :disabled="!teamAvailable"
            :title="teamAvailable ? '查看团队共享文章' : '加入团队后可用'"
            @click="store.setArticleScope('team')"
          >
            团队
          </button>
        </div>

        <div class="filter-tabs" aria-label="阅读状态筛选">
          <button
            v-for="item in filterOptions"
            :key="item.value"
            :class="{ active: store.state.filter === item.value }"
            :aria-pressed="store.state.filter === item.value"
            @click="store.setFilter(item.value)"
          >
            {{ item.label }}
          </button>
        </div>

        <button
          class="mark-read"
          :disabled="markingRead || store.state.filter === 'archived' || articles.length === 0"
          :title="markReadTitle"
          @click="markAllRead"
        >
          {{ markingRead ? '处理中…' : '✓ 全部已读' }}
        </button>
      </div>
    </header>

    <div v-if="readMessage" class="read-message" :class="{ error: readError }" role="status">
      {{ readMessage }}
    </div>

    <div v-if="progress.phase !== 'idle'" class="progress">
      <template v-if="progress.phase === 'polling'">
        {{ progress.origin === 'maintenance' ? '正在处理已入库历史' : progress.origin === 'automatic' ? '正在自动拉取最新' : '正在拉取最新' }}
        {{ progress.currentSource }}…（剩 {{ progress.queued }}）
      </template>
      <template v-else-if="progress.phase === 'waiting_quota'">
        配额用尽，等待恢复至 {{ clockTime(progress.waitingUntil) }}（剩 {{ progress.queued }} 个待采）
      </template>
    </div>

    <div v-if="store.state.articlesLoading" class="load-state">正在整理阅读列表…</div>
    <div v-else-if="store.state.articlesError" class="load-state error">
      <p>{{ store.state.articlesError }}</p>
      <button @click="store.loadArticles()">重试</button>
    </div>
    <ul v-else-if="articles.length" class="list">
      <li
        v-for="article in articles"
        :key="article.id"
        :class="{ active: selectedId === article.id, unread: !article.read }"
        @click="store.openArticle(article.id)"
      >
        <span v-if="!article.read" class="dot"></span>
        <div class="body">
          <div class="article-title">{{ article.title }}</div>
          <div class="meta">
            <span>{{ article.source.name }}</span>
            <span>{{ relativeTime(article.publishedAt) }}</span>
          </div>
        </div>
      </li>
    </ul>
    <div v-else class="empty">
      <span class="empty-mark">✓</span>
      <template v-if="store.state.filter === 'unread'">
        <p>这里已经读完了。</p>
        <p class="hint">切换到“全部”可以回看文章。</p>
      </template>
      <template v-else-if="store.state.articleScope === 'team'">
        <p>团队里还没有同步到文章。</p>
        <p class="hint">其他成员上传采集结果后，会显示在这里。</p>
      </template>
      <template v-else>
        <p>还没有文章。</p>
        <p class="hint">添加来源后，使用“拉取最新”建立阅读列表。</p>
      </template>
    </div>
  </div>
</template>

<style scoped>
.wrap {
  display: flex;
  flex-direction: column;
  height: 100%;
}
header {
  position: relative;
  z-index: 2;
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  gap: 13px;
  padding: 16px;
  border-bottom: 1px solid var(--border);
  background: var(--bg);
}
.title-row,
.tools,
.meta {
  display: flex;
  align-items: center;
}
.title-row {
  justify-content: space-between;
  gap: 14px;
  min-width: 0;
}
.title-copy {
  min-width: 0;
}
.eyebrow {
  display: block;
  margin-bottom: 3px;
  color: var(--accent);
  font-size: 9px;
  font-weight: 800;
  letter-spacing: 1px;
}
h2,
.title-copy p {
  margin: 0;
}
h2 {
  overflow: hidden;
  font-size: 17px;
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.title-copy p {
  margin-top: 3px;
  color: var(--text-dim);
  font-size: 11px;
}
.pull-latest {
  flex: 0 0 auto;
  border-color: var(--accent);
  color: var(--accent-strong);
  background: transparent;
}
.tools {
  gap: 7px;
  min-width: 0;
  flex-wrap: wrap;
}
.scope-tabs,
.filter-tabs {
  display: inline-flex;
  flex: 0 0 auto;
  padding: 2px;
  border: 1px solid var(--border);
  background: var(--bg-subtle);
}
.scope-tabs button,
.filter-tabs button {
  border: 0;
  padding: 3px 8px;
  background: transparent;
  color: var(--text-dim);
  box-shadow: none;
  white-space: nowrap;
}
.scope-tabs button.active,
.filter-tabs button.active {
  background: var(--bg-active);
  color: var(--text);
}
.mark-read {
  margin-left: auto;
  padding-inline: 9px;
  white-space: nowrap;
}
.read-message,
.progress {
  padding: 8px 16px;
  border-bottom: 1px solid var(--border);
  font-size: 11.5px;
}
.read-message {
  color: var(--ok);
  background: color-mix(in srgb, var(--ok) 7%, var(--bg));
}
.read-message.error {
  color: var(--warn);
}
.progress {
  color: var(--accent-strong);
  background: var(--accent-soft);
}
.list {
  flex: 1 1 auto;
  min-height: 0;
  margin: 0;
  padding: 8px;
  overflow-y: auto;
  list-style: none;
}
.list li {
  position: relative;
  display: flex;
  gap: 9px;
  margin-bottom: 3px;
  padding: 12px 11px;
  border: 1px solid transparent;
  cursor: pointer;
  transition: background 0.1s, border-color 0.1s;
}
.list li:hover {
  background: var(--bg-hover);
}
.list li.active {
  border-color: var(--border-strong);
  background: var(--bg-active);
}
.dot {
  width: 7px;
  height: 7px;
  margin-top: 6px;
  flex: 0 0 auto;
  border-radius: 50%;
  background: var(--unread);
}
.body {
  min-width: 0;
}
.article-title {
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1.5;
}
.unread .article-title {
  color: var(--text);
  font-weight: 650;
}
.meta {
  gap: 7px;
  margin-top: 6px;
  color: var(--text-dim);
  font-size: 10.5px;
}
.meta span + span::before {
  content: '·';
  margin-right: 7px;
}
.empty,
.load-state {
  margin: auto 0;
  padding: 32px 24px;
  color: var(--text-dim);
  text-align: center;
}
.empty-mark {
  display: grid;
  width: 34px;
  height: 34px;
  margin: 0 auto 12px;
  place-items: center;
  border: 1px solid var(--border-strong);
  border-radius: 50%;
  color: var(--accent);
}
.load-state.error {
  color: var(--warn);
}
.load-state p,
.empty p {
  margin: 6px 0;
}
.hint {
  font-size: 11px;
}
@media (max-width: 480px) {
  .mark-read {
    margin-left: 0;
  }
}
</style>
