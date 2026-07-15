<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { Source } from '../../../shared/contract'
import { userFacingError } from '../../../shared/errors'
import { store } from '../stores/app'
import AddSourceDialog from './AddSourceDialog.vue'
import ArticleMaintenancePanel from './ArticleMaintenancePanel.vue'

const selectedSourceId = ref<string | null>(store.state.selectedSourceId)
const showAdd = ref(false)
const actionBusy = ref(false)
const message = ref('')
const messageKind = ref<'success' | 'error'>('success')
const sources = computed(() => store.state.sources)
const selectedSource = computed(() =>
  sources.value.find((source) => source.id === selectedSourceId.value)
)
const collectionBusy = computed(
  () => store.state.progress.phase !== 'idle' || store.state.articleMaintenanceBusy
)

watch(
  sources,
  (items) => {
    if (selectedSourceId.value && items.some((source) => source.id === selectedSourceId.value)) return
    selectedSourceId.value = items[0]?.id ?? null
  },
  { immediate: true }
)

function sourceType(source: Source): string {
  if (source.type === 'wechat') return '公众号'
  if (source.type === 'rss') return 'RSS'
  return source.type
}

function fetchedAt(source: Source): string {
  return source.lastFetchedAt
    ? `最近拉取：${new Date(source.lastFetchedAt).toLocaleString()}`
    : '尚未完成首次拉取'
}

function showMessage(value: string, kind: 'success' | 'error' = 'success'): void {
  message.value = value
  messageKind.value = kind
}

async function setEnabled(source: Source, enabled: boolean): Promise<void> {
  if (actionBusy.value) return
  actionBusy.value = true
  try {
    await store.setSourceEnabled(source.id, enabled)
    showMessage(enabled
      ? `“${source.name}”已加入全部拉取和自动采集。`
      : `“${source.name}”已暂停自动采集；仍可手动拉取。`)
  } catch (error) {
    showMessage(userFacingError(error, '来源状态保存失败'), 'error')
  } finally {
    actionBusy.value = false
  }
}

async function pullLatest(sourceId?: string): Promise<void> {
  if (collectionBusy.value || actionBusy.value) return
  actionBusy.value = true
  try {
    await store.refresh(sourceId)
    const source = sources.value.find((item) => item.id === sourceId)
    showMessage(source
      ? `已开始拉取“${source.name}”的最新列表。不会回溯未入库旧文章。`
      : '已开始拉取所有启用来源的最新列表。不会回溯未入库旧文章。')
  } catch (error) {
    showMessage(userFacingError(error, '拉取最新内容失败'), 'error')
  } finally {
    actionBusy.value = false
  }
}

async function removeSelected(): Promise<void> {
  const source = selectedSource.value
  if (!source || actionBusy.value) return
  const confirmed = window.confirm(
    `确认取消关注“${source.name}”？\n\n纯本机文章及正文会被删除；已有团队副本会保留在团队视图。`
  )
  if (!confirmed) return
  actionBusy.value = true
  try {
    await store.removeSource(source.id)
    showMessage(`已取消关注“${source.name}”。`)
  } catch (error) {
    showMessage(userFacingError(error, '取消关注失败'), 'error')
  } finally {
    actionBusy.value = false
  }
}
</script>

