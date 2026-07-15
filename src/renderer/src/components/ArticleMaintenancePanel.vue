<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type {
  ArticleMaintenanceMode,
  ArticleMaintenanceResult
} from '../../../shared/maintenance'
import { userFacingError } from '../../../shared/errors'
import { store } from '../stores/app'

type MaintenanceScope = 'source' | 'all'

const props = defineProps<{ sourceId?: string | null }>()
const selectedSource = computed(() =>
  store.state.sources.find((source) => source.id === props.sourceId)
)
const scope = ref<MaintenanceScope>(props.sourceId ? 'source' : 'all')
const mode = ref<ArticleMaintenanceMode>('offline')
const confirmAllNetwork = ref(false)
const running = ref(false)
const message = ref('')
const messageKind = ref<'success' | 'warning' | 'error'>('success')
const result = ref<ArticleMaintenanceResult | null>(null)
const busy = computed(() => store.state.articleMaintenanceBusy)
const networkAllBlocked = computed(
  () => scope.value === 'all' && mode.value === 'network' && !confirmAllNetwork.value
)

const actionLabel = computed(() => {
  const range = scope.value === 'source' ? '该来源' : '全部来源'
  return mode.value === 'offline'
    ? `离线重解析${range}历史`
    : `联网重抓${range}已入库历史`
})

const resultSummary = computed(() => {
  const value = result.value
  if (!value) return ''
  return `共处理 ${value.total} 篇：更新 ${value.updated} 篇，无变化 ${value.unchanged} 篇，失败 ${value.failed} 篇，跳过 ${value.skipped} 篇。`
})

const failedItems = computed(() =>
  (result.value?.items ?? [])
    .filter((item) => item.status === 'failed' || item.status === 'skipped')
    .slice(0, 3)
    .map((item) => ({
      ...item,
      description: userFacingError(
        item.message,
        item.status === 'failed' ? '正文处理失败' : '已跳过这篇文章'
      )
    }))
)

watch(
  () => props.sourceId,
  (sourceId) => {
    if (!sourceId && scope.value === 'source') scope.value = 'all'
  }
)

watch([scope, mode], () => {
  confirmAllNetwork.value = false
  message.value = ''
  result.value = null
})

async function run(): Promise<void> {
  if (busy.value || running.value || networkAllBlocked.value) return
  const sourceId = selectedSource.value?.id
  if (scope.value === 'source' && !sourceId) {
    messageKind.value = 'error'
    message.value = '请先从左侧选择一个来源，或改为处理全部来源。'
    return
  }

  running.value = true
  message.value = mode.value === 'offline'
    ? '正在读取不可变本机快照并重建正文…'
    : '正在逐篇访问已入库文章的原文地址…'
  messageKind.value = 'success'
  result.value = null

  try {
    result.value = await store.reprocessArticles({
      mode: mode.value,
      scope: scope.value,
      ...(scope.value === 'source' && sourceId ? { sourceId } : {})
    })
    messageKind.value = result.value.failed > 0 || result.value.skipped > 0
      ? 'warning'
      : 'success'
    message.value = result.value.total > 0
      ? (mode.value === 'offline' ? '本机历史正文重新解析完成。' : '已入库历史正文联网重抓完成。')
      : '没有找到符合当前范围、且支持这种处理方式的本机文章。'
  } catch (error) {
    messageKind.value = 'error'
    message.value = userFacingError(
      error,
      mode.value === 'offline' ? '本机快照重新解析失败' : '历史正文联网重抓失败'
    )
  } finally {
    running.value = false
  }
}
</script>

