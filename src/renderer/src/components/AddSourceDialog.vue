<script setup lang="ts">
// 添加信源：选类型（公众号/RSS）→ 搜索/试探 → 选中加入。见 docs/ingest.md。
import { ref, computed } from 'vue'
import { store } from '../stores/app'
import type { DiscoverResult } from '../../../shared/contract'
import { userFacingError } from '../../../shared/errors'

const emit = defineEmits<{ close: [] }>()
const type = ref<'wechat' | 'rss'>('wechat')
const query = ref('')
const results = ref<DiscoverResult[]>([])
const searching = ref(false)
const adding = ref(-1)
const errorMessage = ref('')

const placeholder = computed(() =>
  type.value === 'wechat' ? '输入公众号名称（可粘贴）' : '粘贴 RSS/Atom 订阅地址（http…）'
)
const needAccount = computed(() => type.value === 'wechat' && !store.state.accounts.length)

async function doSearch(): Promise<void> {
  if (!query.value.trim()) return
  errorMessage.value = ''
  searching.value = true
  try {
    results.value = await store.search(type.value, query.value.trim())
  } catch (error) {
    results.value = []
    errorMessage.value = userFacingError(error, type.value === 'wechat' ? '搜索公众号失败' : '解析 RSS 失败')
  } finally {
    searching.value = false
  }
}

function switchType(t: 'wechat' | 'rss'): void {
  type.value = t
  results.value = []
  query.value = ''
  errorMessage.value = ''
}

async function add(r: DiscoverResult, i: number): Promise<void> {
  adding.value = i
  errorMessage.value = ''
  try {
    await store.addSource(type.value, r)
    emit('close')
  } catch (error) {
    errorMessage.value = userFacingError(error, '添加信源失败')
  } finally {
    adding.value = -1
  }
}
</script>

<template>
  <div class="mask" @click.self="emit('close')">
    <div class="dialog">
      <h3>添加信源</h3>
      <div class="tabs">
        <button :class="{ on: type === 'wechat' }" @click="switchType('wechat')">公众号</button>
        <button :class="{ on: type === 'rss' }" @click="switchType('rss')">RSS</button>
      </div>
      <div class="search-row">
        <input v-model="query" :placeholder="placeholder" @keyup.enter="doSearch" />
        <button class="primary" :disabled="searching" @click="doSearch">
          {{ searching ? '查找中…' : type === 'wechat' ? '搜索' : '解析' }}
        </button>
      </div>
      <p v-if="needAccount" class="hint">需先登录一个账号才能搜索公众号。</p>
      <p v-if="errorMessage" class="error-message">{{ errorMessage }}</p>
      <ul class="results">
        <li v-for="(r, i) in results" :key="i">
          <img v-if="r.meta?.roundHeadImg" :src="(r.meta.roundHeadImg as string)" class="avatar" />
          <div class="info">
            <div class="nick">{{ r.name }}</div>
            <div class="sig">
              {{ (r.meta?.signature as string) || (r.meta?.entries ? `${r.meta.entries} 条` : '') }}
            </div>
          </div>
          <button :disabled="adding === i" @click="add(r, i)">
            {{ adding === i ? '添加中…' : '关注' }}
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
.tabs {
  display: flex;
  gap: 6px;
  margin-bottom: 12px;
}
.tabs button {
  border-radius: 999px;
  padding: 4px 14px;
}
.tabs button.on {
  background: var(--accent);
  color: #fff;
  border-color: var(--accent);
}
.search-row {
  display: flex;
  gap: 8px;
}
.hint {
  color: var(--warn);
  font-size: 12px;
}
.error-message {
  margin: 10px 0 0;
  padding: 8px 10px;
  border-radius: var(--radius-sm);
  background: color-mix(in srgb, var(--warn) 9%, transparent);
  color: var(--warn);
  font-size: 12px;
  line-height: 1.5;
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
