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
    ? `最近检查：${new Date(source.lastFetchedAt).toLocaleString()}`
    : '尚未完成首次检查'
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
      ? `已为“${source.name}”开启自动检查新文章。`
      : `已关闭“${source.name}”的自动检查；仍可随时手动检查。`)
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
      ? `已开始检查“${source.name}”的新文章。不会向前翻找更早内容。`
      : '已开始检查所有启用来源的新文章。不会向前翻找更早内容。')
  } catch (error) {
    showMessage(userFacingError(error, '检查新文章失败'), 'error')
  } finally {
    actionBusy.value = false
  }
}

async function removeSelected(): Promise<void> {
  const source = selectedSource.value
  if (!source || actionBusy.value) return
  const confirmed = window.confirm(
    `确认删除来源“${source.name}”？\n\n仅保存在本机的该来源文章及正文会一起删除；已同步到团队的副本会保留在团队视图。此操作不能撤销。`
  )
  if (!confirmed) return
  actionBusy.value = true
  try {
    await store.removeSource(source.id)
    showMessage(`已删除来源“${source.name}”及仅保存在本机的文章。`)
  } catch (error) {
    showMessage(userFacingError(error, '删除来源失败'), 'error')
  } finally {
    actionBusy.value = false
  }
}
</script>

<template>
  <div class="source-settings">
    <section class="action-guide" aria-label="新文章与已保存文章说明">
      <header>
        <strong>这是两个独立操作，不分先后</strong>
        <p>平时使用“检查新文章”；只有已保存文章的正文缺失或显示异常时，才需要“修复已保存文章”。</p>
      </header>
      <div class="guide-actions">
        <article>
          <strong>检查新文章</strong>
          <p>查看来源目前展示的最新内容，发现新文章后保存。不会向前翻找很早的文章。</p>
        </article>
        <article>
          <strong>修复已保存文章</strong>
          <p>只处理资料库中已有的文章，不会发现或添加新文章。相关选项默认收起。</p>
        </article>
      </div>
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
            <small>{{ sourceType(source) }} · {{ source.enabled ? '自动检查已开启' : '仅手动检查' }}</small>
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
          检查所有启用来源
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
              <span>
                <strong>自动检查新文章</strong>
                <small>{{ selectedSource.enabled ? '已开启' : '已关闭，仍可手动检查' }}</small>
              </span>
            </label>
          </header>

          <div class="latest-action">
            <div>
              <strong>检查这个来源的新文章</strong>
              <p>
                {{ selectedSource.type === 'wechat'
                  ? '查看公众号目前展示的最新一页，发现新文章后保存正文；不会向前翻找更早内容。'
                  : '查看当前 Feed 中是否有新内容并保存；不会重新处理已经保存的文章。' }}
              </p>
            </div>
            <button
              class="primary"
              :disabled="collectionBusy || actionBusy"
              @click="pullLatest(selectedSource.id)"
            >
              {{ collectionBusy ? '任务进行中…' : '检查新文章' }}
            </button>
          </div>

          <ArticleMaintenancePanel
            :key="selectedSource.id"
            scope="source"
            :source-id="selectedSource.id"
          />

          <div class="danger-zone">
            <div>
              <strong>删除这个来源</strong>
              <p>停止关注，并删除仅保存在本机的该来源文章和正文；团队副本仍会保留。此操作不能撤销。</p>
            </div>
            <button class="danger" :disabled="actionBusy || collectionBusy" @click="removeSelected">
              删除来源及本机文章
            </button>
          </div>
        </template>
        <div v-else class="source-placeholder">
          选择一个来源后，可设置自动检查、手动检查新文章，以及修复已保存文章。
        </div>
      </div>
    </section>

    <p v-if="message" class="action-message" :class="messageKind" role="status">
      {{ message }}
    </p>

    <ArticleMaintenancePanel scope="all" />

    <AddSourceDialog v-if="showAdd" @close="showAdd = false" />
  </div>
</template>

<style scoped>
.source-settings {
  display: grid;
  gap: 18px;
}
.action-guide {
  border: 1px solid var(--border);
  background: var(--bg-subtle);
}
.action-guide > header {
  padding: 13px 16px;
  border-bottom: 1px solid var(--border);
}
.action-guide > header strong {
  font-size: 13px;
}
.action-guide > header p {
  margin: 4px 0 0;
  color: var(--text-dim);
  font-size: 11.5px;
  line-height: 1.55;
}
.guide-actions {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
}
.guide-actions article {
  padding: 13px 16px;
}
.guide-actions article + article {
  border-left: 1px solid var(--border);
}
.guide-actions strong,
.guide-actions p,
.no-sources p,
.latest-action p,
.source-title h4,
.source-title p,
.danger-zone p,
.action-message {
  margin: 0;
}
.guide-actions p,
.latest-action p,
.danger-zone p {
  margin-top: 4px;
  color: var(--text-dim);
  font-size: 12px;
  line-height: 1.6;
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
.source-toggle > span {
  display: flex;
  flex-direction: column;
}
.source-toggle strong {
  font-size: 11.5px;
  font-weight: 650;
}
.source-toggle small {
  margin-top: 2px;
  color: var(--text-dim);
  font-size: 10px;
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
  .guide-actions,
  .source-console {
    grid-template-columns: 1fr;
  }
  .guide-actions article + article,
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
