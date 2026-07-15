<script setup lang="ts">
// 右栏：文章详情。微信文章可切换“原始排版 HTML / Markdown 阅读版”。
import { computed, ref, watch } from 'vue'
import { store } from '../stores/app'
import { clockTime } from '../util'
import { renderMarkdown } from '../markdown'
import { buildWechatSrcdoc } from '../wechat-html'
import { userFacingError } from '../../../shared/errors'

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
const reprocessBusy = ref(false)
const reprocessMessage = ref('')
const reprocessMessageKind = ref<'success' | 'error'>('success')
const maintenanceBusy = computed(() => store.state.articleMaintenanceBusy)

watch(
  () => ({ id: a.value?.id, canShowOriginal: canShowOriginal.value }),
  (next, previous) => {
    if (!next.canShowOriginal) viewMode.value = 'reader'
    else if (next.id !== previous?.id || !previous?.canShowOriginal) viewMode.value = 'reader'
  },
  { immediate: true }
)

watch(
  () => a.value?.id,
  () => {
    reprocessMessage.value = ''
  }
)

function openOriginal(): void {
  if (a.value?.sourceUrl) window.open(a.value.sourceUrl, '_blank')
}
function archive(): void {
  if (a.value) void window.api.article.archive(a.value.id).then(() => store.refreshAll())
}
async function reprocess(): Promise<void> {
  const articleId = a.value?.id
  if (!articleId || maintenanceBusy.value) return

  reprocessBusy.value = true
  reprocessMessage.value = ''
  try {
    const result = await store.reprocessArticles({
      mode: 'network',
      scope: 'article',
      articleId
    })
    if (a.value?.id !== articleId) return

    const failed = result.items.find((item) => item.status === 'failed')
    const skipped = result.items.find((item) => item.status === 'skipped')
    if (result.failed > 0) {
      reprocessMessageKind.value = 'error'
      reprocessMessage.value = userFacingError(failed?.message, '重抓本篇失败')
    } else if (result.updated > 0) {
      reprocessMessageKind.value = 'success'
      reprocessMessage.value = '本篇重抓完成，正文已更新。'
    } else if (result.unchanged > 0) {
      reprocessMessageKind.value = 'success'
      reprocessMessage.value = '本篇重抓完成，正文没有变化。'
    } else if (result.skipped > 0) {
      reprocessMessageKind.value = 'error'
      reprocessMessage.value = userFacingError(skipped?.message, '这篇文章暂时无法重抓')
    } else {
      reprocessMessageKind.value = 'error'
      reprocessMessage.value = '没有找到可重抓的本机文章。'
    }
  } catch (error) {
    if (a.value?.id !== articleId) return
    reprocessMessageKind.value = 'error'
    reprocessMessage.value = userFacingError(error, '重抓本篇失败')
  } finally {
    reprocessBusy.value = false
  }
}
function publishedDate(ts: number): string {
  return ts ? new Date(ts).toLocaleString() : ''
}
</script>

<template>
  <div v-if="a" class="detail-shell">
    <header class="detail-header">
      <div class="source-line">
        <span>{{ a.source.type === 'wechat' ? '微信公众号' : 'RSS' }}</span>
        <strong>{{ a.source.name }}</strong>
      </div>
      <h1>{{ a.title }}</h1>
      <p v-if="digest" class="deck">{{ digest }}</p>
      <div class="meta">
        <span v-if="author">{{ author }}</span>
        <span>{{ publishedDate(a.publishedAt) }}</span>
      </div>
      <div class="actions">
        <button class="primary" @click="openOriginal">查看原文</button>
        <button
          class="reprocess"
          :disabled="maintenanceBusy"
          title="只重新访问当前这一篇文章，不处理该来源其他历史"
          @click="reprocess"
        >
          {{ reprocessBusy ? '重抓本篇中…' : maintenanceBusy ? '历史任务进行中…' : '重抓本篇' }}
        </button>
        <button class="quiet" @click="archive">归档文章</button>
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
            沉浸阅读
          </button>
        </div>
      </div>
      <p
        v-if="reprocessMessage"
        class="reprocess-message"
        :class="reprocessMessageKind"
        role="status"
      >
        {{ reprocessMessage }}
      </p>
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
          <span class="dim">使用“重抓本篇”只处理当前文章；批量历史维护请前往“来源与抓取”。</span>
        </p>
      </div>
    </div>
  </div>
  <div v-else class="empty">
    <span class="empty-rule"></span>
    <p>从左侧选择一篇文章</p>
    <p class="clock dim">{{ clockTime(Date.now()) }} · 慢慢读</p>
  </div>