<template>
  <section class="maintenance-card">
    <header class="heading">
      <div>
        <span class="kicker">HISTORY</span>
        <strong>处理已入库历史</strong>
        <p>这里不会发现从未入库的更早文章；单篇正文请在阅读页使用“重抓本篇”。</p>
      </div>
    </header>

    <fieldset :disabled="busy || running" class="choice-group">
      <legend>第一步 · 选择范围</legend>
      <label class="choice" :class="{ disabled: !selectedSource }">
        <input v-model="scope" type="radio" value="source" :disabled="!selectedSource" />
        <span>
          <strong>单个来源</strong>
          <small>{{ selectedSource ? selectedSource.name : '先从左侧选择来源' }}</small>
        </span>
      </label>
      <label class="choice">
        <input v-model="scope" type="radio" value="all" />
        <span>
          <strong>全部来源</strong>
          <small>全部本机贡献的已入库文章，包含已归档文章</small>
        </span>
      </label>
    </fieldset>

    <fieldset :disabled="busy || running" class="choice-group mode-group">
      <legend>第二步 · 选择处理方式</legend>
      <label class="choice mode-choice">
        <input v-model="mode" type="radio" value="offline" />
        <span>
          <strong>本机快照重新解析</strong>
          <small>不联网，不改 Raw；适合解析器升级后批量重建阅读正文</small>
        </span>
        <em>安全</em>
      </label>
      <label class="choice mode-choice">
        <input v-model="mode" type="radio" value="network" />
        <span>
          <strong>联网重抓已入库正文</strong>
          <small>逐篇访问现有文章 URL；不翻页发现未入库历史，可能触发限流</small>
        </span>
        <em class="network">联网</em>
      </label>
    </fieldset>

    <label v-if="scope === 'all' && mode === 'network'" class="risk-confirm">
      <input v-model="confirmAllNetwork" type="checkbox" />
      <span>我确认要逐篇联网访问全部已入库历史；任务可能耗时较长。</span>
    </label>

    <div class="run-row">
      <div class="run-summary">
        <strong>{{ scope === 'source' ? `范围：${selectedSource?.name || '未选择'}` : '范围：全部本机来源' }}</strong>
        <span>{{ mode === 'offline' ? '网络：不联网' : '网络：逐篇访问原文' }}</span>
      </div>
      <button
        class="primary"
        :disabled="busy || running || networkAllBlocked || (scope === 'source' && !selectedSource)"
        @click="run"
      >
        {{ running ? '处理中…' : actionLabel }}
      </button>
    </div>

    <div
      v-if="message"
      class="result"
      :class="messageKind"
      role="status"
      aria-live="polite"
    >
      <strong>{{ message }}</strong>
      <p v-if="resultSummary">{{ resultSummary }}</p>
      <ul v-if="failedItems.length">
        <li v-for="item in failedItems" :key="item.articleId">
          {{ item.title }}：{{ item.description }}
        </li>
      </ul>
      <p v-if="result && failedItems.length < result.failed + result.skipped" class="more">
        另有 {{ result.failed + result.skipped - failedItems.length }} 篇未展开。
      </p>
    </div>
  </section>
</template>

<style scoped>
.maintenance-card {
  padding: 17px;
  border: 1px solid var(--border);
  background: var(--bg-subtle);
}
.heading strong {
  display: block;
  font-size: 14px;
}
.heading p,
.result p,
.result ul {
  margin: 4px 0 0;
  font-size: 12px;
  line-height: 1.6;
}
.heading p {
  color: var(--text-dim);
}
.kicker {
  display: block;
  margin-bottom: 4px;
  color: var(--accent);
  font-size: 9px;
  font-weight: 800;
  letter-spacing: 1px;
}
.choice-group {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  margin: 16px 0 0;
  padding: 14px 0 0;
  border: 0;
  border-top: 1px solid var(--border);
}
.choice-group legend {
  float: left;
  width: 100%;
  margin-bottom: 9px;
  color: var(--text-secondary);
  font-size: 11px;
  font-weight: 650;
}
.choice {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  min-width: 0;
  padding: 10px;
  border: 1px solid var(--border);
  background: var(--bg-elevated);
  cursor: pointer;
}
.choice:has(input:checked) {
  border-color: var(--accent);
  background: var(--accent-soft);
}
.choice.disabled {
  opacity: 0.55;
  cursor: default;
}
.choice span {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
}
.choice strong {
  font-size: 12px;
  font-weight: 650;
}
.choice small {
  margin-top: 3px;
  color: var(--text-dim);
  font-size: 10.5px;
  line-height: 1.45;
}
.mode-choice em {
  flex: 0 0 auto;
  padding: 1px 5px;
  border: 1px solid color-mix(in srgb, var(--ok) 40%, var(--border));
  color: var(--ok);
  font-size: 9px;
  font-style: normal;
}
.mode-choice em.network {
  border-color: color-mix(in srgb, var(--warn) 42%, var(--border));
  color: var(--warn);
}
.risk-confirm {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-top: 12px;
  padding: 10px;
  border-left: 3px solid var(--warn);
  background: color-mix(in srgb, var(--warn) 7%, var(--bg-elevated));
  color: var(--text-secondary);
  font-size: 11px;
  line-height: 1.5;
}
.run-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-top: 16px;
}
.run-summary {
  display: flex;
  min-width: 0;
  flex-direction: column;
}
.run-summary strong {
  overflow: hidden;
  font-size: 11.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.run-summary span {
  margin-top: 2px;
  color: var(--text-dim);
  font-size: 10.5px;
}
.run-row button {
  flex: 0 0 auto;
}
.result {
  margin-top: 14px;
  padding: 10px 12px;
  border-left: 3px solid var(--ok);
  color: var(--ok);
  background: color-mix(in srgb, var(--ok) 7%, var(--bg-elevated));
}
.result.warning,
.result.error {
  border-left-color: var(--warn);
  color: var(--warn);
  background: color-mix(in srgb, var(--warn) 7%, var(--bg-elevated));
}
.result p,
.result ul {
  color: var(--text-secondary);
}
.result ul {
  padding-left: 18px;
}
.result .more {
  color: var(--text-dim);
}
@media (max-width: 680px) {
  .choice-group {
    grid-template-columns: 1fr;
  }
  .run-row {
    align-items: stretch;
    flex-direction: column;
  }
}
</style>
