<script setup lang="ts">
// 添加公众号：输入名 → searchbiz 搜索 → 选中加入。见 docs/wechat-monitor.md#三添加公众号流程。
import { ref } from 'vue'
import { store } from '../stores/app'
import type { WxSearchResult } from '../../../shared/wechat'

const emit = defineEmits<{ close: [] }>()
const query = ref('')
const results = ref<WxSearchResult[]>([])
const searching = ref(false)
const adding = ref('')

async function doSearch(): Promise<void> {
  if (!query.value.trim()) return
  searching.value = true
  try {
    results.value = await store.search(query.value.trim())
  } finally {
    searching.value = false
  }
}

async function add(r: WxSearchResult): Promise<void> {
  adding.value = r.fakeid
  try {
    await store.addSource(r)
    emit('close')
  } finally {
    adding.value = ''
  }
}
</script>

<template>
  <div class="mask" @click.self="emit('close')">
    <div class="dialog">
      <h3>添加公众号</h3>
      <div class="search-row">
        <input v-model="query" placeholder="输入公众号名称" @keyup.enter="doSearch" />
        <button class="primary" :disabled="searching" @click="doSearch">
          {{ searching ? '搜索中…' : '搜索' }}
        </button>
      </div>
      <p v-if="!store.state.accounts.length" class="hint">需先登录一个账号才能搜索。</p>
      <ul class="results">
        <li v-for="r in results" :key="r.fakeid">
          <img v-if="r.roundHeadImg" :src="r.roundHeadImg" class="avatar" />
          <div class="info">
            <div class="nick">{{ r.nickname }}</div>
            <div class="sig">{{ r.signature || r.alias }}</div>
          </div>
          <button :disabled="adding === r.fakeid" @click="add(r)">
            {{ adding === r.fakeid ? '添加中…' : '关注' }}
          </button>
        </li>
      </ul>
      <div class="foot"><button @click="emit('close')">关闭</button></div>
    </div>
  </div>
</template>

<style scoped>
.mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.4);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 100;
}
.dialog {
  background: var(--bg);
  border-radius: 12px;
  padding: 20px;
  width: 480px;
  max-height: 70vh;
  display: flex;
  flex-direction: column;
}
h3 {
  margin: 0 0 12px;
}
.search-row {
  display: flex;
  gap: 8px;
}
.hint {
  color: var(--warn);
  font-size: 12px;
}
.results {
  list-style: none;
  padding: 0;
  margin: 12px 0;
  overflow-y: auto;
  flex: 1;
}
.results li {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px;
  border-radius: 8px;
}
.results li:hover {
  background: var(--bg-hover);
}
.avatar {
  width: 40px;
  height: 40px;
  border-radius: 20px;
}
.info {
  flex: 1;
  min-width: 0;
}
.nick {
  font-weight: 500;
}
.sig {
  color: var(--text-dim);
  font-size: 12px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.foot {
  text-align: right;
}
</style>
