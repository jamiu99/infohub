<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type {
  ArticleMaintenanceMode,
  ArticleMaintenanceResult
} from '../../../shared/maintenance'
import { userFacingError } from '../../../shared/errors'
import { store } from '../stores/app'

type MaintenanceScope = 'source' | 'all'

const props = withDefaults(defineProps<{
  sourceId?: string | null
  scope?: MaintenanceScope
}>(), {
  sourceId: null,
  scope: 'source'
})

const selectedSource = computed(() =>
  store.state.sources.find((source) => source.id === props.sourceId)
)
const isAllSources = computed(() => props.scope === 'all')
const mode = ref<ArticleMaintenanceMode>('offline')
const confirmAllNetwork = ref(false)
const running = ref(false)
const message = ref('')
const messageKind = ref<'success' | 'warning' | 'error'>('success')
const result = ref<ArticleMaintenanceResult | null>(null)
const busy = computed(() => store.state.articleMaintenanceBusy)
const missingSource = computed(() => !isAllSources.value && !selectedSource.value)
const networkAllBlocked = computed(
  () => isAllSources.value && mode.value === 'network' && !confirmAllNetwork.value
)

const panelTitle = computed(() =>
  isAllSources.value ? '批量修复全部来源' : '修复这个来源已保存的文章'
)

const panelDescription = computed(() =>
  isAllSources.value
    ? '处理所有本机已保存的文章（包括归档文章）；不会检查来源中的新文章。'
    : '正文缺失或显示异常时使用；不会检查这个来源中的新文章。'
)

const scopeDescription = computed(() =>
  isAllSources.value
    ? '处理范围固定为全部本机来源，并包含已归档文章。'
    : selectedSource.value
      ? `处理范围固定为“${selectedSource.value.name}”。`
      : '请先从左侧选择一个来源。'
)

const actionLabel = computed(() => {
  if (mode.value === 'offline') {
    return isAllSources.value ? '修复全部已保存文章' : '修复这个来源的已保存文章'
  }
  return isAllSources.value ? '联网更新全部已保存文章' : '联网更新这个来源的已保存文章'
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

watch(mode, () => {
  confirmAllNetwork.value = false
  message.value = ''
  result.value = null
})

watch(
  () => props.sourceId,
  () => {
    message.value = ''
    result.value = null
  }
)

async function run(): Promise<void> {
  if (busy.value || running.value || networkAllBlocked.value || missingSource.value) return
  const sourceId = selectedSource.value?.id

  running.value = true
  message.value = mode.value === 'offline'
    ? '正在使用本机已保存的页面修复阅读正文…'
    : '正在逐篇访问原文并更新已保存的正文…'
  messageKind.value = 'success'
  result.value = null

  try {
    result.value = await store.reprocessArticles({
      mode: mode.value,
      scope: props.scope,
      ...(!isAllSources.value && sourceId ? { sourceId } : {})
    })
    messageKind.value = result.value.failed > 0 || result.value.skipped > 0
      ? 'warning'
      : 'success'
    message.value = result.value.total > 0
      ? (mode.value === 'offline' ? '已使用本机内容完成修复。' : '已完成联网更新。')
      : '没有找到符合当前范围、且支持这种修复方式的文章。'
  } catch (error) {
    messageKind.value = 'error'
    message.value = userFacingError(
      error,
      mode.value === 'offline' ? '使用本机内容修复失败' : '联网更新失败'
    )
  } finally {
    running.value = false
  }
}
</script>

<template>
  <details class="maintenance-card">
    <summary class="maintenance-summary">
      <span class="summary-copy">
        <strong>{{ panelTitle }}</strong>
        <small>{{ panelDescription }}</small>
      </span>
      <span class="disclosure-state" aria-hidden="true">
        <span class="when-closed">展开</span>
        <span class="when-open">收起</span>
      </span>
    </summary>

    <div class="maintenance-body">
      <p class="scope-note">
        <strong>{{ scopeDescription }}</strong>
        这里只修复已经保存的文章；不支持的内容会自动跳过。
      </p>

      <fieldset :disabled="busy || running || missingSource" class="choice-group">
        <legend>选择修复方式</legend>
        <label class="choice mode-choice">
          <input v-model="mode" type="radio" value="offline" />
          <span>
            <strong>使用本机保存的页面</strong>
            <small>不联网；适合正文显示异常或软件更新后重新生成阅读内容</small>
          </span>
          <em>不联网</em>
        </label>
        <label class="choice mode-choice">
          <input v-model="mode" type="radio" value="network" />
          <span>
            <strong>重新访问原文</strong>
            <small>逐篇访问文章原地址并更新正文；可能耗时，也可能遇到平台访问限制</small>
          </span>
          <em class="network">需联网</em>
        </label>
      </fieldset>

      <label v-if="isAllSources && mode === 'network'" class="risk-confirm">
        <input v-model="confirmAllNetwork" type="checkbox" />
        <span>我确认要逐篇联网访问全部已保存文章；这个过程可能持续较长时间。</span>
      </label>

      <div class="run-row">
        <div class="run-summary">
          <strong>{{ scopeDescription }}</strong>
          <span>{{ mode === 'offline' ? '使用本机内容，不联网' : '逐篇访问原文' }}</span>
        </div>
        <button
          class="primary"
          :disabled="busy || running || missingSource || networkAllBlocked"
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
    </div>
  </details>
</template>

<style scoped>
.maintenance-card {
  border: 1px solid var(--border);
  background: var(--bg-subtle);
}
.maintenance-summary {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 15px;
  cursor: pointer;
  list-style: none;
}
.maintenance-summary::-webkit-details-marker {
  display: none;
}
.maintenance-summary:hover {
  background: var(--bg-hover);
}
.summary-copy {
  display: flex;
  min-width: 0;
  flex-direction: column;
}
.summary-copy strong {
  font-size: 13px;
}
.summary-copy small {
  margin-top: 4px;
  color: var(--text-dim);
  font-size: 11px;
  line-height: 1.5;
}
.disclosure-state {
  flex: 0 0 auto;
  color: var(--accent-strong);
  font-size: 11px;
}
.when-open {
  display: none;
}
.maintenance-card[open] .when-closed {
  display: none;
}
.maintenance-card[open] .when-open {
  display: inline;
}
.maintenance-body {
  padding: 0 15px 15px;
  border-top: 1px solid var(--border);
}
.scope-note {
  margin: 14px 0 0;
  padding: 9px 10px;
  background: var(--bg-elevated);
  color: var(--text-dim);
  font-size: 11px;
  line-height: 1.55;
}
.scope-note strong {
  color: var(--text-secondary);
}
.choice-group {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 8px;
  margin: 15px 0 0;
  padding: 0;
  border: 0;
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
.result.warning {
  border-left-color: var(--warn);
  color: var(--warn);
  background: color-mix(in srgb, var(--warn) 7%, var(--bg-elevated));
}
.result.error {
  border-left-color: var(--danger);
  color: var(--danger);
  background: color-mix(in srgb, var(--danger) 7%, var(--bg-elevated));
}
.result p,
.result ul {
  margin: 4px 0 0;
  font-size: 12px;
  line-height: 1.6;
}
.result ul {
  padding-left: 18px;
}
.result .more {
  color: var(--text-dim);
  font-size: 10.5px;
}
@media (max-width: 760px) {
  .choice-group {
    grid-template-columns: 1fr;
  }
  .run-row {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>