</template>

<style scoped>
.detail-shell {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: var(--bg-reading);
}
.detail-header {
  flex: 0 0 auto;
  width: min(100%, 860px);
  margin: 0 auto;
  padding: 38px 54px 0;
}
.source-line {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 12px;
}
.source-line span {
  padding: 2px 6px;
  border: 1px solid var(--border-strong);
  color: var(--accent-strong);
  font-size: 9.5px;
  font-weight: 700;
  letter-spacing: 0.4px;
}
.source-line strong {
  color: var(--text-secondary);
  font-size: 11.5px;
  font-weight: 600;
}
h1 {
  max-width: 760px;
  margin: 0 0 13px;
  font-family: var(--font-reading);
  font-size: clamp(25px, 2.7vw, 34px);
  font-weight: 680;
  line-height: 1.35;
  letter-spacing: -0.5px;
}
.deck {
  max-width: 720px;
  margin: 0 0 15px;
  color: var(--text-secondary);
  font-family: var(--font-reading);
  font-size: 14px;
  line-height: 1.75;
}
.meta {
  display: flex;
  gap: 14px;
  color: var(--text-dim);
  font-size: 11.5px;
  flex-wrap: wrap;
}
.actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 22px;
  padding-bottom: 18px;
  border-bottom: 1px solid var(--border);
}
.content-mode {
  display: inline-flex;
  margin-left: auto;
  padding: 2px;
  border: 1px solid var(--border);
  background: var(--bg-subtle);
}
.reprocess {
  color: var(--accent-strong);
}
.reprocess-message {
  margin: 10px 0 0;
  padding: 8px 10px;
  border-left: 3px solid var(--ok);
  background: color-mix(in srgb, var(--ok) 7%, transparent);
  color: var(--ok);
  font-size: 11.5px;
  line-height: 1.4;
}
.reprocess-message.error {
  border-left-color: var(--warn);
  color: var(--warn);
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
  background: var(--bg-active);
}
.reading-scroll {
  flex: 1 1 auto;
  min-height: 0;
  overflow-y: auto;
  padding: 0 54px 90px;
}
.content {
  width: min(100%, 690px);
  margin: 0 auto;
  padding-top: 30px;
  font-family: var(--font-reading);
  font-size: 16.5px;
  line-height: 1.95;
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
  margin: 0 0 20px;
}
.content :deep(h1),
.content :deep(h2),
.content :deep(h3) {
  font-family: var(--font);
  font-size: 20px;
  font-weight: 680;
  margin: 34px 0 14px;
  line-height: 1.45;
}
.content :deep(img) {
  max-width: 100%;
  height: auto;
  border: 1px solid var(--border);
  border-radius: 0;
  margin: 18px 0;
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
  margin: 22px 0;
  padding: 8px 18px;
  border-left: 3px solid var(--accent);
  background: var(--bg-subtle);
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
  color: var(--text-secondary);
  gap: 8px;
  background: var(--bg-reading);
  font-family: var(--font-reading);
}
.empty-rule {
  width: 48px;
  height: 1px;
  margin-bottom: 8px;
  background: var(--border-strong);
}
@media (max-width: 720px) {
  .detail-header {
    padding: 28px 22px 0;
  }
  .reading-scroll {
    padding-inline: 22px;
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