<template>
  <div class="source-settings">
    <section class="fetch-guide" aria-label="抓取方式说明">
      <article>
        <span class="step">01</span>
        <div>
          <strong>拉取最新</strong>
          <p>读取来源当前的最新列表。公众号通常只取最新一页，不会翻页寻找从未入库的旧文章。</p>
        </div>
      </article>
      <article>
        <span class="step">02</span>
        <div>
          <strong>处理已入库历史</strong>
          <p>只处理资料库里已经存在的文章，可选本机离线重解析或逐篇联网重抓正文。</p>
        </div>
      </article>
    </section>

    <section class="source-console">
      <aside class="source-picker">
        <div class="picker-heading">
          <div>
            <strong>已关注来源</strong>
            <small>{{ sources.length }} 个</small>
          </div>
          <button class="quiet compact" @click="showAdd = true">＋ 添加</button>
        </div>

        <button
          v-for="source in sources"
          :key="source.id"
          class="source-option"
          :class="{ active: selectedSourceId === source.id }"
          @click="selectedSourceId = source.id"
        >
          <span class="source-glyph" :class="source.type">{{ source.type === 'wechat' ? '微' : 'R' }}</span>
          <span class="source-copy">
            <strong>{{ source.name }}</strong>
            <small>{{ sourceType(source) }} · {{ source.enabled ? '参与自动采集' : '已暂停' }}</small>
          </span>
          <span class="status-dot" :class="{ enabled: source.enabled }"></span>
        </button>

        <div v-if="!sources.length" class="no-sources">
          <p>还没有关注来源。</p>
          <button class="primary" @click="showAdd = true">添加第一个来源</button>
        </div>

        <button
          v-if="sources.length"
          class="pull-all"
          :disabled="collectionBusy || actionBusy || !sources.some((source) => source.enabled)"
          @click="pullLatest()"
        >
          拉取所有启用来源最新
        </button>
      </aside>

      <div class="source-detail">
        <template v-if="selectedSource">
          <header class="source-title">
            <div>
              <span class="type-label">{{ sourceType(selectedSource) }}</span>
              <h4>{{ selectedSource.name }}</h4>
              <p>{{ fetchedAt(selectedSource) }}</p>
            </div>
            <label class="source-toggle">
              <input
                type="checkbox"
                :checked="selectedSource.enabled"
                :disabled="actionBusy"
                @change="setEnabled(selectedSource, ($event.target as HTMLInputElement).checked)"
              />
              <span>{{ selectedSource.enabled ? '参与自动采集' : '暂停自动采集' }}</span>
            </label>
          </header>

          <div class="latest-action">
            <div>
              <strong>只拉取这个来源的最新内容</strong>
              <p>
                {{ selectedSource.type === 'wechat'
                  ? '请求公众号最新一页并补齐新文章正文；不回溯更早、尚未入库的文章。'
                  : '读取当前 Feed 内容；不会对已入库文章逐篇重新请求正文。' }}
              </p>
            </div>
            <button
              class="primary"
              :disabled="collectionBusy || actionBusy"
              @click="pullLatest(selectedSource.id)"
            >
              {{ collectionBusy ? '任务进行中…' : '拉取该来源最新' }}
            </button>
          </div>

          <ArticleMaintenancePanel :source-id="selectedSource.id" />

          <div class="danger-zone">
            <div>
              <strong>取消关注</strong>
              <p>会清理该来源的纯本机文章；这是删除动作，不是暂停采集。</p>
            </div>
            <button class="danger" :disabled="actionBusy || collectionBusy" @click="removeSelected">
              取消关注
            </button>
          </div>
        </template>
        <div v-else class="source-placeholder">
          选择一个来源后，可单独控制自动采集、拉取最新和历史正文维护。
        </div>
      </div>
    </section>

    <p v-if="message" class="action-message" :class="messageKind" role="status">
      {{ message }}
    </p>

    <AddSourceDialog v-if="showAdd" @close="showAdd = false" />
  </div>
</template>

