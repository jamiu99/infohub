<script setup lang="ts">
// 右栏：文章详情。标题/作者/来源/时间/原文 + 正文，操作栏。
import { computed } from 'vue'
import { store } from '../stores/app'
import { clockTime } from '../util'

const a = computed(() => store.state.selectedArticle)
const author = computed(() => (a.value?.ext?.author_name as string) || '')
const digest = computed(() => (a.value?.ext?.digest as string) || '')

function openOriginal(): void {
  if (a.value?.sourceUrl) window.open(a.value.sourceUrl, '_blank')
}
function archive(): void {
  if (a.value) void window.api.article.archive(a.value.id).then(() => store.refreshAll())
}
function publishedDate(ts: number): string {
  return ts ? new Date(ts).toLocaleString() : ''
}
</script>

<template>
  <div v-if="a" class="detail">
    <h1>{{ a.title }}</h1>
    <div class="meta">
      <span v-if="author">{{ author }}</span>
      <span>{{ a.source.name }}</span>
      <span>{{ publishedDate(a.publishedAt) }}</span>
    </div>
    <div class="actions">
      <button class="primary" @click="openOriginal">打开原文</button>
      <button @click="archive">归档</button>
    </div>
    <div class="content">
      <template v-if="a.body">{{ a.body }}</template>
      <p v-else class="placeholder">
        {{ digest || '正文尚未抓取。' }}<br />
        <span class="dim">（列表接口仅返回摘要，完整正文将在后续处理阶段抓取原文页面）</span>
      </p>
    </div>
  </div>
  <div v-else class="empty">
    <p>选择一篇文章查看</p>
    <p class="clock dim">{{ clockTime(Date.now()) }}</p>
  </div>
</template>

<style scoped>
.detail {
  padding: 24px 28px;
  max-width: 760px;
}
h1 {
  font-size: 22px;
  line-height: 1.35;
  margin: 0 0 12px;
}
.meta {
  display: flex;
  gap: 14px;
  color: var(--text-dim);
  font-size: 13px;
  flex-wrap: wrap;
}
.actions {
  display: flex;
  gap: 8px;
  margin: 16px 0;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--border);
}
.content {
  line-height: 1.7;
  white-space: pre-wrap;
}
.placeholder {
  color: var(--text);
}
.dim {
  color: var(--text-dim);
  font-size: 12px;
}
.empty {
  text-align: center;
  color: var(--text-dim);
  margin-top: 80px;
}
</style>
