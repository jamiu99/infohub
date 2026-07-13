<script setup lang="ts">
// 账号池 & 配额可视化 —— 集中放在设置弹窗，避免挤占日常阅读界面。
import { computed, ref, watch } from 'vue'
import { store } from '../stores/app'
import { clockTime, dateTime } from '../util'
import { userFacingError } from '../../../shared/errors'

const accounts = computed(() => store.state.accounts)
const nextRun = computed(() => store.state.progress.nextRunAt)
const settings = computed(() => store.state.wechatSettings)
const limitDraft = ref('20')
const saving = ref(false)
const saveMessage = ref('')
const saveError = ref('')
const accountAction = ref<string | null>(null)
const accountError = ref('')

watch(
  () => settings.value?.hourlyRequestLimit,
  (value) => {
    if (value !== undefined) limitDraft.value = String(value)
  },
  { immediate: true }
)

function pct(a: { requestsThisHour: number; hourLimit: number }): number {
  return Math.min(100, Math.round((a.requestsThisHour / a.hourLimit) * 100))
}

async function saveLimit(): Promise<void> {
  const current = settings.value
  if (!current) return
  saveMessage.value = ''
  saveError.value = ''
  const value = Number(limitDraft.value)
  if (
    !Number.isInteger(value) ||
    value < current.minHourlyRequestLimit ||
    value > current.maxHourlyRequestLimit
  ) {
    saveError.value = `请输入 ${current.minHourlyRequestLimit}–${current.maxHourlyRequestLimit} 的整数`
    return
  }
  saving.value = true
  try {
    await store.setHourlyRequestLimit(value)
    saveMessage.value = '已保存，立即生效'
  } catch (error) {
    saveError.value = userFacingError(error, '保存采集上限失败')
  } finally {
    saving.value = false
  }
}

async function login(): Promise<void> {
  accountError.value = ''
  accountAction.value = 'login'
  try {
    await store.login()
  } catch (error) {
    accountError.value = userFacingError(error, '打开扫码登录失败')
  } finally {
    accountAction.value = null
  }
}

async function relogin(id: string): Promise<void> {
  accountError.value = ''
  accountAction.value = id
  try {
    await store.relogin(id)
  } catch (error) {
    accountError.value = userFacingError(error, '重新登录失败')
  } finally {
    accountAction.value = null
  }
}
</script>

<template>
  <div class="quota">
    <div class="head">
      <span>账号池 ({{ accounts.length }})</span>
      <span v-if="nextRun" class="dim">下一轮 {{ clockTime(nextRun) }}</span>
    </div>

    <div v-if="settings" class="limit-setting">
      <label for="wechat-hour-limit">每账号每小时上限</label>
      <div class="limit-editor">
        <input
          id="wechat-hour-limit"
          v-model="limitDraft"
          type="number"
          :min="settings.minHourlyRequestLimit"
          :max="settings.maxHourlyRequestLimit"
          step="1"
          @keyup.enter="saveLimit"
        />
        <button :disabled="saving" @click="saveLimit">{{ saving ? '保存中' : '保存' }}</button>
      </div>
      <div
        class="setting-tip"
        :class="{ warning: Number(limitDraft) > settings.recommendedMaxHourlyRequestLimit }"
      >
        默认 20；超过 {{ settings.recommendedMaxHourlyRequestLimit }} 更容易触发微信风控。
      </div>
      <div v-if="saveMessage" class="save-message">{{ saveMessage }}</div>
      <div v-if="saveError" class="save-error">{{ saveError }}</div>
    </div>

    <div v-if="!accounts.length" class="empty">
      未登录账号<br />
      <button class="primary" :disabled="accountAction !== null" @click="login">
        {{ accountAction === 'login' ? '正在打开…' : '扫码登录' }}
      </button>
      <div class="tip">
        仅使用手机微信扫描官方二维码，请勿在弹窗输入账号、密码或验证码。登录态只保存在本机。
      </div>
    </div>

    <div v-for="a in accounts" :key="a.id" class="acc">
      <div class="acc-top">
        <span class="name">{{ a.nickname || a.id }}</span>
        <span class="status" :class="a.status">
          <template v-if="a.status === 'active'">可用</template>
          <template v-else-if="a.status === 'cooldown'">限流至 {{ clockTime(a.cooldownUntil) }}</template>
          <template v-else>登录失效</template>
        </span>
      </div>
      <div class="metrics">
        <span>本小时 {{ a.requestsThisHour }}/{{ a.hourLimit }}</span>
        <span>累计 {{ a.totalRequests }}</span>
      </div>
      <div v-if="a.status !== 'expired'" class="bar">
        <div class="fill" :style="{ width: pct(a) + '%' }"></div>
      </div>
      <div v-if="a.lastRateLimitedAt" class="limit-record">
        最近限流：本小时第 {{ a.requestsAtLastRateLimit }} 次
        <template v-if="a.totalRequestsAtLastRateLimit !== undefined">
          · 累计第 {{ a.totalRequestsAtLastRateLimit }} 次
        </template>
        · {{ dateTime(a.lastRateLimitedAt) }}
      </div>
      <div v-else class="observation-empty">测试观测：尚未触发 200013 限流</div>
      <button
        v-if="a.status === 'expired'"
        class="relogin"
        :disabled="accountAction !== null"
        @click="relogin(a.id)"
      >
        {{ accountAction === a.id ? '正在打开…' : '重新登录' }}
      </button>
    </div>

    <div v-if="accountError" class="account-error">{{ accountError }}</div>
    <button v-if="accounts.length" class="add" :disabled="accountAction !== null" @click="login">
      {{ accountAction === 'login' ? '正在打开扫码窗口…' : '+ 登录一个号（提升采集上限）' }}
    </button>
  </div>
