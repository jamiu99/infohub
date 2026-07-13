<script setup lang="ts">
// 中栏：文章流（未读点+标题+相对时间），顶部刷新+筛选，底部进度条。
import { computed } from 'vue'
import { store } from '../stores/app'
import { relativeTime, clockTime } from '../util'

const articles = computed(() => store.state.articles)
const selectedId = computed(() => store.state.selectedArticle?.id)
const progress = computed(() => store.state.progress)
const busy = computed(() => progress.value.phase !== 'idle')
const teamAvailable = computed(() => Boolean(store.state.team?.device))

const title = computed(() => {
  const id = store.state.selectedSourceId
  if (!id) return '全部'
  return store.state.sources.find((s) => s.id === id)?.name ?? '全部'
})

function refresh(): void {
  void store.refresh(store.state.selectedSourceId ?? undefined)
}
</script>

<template>
  <div class="wrap">
    <header>
      <div class="title-row">
        <h2 :title="title">{{ title }}</h2>
        <button :disabled="busy" class="refresh" @click="refresh">
          {{ busy ? '采集中…' : '⟳ 刷新' }}
        </button>
      </div>
      <div class="tools">
        <div class="scope-tabs" aria-label="文章范围">
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
        <select :value="store.state.filter" @change="store.setFilter(($event.target as HTMLSelectElement).value as any)">
          <option value="all">全部</option>
          <option value="unread">未读</option>
          <option value="archived">已归档</option>
        </select>
      </div>
    </header>

    <div v-if="progress.phase !== 'idle'" class="progress">
      <template v-if="progress.phase === 'polling'">
        正在采集 {{ progress.currentSource }}…（剩 {{ progress.queued }}）
      </template>
      <template v-else-if="progress.phase === 'waiting_quota'">
        ⏸ 配额用尽，等待恢复至 {{ clockTime(progress.waitingUntil) }}（剩 {{ progress.queued }} 个待采）
      </template>
    </div>

    <div v-if="store.state.articlesLoading" class="load-state">正在加载文章…</div>
    <div v-else-if="store.state.articlesError" class="load-state error">
      <p>{{ store.state.articlesError }}</p>
      <button @click="store.loadArticles()">重试</button>
    </div>
    <ul v-else-if="articles.length" class="list">
      <li
        v-for="a in articles"
        :key="a.id"
        :class="{ active: selectedId === a.id, unread: !a.read }"
        @click="store.openArticle(a.id)"
      >
        <span class="dot" v-if="!a.read"></span>
        <div class="body">
          <div class="title">{{ a.title }}</div>
          <div class="meta">{{ a.source.name }} · {{ relativeTime(a.publishedAt) }}</div>
        </div>
      </li>
    </ul>
    <div v-else class="empty">
      <template v-if="store.state.articleScope === 'team'">
        <p>团队里还没有同步到文章。</p>
        <p class="hint">其他成员上传采集结果后，会显示在这里。</p>
      </template>
      <template v-else>
        <p>暂无文章。</p>
        <p class="hint">先扫码登录 → 加公众号，即可自动采集。</p>
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
  gap: 8px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  min-height: 52px;
  background: var(--bg);
}
.title-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-width: 0;
  width: 100%;
}
h2 {
  flex: 1 1 auto;
  min-width: 0;
  margin: 0;
  font-size: 14px;
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.tools {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  min-width: 0;
  width: 100%;
}
.scope-tabs {
  display: inline-flex;
  flex: 0 0 auto;
  padding: 2px;
  border-radius: var(--radius-sm);
  background: var(--bg-subtle);
  border: 1px solid var(--border);
}
.scope-tabs button {
  border: 0;
  padding: 3px 10px;
  background: transparent;
  color: var(--text-dim);
  box-shadow: none;
  white-space: nowrap;
}
.scope-tabs button.active {
  background: var(--bg-elevated);
  color: var(--text);
  box-shadow: var(--shadow-sm);
}
.scope-tabs button:disabled {
  opacity: 0.42;
}
.refresh {
  padding: 4px 9px;
}
select {
  flex: 0 0 auto;
  width: auto;
  padding: 5px 8px;
}
.progress {
  padding: 7px 16px;
  font-size: 12px;
  background: var(--accent-soft);
  color: var(--accent);
  border-bottom: 1px solid var(--border);
}
.list {
  flex: 1 1 auto;
  min-height: 0;
  list-style: none;
  margin: 0;
  padding: 0;
  overflow-y: auto;
}
.list li {
  display: flex;
  gap: 10px;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
  cursor: pointer;
  transition: background 0.1s;
}
.list li:hover {
  background: var(--bg-hover);
}
.list li.active {
  background: var(--bg-active);
  box-shadow: inset 2px 0 0 var(--accent);
}
.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--unread);
  margin-top: 6px;
  flex-shrink: 0;
}
.title {
  line-height: 1.45;
  color: var(--text-secondary);
}
.unread .title {
  font-weight: 600;
  color: var(--text);
}
.meta {
  color: var(--text-dim);
  font-size: 12px;
  margin-top: 4px;
}
.empty {
  text-align: center;
  color: var(--text-dim);
  margin-top: 64px;
  padding: 0 24px;
}
.load-state {
  margin-top: 64px;
  padding: 0 24px;
  text-align: center;
  color: var(--text-dim);
}
.load-state.error {
  color: var(--warn);
}
.load-state p {
  margin: 0 0 10px;
}
.empty p {
  margin: 6px 0;
}
.hint {
  font-size: 12px;
}
</style>
