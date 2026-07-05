<script setup lang="ts">
// 右栏：文章详情。标题/作者/来源/时间/原文 + 正文，操作栏。
import { computed } from 'vue'
import { store } from '../stores/app'
import { clockTime } from '../util'
import { renderMarkdown } from '../markdown'

const a = computed(() => store.state.selectedArticle)
const author = computed(() => (a.value?.ext?.author_name as string) || '')
const digest = computed(() => (a.value?.ext?.digest as string) || '')
const bodyHtml = computed(() => (a.value?.body ? renderMarkdown(a.value.body) : ''))

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
    <!-- eslint-disable-next-line vue/no-v-html -->
    <div v-if="bodyHtml" class="content" v-html="bodyHtml"></div>
    <div v-else class="content">
      <p class="placeholder">
        {{ digest || '正文尚未抓取。' }}<br />
        <span class="dim">（列表接口仅返回摘要，完整正文将在采集时抓取原文页面）</span>
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
  padding: 32px 40px 64px;
  max-width: 720px;
  margin: 0 auto;
}
h1 {
  font-size: 24px;
  font-weight: 680;
  line-height: 1.3;
  margin: 0 0 14px;
  letter-spacing: -0.2px;
}
.meta {
  display: flex;
  gap: 14px;
  color: var(--text-dim);
  font-size: 12.5px;
  flex-wrap: wrap;
}
.actions {
  display: flex;
  gap: 8px;
  margin: 20px 0;
  padding-bottom: 20px;
  border-bottom: 1px solid var(--border);
}
.content {
  font-size: 15px;
  line-height: 1.8;
  color: var(--text);
}
.content :deep(p) {
  margin: 0 0 16px;
}
.content :deep(h1),
.content :deep(h2),
.content :deep(h3) {
  font-size: 18px;
  font-weight: 640;
  margin: 28px 0 12px;
  line-height: 1.4;
}
.content :deep(img) {
  max-width: 100%;
  height: auto;
  border-radius: var(--radius);
  margin: 12px 0;
  display: block;
}
.content :deep(a) {
  color: var(--accent);
  text-decoration: none;
}
.content :deep(a:hover) {
  text-decoration: underline;
}
.content :deep(blockquote) {
  margin: 16px 0;
  padding: 4px 16px;
  border-left: 3px solid var(--border-strong);
  color: var(--text-secondary);
}
.content :deep(ul) {
  padding-left: 22px;
  margin: 0 0 16px;
}
.content :deep(li) {
  margin: 4px 0;
}
.placeholder {
  color: var(--text-secondary);
  line-height: 1.7;
}
.dim {
  color: var(--text-dim);
  font-size: 12px;
}
.empty {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  height: 100%;
  color: var(--text-dim);
  gap: 8px;
}
</style>