<style scoped>
.source-settings {
  display: grid;
  gap: 18px;
}
.fetch-guide {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  border: 1px solid var(--border);
  background: var(--bg-subtle);
}
.fetch-guide article {
  display: flex;
  gap: 12px;
  padding: 15px 16px;
}
.fetch-guide article + article {
  border-left: 1px solid var(--border);
}
.fetch-guide strong,
.fetch-guide p,
.no-sources p,
.latest-action p,
.source-title h4,
.source-title p,
.danger-zone p,
.action-message {
  margin: 0;
}
.fetch-guide p,
.latest-action p,
.danger-zone p {
  margin-top: 4px;
  color: var(--text-dim);
  font-size: 12px;
  line-height: 1.6;
}
.step {
  color: var(--accent);
  font-size: 10px;
  font-weight: 800;
  letter-spacing: 0.8px;
}
.source-console {
  display: grid;
  grid-template-columns: 230px minmax(0, 1fr);
  min-height: 410px;
  overflow: hidden;
  border: 1px solid var(--border-strong);
  background: var(--bg-elevated);
}
.source-picker {
  display: flex;
  flex-direction: column;
  min-width: 0;
  padding: 10px;
  border-right: 1px solid var(--border);
  background: var(--bg-sidebar);
}
.picker-heading,
.source-title,
.latest-action,
.danger-zone {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
}
.picker-heading {
  padding: 4px 4px 10px;
}
.picker-heading > div {
  display: flex;
  align-items: baseline;
  gap: 7px;
}
.picker-heading small,
.source-copy small,
.source-title p {
  color: var(--text-dim);
  font-size: 11px;
}
.compact {
  padding: 3px 5px;
  font-size: 12px;
}
.source-option {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  padding: 9px;
  border-color: transparent;
  background: transparent;
  text-align: left;
}
.source-option:hover,
.source-option.active {
  background: var(--bg-hover);
}
.source-option.active {
  color: var(--accent-strong);
}
.source-glyph {
  display: grid;
  place-items: center;
  width: 28px;
  height: 28px;
  flex: 0 0 auto;
  border: 1px solid var(--border-strong);
  border-radius: 50%;
  background: var(--bg-elevated);
  color: var(--accent-strong);
  font-size: 11px;
  font-weight: 750;
}
.source-glyph.rss {
  color: var(--cooldown);
}
.source-copy {
  display: flex;
  flex: 1 1 auto;
  min-width: 0;
  flex-direction: column;
}
.source-copy strong,
.source-copy small {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.source-copy strong {
  font-size: 12.5px;
  font-weight: 630;
}
.status-dot {
  width: 7px;
  height: 7px;
  flex: 0 0 auto;
  border: 1px solid var(--border-strong);
  border-radius: 50%;
}
.status-dot.enabled {
  border-color: var(--ok);
  background: var(--ok);
}
.pull-all {
  margin-top: auto;
  padding-block: 8px;
}
.no-sources {
  padding: 36px 12px;
  color: var(--text-dim);
  text-align: center;
}
.no-sources button {
  margin-top: 12px;
}
.source-detail {
  min-width: 0;
  padding: 20px;
}
.source-title {
  align-items: flex-start;
  padding-bottom: 16px;
  border-bottom: 1px solid var(--border);
}
.source-title h4 {
  margin-top: 4px;
  font-size: 18px;
  line-height: 1.3;
}
.source-title p {
  margin-top: 5px;
}
.type-label {
  color: var(--accent);
  font-size: 10px;
  font-weight: 750;
  letter-spacing: 0.7px;
}
.source-toggle {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  flex: 0 0 auto;
  padding: 6px 8px;
  border: 1px solid var(--border);
  background: var(--bg-subtle);
  color: var(--text-secondary);
  font-size: 11.5px;
}
.latest-action,
.danger-zone {
  padding: 16px 0;
}
.latest-action > div,
.danger-zone > div {
  min-width: 0;
}
.latest-action button,
.danger-zone button {
  flex: 0 0 auto;
}
.danger-zone {
  margin-top: 16px;
  border-top: 1px solid var(--border);
}
.source-placeholder {
  display: grid;
  place-items: center;
  height: 100%;
  padding: 40px;
  color: var(--text-dim);
  text-align: center;
}
.action-message {
  padding: 10px 12px;
  border-left: 3px solid var(--ok);
  background: color-mix(in srgb, var(--ok) 7%, var(--bg-elevated));
  color: var(--ok);
  font-size: 12px;
}
.action-message.error {
  border-left-color: var(--warn);
  color: var(--warn);
}
@media (max-width: 760px) {
  .fetch-guide,
  .source-console {
    grid-template-columns: 1fr;
  }
  .fetch-guide article + article,
  .source-picker {
    border-left: 0;
    border-right: 0;
    border-top: 1px solid var(--border);
  }
  .source-console {
    overflow: visible;
  }
  .source-picker {
    max-height: 260px;
  }
  .source-title,
  .latest-action,
  .danger-zone {
    align-items: flex-start;
    flex-direction: column;
  }
}
</style>