</template>

<style scoped>
.quota {
  padding: 0;
  font-size: 12px;
}
.head {
  display: flex;
  justify-content: space-between;
  color: var(--text-dim);
  margin-bottom: 8px;
}
.limit-setting {
  padding: 8px;
  margin-bottom: 10px;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-subtle);
}
.limit-setting label {
  display: block;
  margin-bottom: 5px;
  color: var(--text-secondary);
}
.limit-editor {
  display: grid;
  grid-template-columns: 1fr auto;
  gap: 6px;
}
.limit-editor input {
  min-width: 0;
  padding: 4px 7px;
}
.limit-editor button {
  padding: 4px 9px;
}
.setting-tip,
.save-message,
.save-error {
  margin-top: 5px;
  font-size: 11px;
  line-height: 1.4;
  color: var(--text-dim);
}
.setting-tip.warning,
.save-error,
.account-error {
  color: var(--warn);
}
.save-message {
  color: var(--ok);
}
.dim {
  color: var(--text-dim);
}
.empty {
  text-align: center;
  color: var(--text-dim);
  line-height: 2;
}
.tip {
  font-size: 11px;
  line-height: 1.5;
  margin-top: 6px;
  opacity: 0.8;
}
.acc {
  margin-bottom: 8px;
}
.acc-top {
  display: flex;
  justify-content: space-between;
}
.metrics {
  display: flex;
  justify-content: space-between;
  margin-top: 3px;
  color: var(--text-dim);
  font-variant-numeric: tabular-nums;
}
.name {
  font-weight: 500;
}
.status.active {
  color: var(--ok);
}
.status.cooldown {
  color: var(--cooldown);
}
.status.expired {
  color: var(--warn);
}
.bar {
  height: 5px;
  background: var(--border);
  border-radius: 3px;
  margin-top: 3px;
  overflow: hidden;
}
.fill {
  height: 100%;
  background: var(--accent);
}
.limit-record {
  margin-top: 5px;
  padding: 5px 6px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--cooldown) 10%, transparent);
  color: var(--cooldown);
  font-size: 11px;
  line-height: 1.45;
}
.observation-empty {
  margin-top: 4px;
  color: var(--text-dim);
  font-size: 11px;
}
.relogin {
  margin-top: 4px;
  width: 100%;
  color: var(--warn);
  border-color: var(--warn);
}
.add {
  width: 100%;
  margin-top: 4px;
  color: var(--text-dim);
}
.account-error {
  margin: 8px 0;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--warn) 9%, transparent);
  line-height: 1.5;
}
</style>
