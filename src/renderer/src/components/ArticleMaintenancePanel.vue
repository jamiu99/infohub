<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type {
  ArticleMaintenanceMode,
  ArticleMaintenanceResult
} from '../../../shared/maintenance'
import { userFacingError } from '../../../shared/errors'
import { store } from '../stores/app'

type MaintenanceScope = 'source' | 'all'

const selectedSource = computed(() =>
  store.state.sources.find((source) => source.id === store.state.selectedSourceId)
)
const scope = ref<MaintenanceScope>(selectedSource.value ? 'source' : 'all')
const runningMode = ref<ArticleMaintenanceMode | null>(null)
const message = ref('')
const messageKind = ref<'success' | 'warning' | 'error'>('success')
const result = ref<ArticleMaintenanceResult | null>(null)
const busy = computed(() => store.state.articleMaintenanceBusy)

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
  () => store.state.selectedSourceId,
  (sourceId) => {
    if (!sourceId && scope.value === 'source') scope.value = 'all'
  }
)

async function run(mode: ArticleMaintenanceMode): Promise<void> {
  if (busy.value) return
  const sourceId = selectedSource.value?.id
  if (scope.value === 'source' && !sourceId) {
    messageKind.value = 'error'
    message.value = '请先在主界面选择一个信源，或改为处理全部本机文章。'
    return
  }

  runningMode.value = mode
  message.value = mode === 'offline'
    ? '正在读取本机快照并重新解析，请稍候…'
    : '正在逐篇访问原文，文章较多时可能需要一段时间…'
  messageKind.value = 'success'
  result.value = null

  try {
    result.value = await store.reprocessArticles({
      mode,
      scope: scope.value,
      ...(scope.value === 'source' && sourceId ? { sourceId } : {})
    })
    messageKind.value = result.value.failed > 0 || result.value.skipped > 0
      ? 'warning'
      : 'success'
    message.value = result.value.total > 0
      ? (mode === 'offline' ? '本机快照重新解析完成。' : '原文重新抓取完成。')
      : '没有找到符合当前范围的本机文章。'
  } catch (error) {
    messageKind.value = 'error'
    message.value = userFacingError(
      error,
      mode === 'offline' ? '本机快照重新解析失败' : '重新访问原文失败'
    )
  } finally {
    runningMode.value = null
  }
}
</script>

<template>
  <section class="maintenance-card">
    <div class="heading">
      <div>
        <strong>历史正文维护</strong>
        <p>修复旧文章的正文解析，或重新访问原文获取最新可用页面。</p>
      </div>
    </div>

    <fieldset :disabled="busy" class="scope-picker">
      <legend>处理范围</legend>
      <label :class="{ disabled: !selectedSource }">
        <input v-model="scope" type="radio" value="source" :disabled="!selectedSource" />
        <span>
          当前选中信源
          <small>{{ selectedSource ? `（${selectedSource.name}）` : '（主界面尚未选择）' }}</small>
        </span>
      </label>
      <label>
        <input v-model="scope" type="radio" value="all" />
        <span>全部本机文章</span>
      </label>
    </fieldset>

    <div class="actions">
      <button class="primary" :disabled="busy" @click="run('offline')">
        {{ runningMode === 'offline' ? '正在重新解析…' : '用本机快照重新解析（不联网）' }}
      </button>
      <button :disabled="busy" @click="run('network')">
        {{ runningMode === 'network' ? '正在访问原文…' : '重新访问原文' }}
      </button>
    </div>

    <div class="notice">
      <p>离线解析只会重建展示用正文，不修改原始快照。</p>
      <p class="risk">联网重抓会逐篇访问原网站，可能耗时较长并触发站点限流；请勿频繁对全部文章执行。</p>
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
  margin-top: 16px;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--bg-subtle);
}
.heading p,
.notice p,
.result p,
.result ul {
  margin: 4px 0 0;
  font-size: 12px;
  line-height: 1.55;
}
.heading p,
.notice {
  color: var(--text-dim);
}
.scope-picker {
  display: grid;
  gap: 8px;
  margin: 16px 0 0;
  padding: 14px 0 0;
  border: 0;
  border-top: 1px solid var(--border);
}
.scope-picker legend {
  float: left;
  width: 100%;
  margin-bottom: 8px;
  color: var(--text-secondary);
  font-size: 12px;
}
.scope-picker label {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
}
.scope-picker label.disabled {
  color: var(--text-dim);
}
.scope-picker small {
  color: var(--text-dim);
  font-size: 11.5px;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-top: 16px;
}
.actions button {
  min-height: 32px;
}
.notice {
  margin-top: 12px;
}
.notice .risk {
  color: color-mix(in srgb, var(--warn) 82%, var(--text));
}
.result {
  margin-top: 14px;
  padding: 10px 12px;
  border: 1px solid color-mix(in srgb, var(--ok) 35%, var(--border));
  border-radius: var(--radius-sm);
  color: var(--ok);
  background: color-mix(in srgb, var(--ok) 6%, transparent);
}
.result.warning,
.result.error {
  border-color: color-mix(in srgb, var(--warn) 38%, var(--border));
  color: var(--warn);
  background: color-mix(in srgb, var(--warn) 6%, transparent);
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
@media (max-width: 620px) {
  .actions {
    flex-direction: column;
  }
  .actions button {
    width: 100%;
  }
}
</style>
