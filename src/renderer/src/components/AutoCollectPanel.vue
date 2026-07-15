<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { store } from '../stores/app'
import { userFacingError } from '../../../shared/errors'

const enabled = ref(false)
const intervalMinutes = ref(240)
const saving = ref(false)
const error = ref('')

const settings = computed(() => store.state.collectionSettings)
const status = computed(() => store.state.collectionStatus)
const loadError = computed(
  () => store.state.collectionSettingsError || store.state.collectionStatusError
)

watch(
  settings,
  (value) => {
    if (!value) return
    enabled.value = value.autoCollectEnabled
    intervalMinutes.value = value.intervalMinutes
  },
  { immediate: true }
)

const statusText = computed(() => {
  const value = status.value
  if (!value || !value.enabled || value.state === 'disabled') return '当前关闭，只在你手动“拉取最新”时采集。'
  if (value.state === 'running') return '正在执行本轮自动采集。'
  const nextRun = value.nextRunAt
    ? `下一轮：${new Date(value.nextRunAt).toLocaleString()}`
    : ''
  if (value.message) return nextRun ? `${value.message} ${nextRun}` : value.message
  if (value.state === 'error') return '上一轮自动采集出现异常。'
  if (value.state === 'paused') return '自动采集暂时暂停。'
  if (value.nextRunAt) return `下一轮：${new Date(value.nextRunAt).toLocaleString()}`
  return '已开启，下一轮将在完整周期后开始。'
})

async function save(): Promise<void> {
  if (saving.value) return
  const previous = settings.value
    ? {
        autoCollectEnabled: settings.value.autoCollectEnabled,
        intervalMinutes: settings.value.intervalMinutes
      }
    : null
  saving.value = true
  error.value = ''
  try {
    await store.updateCollectionSettings({
      autoCollectEnabled: enabled.value,
      intervalMinutes: intervalMinutes.value
    })
  } catch (cause) {
    if (previous) {
      enabled.value = previous.autoCollectEnabled
      intervalMinutes.value = previous.intervalMinutes
    }
    error.value = userFacingError(cause, '自动采集设置保存失败')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <section class="auto-card">
    <div class="heading">
      <div>
        <strong>自动采集内容</strong>
        <p>定时拉取已启用公众号和 RSS 的最新列表；不会回溯未入库历史。</p>
      </div>
      <label class="toggle">
        <input v-model="enabled" type="checkbox" :disabled="saving" @change="save" />
        <span>{{ enabled ? '已开启' : '已关闭' }}</span>
      </label>
    </div>

    <label class="interval-row">
      <span>采集频率</span>
      <select v-model.number="intervalMinutes" :disabled="!enabled || saving" @change="save">
        <option :value="60">每 1 小时（较频繁）</option>
        <option :value="120">每 2 小时（较频繁）</option>
        <option :value="240">每 4 小时（推荐）</option>
        <option :value="480">每 8 小时</option>
        <option :value="720">每 12 小时</option>
        <option :value="1440">每天</option>
        <option :value="10080">每 7 天</option>
      </select>
    </label>

    <p class="status" :class="status?.state">{{ statusText }}</p>
    <p class="hint">关闭应用或电脑睡眠期间不会补抓；唤醒后会重新等待一个完整周期。所有请求仍受账号小时上限、全局串行和微信请求间隔保护。</p>
    <p v-if="loadError" class="error">{{ loadError }}</p>
    <p v-if="error" class="error">{{ error }}</p>
  </section>
</template>

<style scoped>
.auto-card {
  margin-top: 16px;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--bg-subtle);
}
.heading,
.interval-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 20px;
}
.heading p,
.status,
.hint,
.error {
  margin: 4px 0 0;
  font-size: 12px;
  line-height: 1.55;
}
.heading p,
.hint {
  color: var(--text-dim);
}
.toggle {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  flex: 0 0 auto;
}
.interval-row {
  margin-top: 16px;
  padding-top: 14px;
  border-top: 1px solid var(--border);
  font-size: 13px;
}
.interval-row select {
  width: min(230px, 60%);
}
.status {
  margin-top: 14px;
  color: var(--accent);
}
.status.error,
.error {
  color: var(--warn);
}
@media (max-width: 620px) {
  .heading,
  .interval-row {
    align-items: flex-start;
    flex-direction: column;
    gap: 10px;
  }
  .interval-row select {
    width: 100%;
  }
}
</style>
