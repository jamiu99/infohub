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
  font-weight: 650;
  font-size: 14px;
  letter-spacing: 0.2px;
  padding: 14px 16px 10px;
  color: var(--text);
  display: flex;
  align-items: center;
  gap: 7px;
}
.brand::before {
  content: '';
  width: 9px;
  height: 9px;
  border-radius: 3px;
  background: var(--accent);
}
.all,
.list li {
  display: flex;
  align-items: center;
  gap: 9px;
  margin: 1px 8px;
  padding: 6px 8px;
  border-radius: var(--radius-sm);
  cursor: pointer;
  color: var(--text-secondary);
}
.all {
  font-weight: 550;
  justify-content: space-between;
  color: var(--text);
}
.all:hover,
.list li:hover {
  background: var(--bg-hover);
}
.all.active,
.list li.active {
  background: var(--bg-active);
  color: var(--text);
}
.list {
  list-style: none;
  margin: 2px 0;
  padding: 0;
  overflow-y: auto;
}
.dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  flex-shrink: 0;
}
.dot.unread {
  background: var(--unread);
}
.dot.read {
  background: transparent;
  border: 1.5px solid var(--border-strong);
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
  background: var(--bg-subtle);
  color: var(--text-secondary);
  border-radius: 9px;
  font-size: 11px;
  font-weight: 550;
  padding: 1px 7px;
  min-width: 18px;
  text-align: center;
}
.active .badge,
.list li.active .badge {
  background: var(--accent);
  color: #fff;
}
.refresh {
  border: none;
  background: none;
  padding: 2px 5px;
  font-size: 14px;
  color: var(--text-dim);
  border-radius: var(--radius-sm);
}
.refresh:hover {
  background: var(--bg-hover);
  color: var(--text);
}
.add {
  margin: 6px 12px 10px;
  color: var(--text-secondary);
  border-style: dashed;
  background: transparent;
}
.add:hover {
  color: var(--text);
  border-color: var(--accent);
}
.spacer {
  flex: 1;
}
</style>
