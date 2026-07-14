<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { userFacingError } from '../../../shared/errors'
import { store } from '../stores/app'

const actionMessage = ref('')
const actionKind = ref<'info' | 'success'>('info')

const library = computed(() => store.state.dataLibrary)
const busy = computed(() => store.state.dataLibraryBusy)
const loading = computed(() => store.state.dataLibraryLoading)
const error = computed(() => store.state.dataLibraryError)

const migrationTitle = computed(() => {
  const migration = library.value?.migration
  if (!migration) return ''
  const date = new Date(migration.completedAt)
  const when = Number.isNaN(date.getTime()) ? '' : ` · ${date.toLocaleString()}`
  return migration.status === 'success' ? `上次迁移成功${when}` : `上次迁移失败${when}`
})

const migrationMessage = computed(() => {
  const migration = library.value?.migration
  if (!migration) return ''
  return migration.status === 'success'
    ? (migration.message || '资料库已迁移并完成逐文件校验。')
    : userFacingError(migration.message, '上次资料库迁移失败')
})

onMounted(() => {
  if (!library.value && !loading.value) void store.loadDataLibraryStatus()
})

async function openLibrary(): Promise<void> {
  actionMessage.value = ''
  try {
    await store.openDataLibrary()
    actionKind.value = 'success'
    actionMessage.value = '已在文件管理器中打开数据资料库。'
  } catch {
    // store 已把底层异常转换为适合展示的中文说明。
  }
}

async function chooseAndMigrate(): Promise<void> {
  actionMessage.value = ''
  try {
    const result = await store.chooseAndMigrateDataLibrary()
    if (result.state === 'cancelled') {
      actionKind.value = 'info'
      actionMessage.value = '已取消迁移，当前资料库没有变化。'
      return
    }
    actionKind.value = 'info'
    actionMessage.value = `迁移任务已安排，infohub 正在关闭并重启。目标目录：${result.targetRoot}`
  } catch {
    // store 已记录可直接展示的中文错误。
  }
}
</script>

<template>
  <section class="library-panel">
    <div v-if="loading && !library" class="placeholder">正在读取数据资料库位置…</div>

    <template v-else-if="library">
      <div class="path-card">
        <div class="path-heading">
          <strong>当前资料库</strong>
          <span class="location-kind" :class="{ custom: library.customized }">
            {{ library.customized ? '自定义位置' : '默认位置' }}
          </span>
        </div>
        <code :title="library.root">{{ library.root }}</code>
        <p v-if="library.customized" class="default-path">
          默认位置：<span :title="library.defaultRoot">{{ library.defaultRoot }}</span>
        </p>
        <div class="actions">
          <button class="primary" :disabled="busy" @click="openLibrary">
            {{ busy ? '请稍候…' : '打开目录' }}
          </button>
          <button :disabled="busy" @click="chooseAndMigrate">
            {{ busy ? '正在处理…' : '迁移资料库…' }}
          </button>
        </div>
      </div>

      <div class="outputs-card">
        <div>
          <strong>外部输出目录</strong>
          <p>AI Agent 或其他外部工具的处理结果建议写入这里，避免改动 infohub 保存的原始数据和正文。</p>
        </div>
        <code :title="library.outputsPath">{{ library.outputsPath }}</code>
      </div>

      <div class="migration-notice">
        <strong>迁移说明</strong>
        <ul>
          <li>目标必须是空目录，确认后应用会自动重启再执行迁移。</li>
          <li>文件会逐个复制并校验，全部通过后才启用新位置。</li>
          <li>原资料库会完整保留，不会自动删除，可在确认稳定后自行处理。</li>
          <li>账号登录状态、Cookie、团队配置和 Token 属于本机私有状态，不会迁移。</li>
        </ul>
      </div>

      <div
        v-if="library.migration"
        class="migration-result"
        :class="library.migration.status"
      >
        <strong>{{ migrationTitle }}</strong>
        <p>{{ migrationMessage }}</p>
        <dl>
          <template v-if="library.migration.sourceRoot">
            <dt>原位置</dt>
            <dd :title="library.migration.sourceRoot">{{ library.migration.sourceRoot }}</dd>
          </template>
          <template v-if="library.migration.targetRoot">
            <dt>目标位置</dt>
            <dd :title="library.migration.targetRoot">{{ library.migration.targetRoot }}</dd>
          </template>
        </dl>
      </div>
    </template>

    <div v-if="error" class="feedback error" role="alert">
      <span>{{ error }}</span>
      <button v-if="!library" :disabled="loading" @click="store.loadDataLibraryStatus()">
        重新读取
      </button>
    </div>
    <div
      v-if="actionMessage"
      class="feedback"
      :class="actionKind"
      role="status"
      aria-live="polite"
    >
      {{ actionMessage }}
    </div>
  </section>
</template>

<style scoped>
.library-panel {
  display: grid;
  gap: 16px;
}
.placeholder,
.path-card,
.outputs-card,
.migration-notice,
.migration-result,
.feedback {
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--bg-subtle);
}
.placeholder {
  color: var(--text-dim);
  font-size: 13px;
}
.path-heading,
.actions,
.feedback {
  display: flex;
  align-items: center;
}
.path-heading {
  justify-content: space-between;
  gap: 12px;
}
.location-kind {
  flex: 0 0 auto;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--bg-active);
  color: var(--text-secondary);
  font-size: 11px;
}
.location-kind.custom {
  color: var(--accent);
}
code {
  display: block;
  margin-top: 10px;
  padding: 9px 10px;
  overflow-wrap: anywhere;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  background: var(--bg-elevated);
  color: var(--text);
  font-family: ui-monospace, SFMono-Regular, Consolas, monospace;
  font-size: 11.5px;
  line-height: 1.5;
  user-select: text;
}
.default-path,
.outputs-card p,
.migration-result p {
  margin: 7px 0 0;
  color: var(--text-dim);
  font-size: 12px;
  line-height: 1.55;
}
.default-path span {
  overflow-wrap: anywhere;
}
.actions {
  gap: 8px;
  margin-top: 14px;
}
.outputs-card code {
  margin-top: 12px;
}
.migration-notice strong,
.migration-result strong,
.outputs-card strong {
  font-weight: 600;
}
.migration-notice ul {
  margin: 9px 0 0;
  padding-left: 20px;
  color: var(--text-dim);
  font-size: 12px;
  line-height: 1.7;
}
.migration-result.success {
  border-color: color-mix(in srgb, var(--ok) 38%, var(--border));
}
.migration-result.failed,
.feedback.error {
  border-color: color-mix(in srgb, var(--warn) 42%, var(--border));
}
.migration-result dl {
  display: grid;
  grid-template-columns: max-content minmax(0, 1fr);
  gap: 5px 10px;
  margin: 10px 0 0;
  font-size: 11.5px;
}
.migration-result dt {
  color: var(--text-dim);
}
.migration-result dd {
  margin: 0;
  overflow-wrap: anywhere;
  color: var(--text-secondary);
}
.feedback {
  justify-content: space-between;
  gap: 12px;
  color: var(--text-secondary);
  font-size: 12px;
  line-height: 1.55;
}
.feedback.success {
  color: var(--ok);
}
.feedback.error {
  color: var(--warn);
}
@media (max-width: 620px) {
  .path-heading,
  .actions,
  .feedback {
    align-items: flex-start;
    flex-direction: column;
  }
  .actions button {
    width: 100%;
  }
}
</style>
