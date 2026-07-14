<script setup lang="ts">
// 右栏：文章详情。微信文章可切换“原始排版 HTML / Markdown 阅读版”。
import { computed, ref, watch } from 'vue'
import { store } from '../stores/app'
import { clockTime } from '../util'
import { renderMarkdown } from '../markdown'
import { buildWechatSrcdoc } from '../wechat-html'

const a = computed(() => store.state.selectedArticle)
const author = computed(() => (a.value?.ext?.author_name as string) || '')
const digest = computed(() => (a.value?.ext?.digest as string) || '')
const bodyHtml = computed(() => (a.value?.body ? renderMarkdown(a.value.body) : ''))
const canShowOriginal = computed(
  () => a.value?.source.type === 'wechat' && Boolean(a.value.contentHtml)
)
const originalSrcdoc = computed(() =>
  a.value?.contentHtml
    ? buildWechatSrcdoc(a.value.contentHtml, a.value.sourceUrl)
    : ''
)
const viewMode = ref<'original' | 'reader'>('reader')

watch(
  () => ({ id: a.value?.id, canShowOriginal: canShowOriginal.value }),
  (next, previous) => {
    if (!next.canShowOriginal) viewMode.value = 'reader'
    else if (next.id !== previous?.id || !previous?.canShowOriginal) viewMode.value = 'original'
  },
  { immediate: true }
)

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
  <div v-if="a" class="detail-shell">
    <header class="detail-header">
      <h1>{{ a.title }}</h1>
      <div class="meta">
        <span v-if="author">{{ author }}</span>
        <span>{{ a.source.name }}</span>
        <span>{{ publishedDate(a.publishedAt) }}</span>
      </div>
      <div class="actions">
        <button class="primary" @click="openOriginal">打开原文</button>
        <button @click="archive">归档</button>
        <div v-if="canShowOriginal" class="content-mode" role="group" aria-label="正文显示方式">
          <button
            :class="{ active: viewMode === 'original' }"
            :aria-pressed="viewMode === 'original'"
            @click="viewMode = 'original'"
          >
            原始排版
          </button>
          <button
            :class="{ active: viewMode === 'reader' }"
            :aria-pressed="viewMode === 'reader'"
            @click="viewMode = 'reader'"
          >
            阅读版
          </button>
        </div>
      </div>
    </header>

    <iframe
      v-if="canShowOriginal && viewMode === 'original'"
      :key="a.id"
      class="original-frame"
      :srcdoc="originalSrcdoc"
      sandbox="allow-popups allow-popups-to-escape-sandbox"
      title="微信公众号原始排版"
    ></iframe>

    <div v-else class="reading-scroll">
      <!-- eslint-disable-next-line vue/no-v-html -->
      <div v-if="bodyHtml" class="content" v-html="bodyHtml"></div>
      <div v-else class="content">
        <p class="placeholder">
          {{ digest || '正文尚未抓取。' }}<br />
          <span class="dim">（手动刷新时会重试抓取完整正文与原始排版）</span>
        </p>
      </div>
    </div>
  </div>
  <div v-else class="empty">
    <p>选择一篇文章查看</p>
    <p class="clock dim">{{ clockTime(Date.now()) }}</p>
  </div>
</template>

<style scoped>
.detail-shell {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}
.detail-header {
  flex: 0 0 auto;
  width: min(100%, 800px);
  margin: 0 auto;
  padding: 28px 40px 0;
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
  align-items: center;
  gap: 8px;
  margin-top: 20px;
  padding-bottom: 20px;
  border-bottom: 1px solid var(--border);
}
.content-mode {
  display: inline-flex;
  margin-left: auto;
  padding: 2px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-subtle);
}
.content-mode button {
  border: 0;
  padding: 3px 9px;
  color: var(--text-dim);
  background: transparent;
  box-shadow: none;
}
.content-mode button.active {
  color: var(--text);
  background: var(--bg-elevated);
  box-shadow: var(--shadow-sm);
}
.reading-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 0 40px 64px;
}
.content {
  width: min(100%, 720px);
  margin: 0 auto;
  padding-top: 20px;
  font-size: 15px;
  line-height: 1.8;
  color: var(--text);
}
.original-frame {
  display: block;
  flex: 1 1 auto;
  width: 100%;
  min-height: 0;
  border: 0;
  background: #fff;
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
@media (max-width: 720px) {
  .detail-header {
    padding-inline: 20px;
  }
  .reading-scroll {
    padding-inline: 20px;
  }
  .actions {
    flex-wrap: wrap;
  }
  .content-mode {
    width: 100%;
    margin-left: 0;
  }
  .content-mode button {
    flex: 1;
  }
}
</style>
