<script setup lang="ts">
// 更新提示条：用户确认下载后显示进度，下载好后可重启安装。见 docs/release.md。
import { computed } from 'vue'
import { store } from '../stores/app'

const u = computed(() => store.state.update)
</script>

<template>
  <div v-if="u && (u.state === 'downloading' || u.state === 'ready')" class="banner" :class="u.state">
    <template v-if="u.state === 'downloading'">
      正在下载新版本 {{ u.version || '' }}… {{ u.percent ?? 0 }}%
    </template>
    <template v-else-if="u.state === 'ready'">
      新版本 {{ u.version }} 已就绪
      <button class="primary" @click="store.installUpdate()">重启并更新</button>
    </template>
  </div>
</template>

<style scoped>
.banner {
  position: fixed;
  bottom: 14px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 200;
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 16px;
  border-radius: 999px;
  background: var(--bg-elevated);
  border: 1px solid var(--border-strong);
  box-shadow: var(--shadow-md);
  font-size: 13px;
}
.banner.ready {
  border-color: var(--accent);
}
button {
  padding: 3px 12px;
}
</style>
