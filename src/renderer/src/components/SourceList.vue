<script setup lang="ts">
// 左栏：源列表（状态点+名称+未读徽标）+ 底部账号池配额条。见 docs/wechat-monitor.md#二主界面。
import { ref, computed } from 'vue'
import { store } from '../stores/app'
import QuotaPanel from './QuotaPanel.vue'
import AddSourceDialog from './AddSourceDialog.vue'

const showAdd = ref(false)
const sources = computed(() => store.state.sources)
const unread = computed(() => store.state.unread)
const selected = computed(() => store.state.selectedSourceId)

// 该号是否抓取告警：所有账号都不可用时给个 ⚠ 视觉暗示（简化：无 active 账号即告警）
const hasWarn = computed(() => !store.state.accounts.some((a) => a.status === 'active'))

function dot(sourceId: string): string {
  if (hasWarn.value) return 'warn'
  return (unread.value[sourceId] ?? 0) > 0 ? 'unread' : 'read'
}
</script>

<template>
  <div class="wrap">
    <div class="brand">infohub</div>

    <div class="all" :class="{ active: selected === null }" @click="store.selectSource(null)">
      <span>全部</span>
      <button class="refresh" title="刷新全部" @click.stop="store.refresh()">⟳</button>
    </div>

    <ul class="list">
      <li
        v-for="s in sources"
        :key="s.id"
        :class="{ active: selected === s.id }"
        @click="store.selectSource(s.id)"
      >
        <span class="dot" :class="dot(s.id)"></span>
        <span class="name">{{ s.name }}</span>
        <span v-if="unread[s.id]" class="badge">{{ unread[s.id] }}</span>
      </li>
    </ul>

    <button class="add" @click="showAdd = true">+ 加公众号</button>

    <div class="spacer"></div>
    <QuotaPanel />

    <AddSourceDialog v-if="showAdd" @close="showAdd = false" />
  </div>
</template>

<style scoped>
.wrap {
  display: flex;
  flex-direction: column;
  height: 100%;
}
.brand {
  font-weight: 700;
  font-size: 16px;
  padding: 14px 14px 8px;
}
.all,
.list li {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 7px 14px;
  cursor: pointer;
}
.all {
  font-weight: 600;
  justify-content: space-between;
}
.all:hover,
.list li:hover {
  background: var(--bg-hover);
}
.all.active,
.list li.active {
  background: var(--bg-active);
}
.list {
  list-style: none;
  margin: 4px 0;
  padding: 0;
  overflow-y: auto;
}
.dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}
.dot.unread {
  background: var(--unread);
}
.dot.read {
  background: transparent;
  border: 1px solid var(--text-dim);
}
.dot.warn {
  background: var(--warn);
}
.name {
  flex: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.badge {
  background: var(--unread);
  color: #fff;
  border-radius: 10px;
  font-size: 11px;
  padding: 0 6px;
  min-width: 18px;
  text-align: center;
}
.refresh {
  border: none;
  background: none;
  padding: 0 4px;
  font-size: 15px;
}
.add {
  margin: 6px 14px;
  color: var(--text-dim);
}
.spacer {
  flex: 1;
}
</style>
