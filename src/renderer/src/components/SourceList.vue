<script setup lang="ts">
import { computed, ref } from 'vue'
import type { Source } from '../../../shared/contract'
import { store } from '../stores/app'
import AddSourceDialog from './AddSourceDialog.vue'

const showAdd = ref(false)
const sources = computed(() => store.state.sources)
const unread = computed(() => store.state.unread)
const selected = computed(() => store.state.selectedSourceId)
const busy = computed(() => store.state.progress.phase !== 'idle')
const totalUnread = computed(() => Object.values(unread.value).reduce((total, value) => total + value, 0))
const hasActiveWechatAccount = computed(() =>
  store.state.accounts.some((account) => account.status === 'active')
)

function dot(source: Source): string {
  if (source.type === 'wechat' && !hasActiveWechatAccount.value) return 'warn'
  if (!source.enabled) return 'paused'
  return (unread.value[source.id] ?? 0) > 0 ? 'unread' : 'read'
}
</script>

<template>
  <div class="wrap">
    <header class="source-header">
      <div>
        <span>SOURCES</span>
        <strong>阅读来源</strong>
      </div>
      <button class="quiet" title="添加公众号或 RSS" @click="showAdd = true">＋</button>
    </header>

    <button class="all" :class="{ active: selected === null }" @click="store.selectSource(null)">
      <span class="all-glyph">全</span>
      <span class="name">全部来源</span>
      <span v-if="totalUnread" class="badge">{{ totalUnread }}</span>
    </button>

    <div class="section-label">
      <span>已关注</span>
      <span>{{ sources.length }}</span>
    </div>

    <ul class="list">
      <li v-for="source in sources" :key="source.id">
        <button
          class="source-row"
          :class="{ active: selected === source.id }"
          @click="store.selectSource(source.id)"
        >
          <span class="source-type" :class="source.type">{{ source.type === 'wechat' ? '微' : 'R' }}</span>
          <span class="copy">
            <span class="name">{{ source.name }}</span>
            <small>{{ source.type === 'wechat' ? '微信公众号' : 'RSS' }}{{ source.enabled ? '' : ' · 已暂停' }}</small>
          </span>
          <span class="dot" :class="dot(source)"></span>
          <span v-if="unread[source.id]" class="badge">{{ unread[source.id] }}</span>
        </button>
      </li>
    </ul>

    <div v-if="store.state.sourcesError" class="source-error" role="alert">
      <span>{{ store.state.sourcesError }}</span>
      <button @click="store.loadSources()">重试</button>
    </div>

    <footer>
      <button
        class="latest"
        :disabled="busy || !sources.some((source) => source.enabled)"
        title="拉取所有启用来源的最新列表，不回溯历史"
        @click="store.refresh()"
      >
        {{ busy ? '任务进行中…' : '拉取全部最新' }}
      </button>
      <button class="add" @click="showAdd = true">添加来源</button>
    </footer>

    <AddSourceDialog v-if="showAdd" @close="showAdd = false" />
  </div>
</template>

<style scoped>
.wrap {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-width: 0;
}
.source-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 13px 12px;
}
.source-header > div {
  display: flex;
  flex-direction: column;
}
.source-header span {
  color: var(--accent);
  font-size: 9px;
  font-weight: 800;
  letter-spacing: 1px;
}
.source-header strong {
  margin-top: 3px;
  font-size: 15px;
}
.source-header button {
  width: 29px;
  height: 29px;
  padding: 0;
  font-size: 18px;
}
.all,
.source-row {
  display: flex;
  align-items: center;
  gap: 9px;
  width: calc(100% - 16px);
  margin: 0 8px;
  border-color: transparent;
  background: transparent;
  color: var(--text-secondary);
  text-align: left;
}
.all {
  padding: 8px;
}
.source-row {
  padding: 8px;
}
.all:hover,
.source-row:hover,
.all.active,
.source-row.active {
  background: var(--bg-hover);
}
.all.active,
.source-row.active {
  color: var(--accent-strong);
}
.all-glyph,
.source-type {
  display: grid;
  width: 27px;
  height: 27px;
  flex: 0 0 auto;
  place-items: center;
  border: 1px solid var(--border-strong);
  border-radius: 50%;
  background: var(--bg-elevated);
  color: var(--accent-strong);
  font-size: 10px;
  font-weight: 750;
}
.source-type.rss {
  color: var(--cooldown);
}
.name,
.copy {
  min-width: 0;
  flex: 1 1 auto;
}
.copy {
  display: flex;
  flex-direction: column;
}
.copy .name,
.copy small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.copy .name {
  font-size: 12.5px;
  font-weight: 580;
}
.copy small {
  margin-top: 2px;
  color: var(--text-dim);
  font-size: 9.5px;
}
.section-label {
  display: flex;
  justify-content: space-between;
  padding: 16px 14px 6px;
  color: var(--text-dim);
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.7px;
}
.list {
  flex: 1 1 auto;
  min-height: 0;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  list-style: none;
}
.list li {
  margin: 0;
  padding: 0;
}
.dot {
  width: 6px;
  height: 6px;
  flex: 0 0 auto;
  border-radius: 50%;
}
.dot.unread {
  background: var(--unread);
}
.dot.read {
  border: 1px solid var(--border-strong);
}
.dot.warn {
  background: var(--warn);
}
.dot.paused {
  background: var(--text-dim);
}
.badge {
  min-width: 19px;
  padding: 1px 6px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--bg-subtle);
  color: var(--text-secondary);
  font-size: 9.5px;
  font-weight: 650;
  text-align: center;
}
.active .badge {
  border-color: var(--accent);
  color: var(--accent-strong);
  background: var(--accent-soft);
}
footer {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 6px;
  padding: 10px;
  border-top: 1px solid var(--border);
}
footer button {
  padding-inline: 8px;
  font-size: 11px;
}
.latest {
  color: var(--accent-strong);
}
.add {
  background: transparent;
}
.source-error {
  margin: 6px 10px;
  padding: 8px;
  border-left: 3px solid var(--warn);
  background: color-mix(in srgb, var(--warn) 7%, transparent);
  color: var(--warn);
  font-size: 10.5px;
  line-height: 1.45;
}
.source-error button {
  width: 100%;
  margin-top: 6px;
}
</style>
