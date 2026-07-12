<script setup lang="ts">
// 账号池 & 配额可视化 —— 监控场景的关键信息，常驻左栏底部。见 docs/wechat-monitor.md#五ux-重点。
import { computed } from 'vue'
import { store } from '../stores/app'
import { clockTime } from '../util'

const accounts = computed(() => store.state.accounts)
const nextRun = computed(() => store.state.progress.nextRunAt)

function pct(a: { requestsThisHour: number; hourLimit: number }): number {
  return Math.min(100, Math.round((a.requestsThisHour / a.hourLimit) * 100))
}
</script>

<template>
  <div class="quota">
    <div class="head">
      <span>账号池 ({{ accounts.length }})</span>
      <span v-if="nextRun" class="dim">下一轮 {{ clockTime(nextRun) }}</span>
    </div>

    <div v-if="!accounts.length" class="empty">
      未登录账号<br />
      <button class="primary" @click="store.login()">扫码登录</button>
      <div class="tip">
        仅使用手机微信扫描官方二维码，请勿在弹窗输入账号、密码或验证码。登录态只保存在本机。
      </div>
    </div>

    <div v-for="a in accounts" :key="a.id" class="acc">
      <div class="acc-top">
        <span class="name">{{ a.nickname || a.id }}</span>
        <span class="status" :class="a.status">
          <template v-if="a.status === 'active'">{{ a.requestsThisHour }}/{{ a.hourLimit }}</template>
          <template v-else-if="a.status === 'cooldown'">限流至 {{ clockTime(a.cooldownUntil) }}</template>
          <template v-else>登录失效</template>
        </span>
      </div>
      <div v-if="a.status === 'active'" class="bar">
        <div class="fill" :style="{ width: pct(a) + '%' }"></div>
      </div>
      <button v-else-if="a.status === 'expired'" class="relogin" @click="store.relogin(a.id)">
        重新登录
      </button>
    </div>

    <button v-if="accounts.length" class="add" @click="store.login()">
      + 登录一个号（提升采集上限）
    </button>
  </div>
</template>

<style scoped>
.quota {
  border-top: 1px solid var(--border);
  padding: 10px;
  font-size: 12px;
}
.head {
  display: flex;
  justify-content: space-between;
  color: var(--text-dim);
  margin-bottom: 8px;
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
</style>
