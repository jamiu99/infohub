<script setup lang="ts">
// 中栏：文章流（未读点+标题+相对时间），顶部刷新+筛选，底部进度条。
import { computed } from 'vue'
import { store } from '../stores/app'
import { relativeTime, clockTime } from '../util'

const articles = computed(() => store.state.articles)
const selectedId = computed(() => store.state.selectedArticle?.id)
const progress = computed(() => store.state.progress)

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
      <h2>{{ title }}</h2>
      <div class="tools">
        <select :value="store.state.filter" @change="store.setFilter(($event.target as HTMLSelectElement).value as any)">
          <option value="all">全部</option>
          <option value="unread">未读</option>
          <option value="archived">已归档</option>
        </select>
        <button :disabled="store.state.loading" @click="refresh">
          {{ store.state.loading ? '刷新中…' : '⟳ 刷新' }}
        </button>
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

    <ul v-if="articles.length" class="list">
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
      <p>暂无文章。</p>
      <p class="hint">先扫码登录 → 加公众号，即可自动采集。</p>
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
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 12px 16px;
  border-bottom: 1px solid var(--border);
}
h2 {
  margin: 0;
  font-size: 15px;
}
.tools {
  display: flex;
  gap: 8px;
}
select {
  border: 1px solid var(--border);
  border-radius: 6px;
  background: var(--bg);
  color: var(--text);
  padding: 4px;
}
.progress {
  padding: 6px 16px;
  font-size: 12px;
  background: var(--bg-sidebar);
  color: var(--text-dim);
}
.list {
  list-style: none;
  margin: 0;
  padding: 0;
  overflow-y: auto;
}
.list li {
  display: flex;
  gap: 8px;
  padding: 11px 16px;
  border-bottom: 1px solid var(--border);
  cursor: pointer;
}
.list li:hover {
  background: var(--bg-hover);
}
.list li.active {
  background: var(--bg-active);
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--unread);
  margin-top: 5px;
  flex-shrink: 0;
}
.title {
  line-height: 1.4;
}
.unread .title {
  font-weight: 600;
}
.meta {
  color: var(--text-dim);
  font-size: 12px;
  margin-top: 3px;
}
.empty {
  text-align: center;
  color: var(--text-dim);
  margin-top: 40px;
}
.hint {
  font-size: 12px;
}
</style>
