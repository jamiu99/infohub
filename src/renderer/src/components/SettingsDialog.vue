<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { store } from '../stores/app'
import { userFacingError } from '../../../shared/errors'
import QuotaPanel from './QuotaPanel.vue'
import TeamPanel from './TeamPanel.vue'
import AutoCollectPanel from './AutoCollectPanel.vue'
import DataLibraryPanel from './DataLibraryPanel.vue'
import SourceSettingsPanel from './SourceSettingsPanel.vue'

type Section = 'sources' | 'accounts' | 'library' | 'team' | 'appearance' | 'update'

const props = withDefaults(defineProps<{ initialSection?: Section }>(), {
  initialSection: 'sources'
})
const emit = defineEmits<{ close: []; 'reset-layout': [] }>()
const active = ref<Section>(props.initialSection)
const update = computed(() => store.state.update)
const updateBusy = computed(
  () => update.value?.state === 'checking' || update.value?.state === 'downloading'
)

const updateDescription = computed(() => {
  const value = update.value
  if (!value) return '尚未检查更新。'
  if (value.state === 'checking') return '正在连接更新服务…'
  if (value.state === 'available') return `发现新版本 ${value.version || ''}，请按系统提示选择是否下载。`
  if (value.state === 'none') return '当前已经是最新版本。'
  if (value.state === 'downloading') {
    return `正在下载版本 ${value.version || ''}，已完成 ${value.percent ?? 0}%。`
  }
  if (value.state === 'ready') return `版本 ${value.version || ''} 已下载完成，可以重启安装。`
  return userFacingError(value.message, '检查更新失败')
})

watch(
  () => props.initialSection,
  (value) => (active.value = value)
)

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape') emit('close')
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <div class="settings-mask" @click.self="emit('close')">
    <section class="settings-dialog" role="dialog" aria-modal="true" aria-label="infohub 设置">
      <header class="settings-header">
        <div>
          <h2>设置</h2>
          <p>来源、抓取范围、自动化与阅读偏好。</p>
        </div>
        <button class="close" aria-label="关闭设置" title="关闭" @click="emit('close')">×</button>
      </header>

      <div class="settings-body">
        <nav class="settings-nav" aria-label="设置分类">
          <button :class="{ active: active === 'sources' }" @click="active = 'sources'">
            来源与抓取
          </button>
          <button :class="{ active: active === 'accounts' }" @click="active = 'accounts'">
            账号与自动化
          </button>
          <button :class="{ active: active === 'library' }" @click="active = 'library'">
            数据资料库
          </button>
          <button :class="{ active: active === 'team' }" @click="active = 'team'">
            团队共享
            <span v-if="store.state.team?.device" class="connected-dot" title="已加入团队"></span>
          </button>
          <button :class="{ active: active === 'appearance' }" @click="active = 'appearance'">
            阅读界面
          </button>
          <button :class="{ active: active === 'update' }" @click="active = 'update'">
            软件更新
          </button>
        </nav>

        <div class="settings-content">
          <section v-if="active === 'sources'" class="settings-section settings-section-wide">
            <div class="section-heading">
              <span class="eyebrow">CONTENT SOURCES</span>
              <h3>来源与抓取</h3>
              <p>逐个管理公众号，并明确区分“拉取最新”和“处理已入库历史”。</p>
            </div>
            <SourceSettingsPanel />
          </section>

          <section v-else-if="active === 'accounts'" class="settings-section">
            <div class="section-heading">
              <span class="eyebrow">AUTOMATION</span>
              <h3>账号与自动化</h3>
              <p>管理微信登录、请求保护与全局自动采集周期。</p>
            </div>
            <QuotaPanel />
            <AutoCollectPanel />
          </section>

          <section v-else-if="active === 'library'" class="settings-section">
            <div class="section-heading">
              <h3>数据资料库</h3>
              <p>管理原始数据、正文和外部处理结果的存储位置。</p>
            </div>
            <DataLibraryPanel />
          </section>

          <section v-else-if="active === 'team'" class="settings-section">
            <div class="section-heading">
              <h3>团队共享</h3>
              <p>连接自托管团队服务，查看同步状态或退出当前团队。</p>
            </div>
            <TeamPanel />
          </section>

          <section v-else-if="active === 'appearance'" class="settings-section">
            <div class="section-heading">
              <h3>阅读界面</h3>
              <p>顶部的“信源 / 文章 / 正文”按钮可以随时隐藏或恢复对应栏目。</p>
            </div>
            <div class="setting-card layout-card">
              <div>
                <strong>三栏布局</strong>
                <p>拖动栏目之间的分隔线调整宽度；双击分隔线也可以恢复默认布局。</p>
              </div>
              <button @click="emit('reset-layout')">恢复默认布局</button>
            </div>
          </section>

          <section v-else class="settings-section">
            <div class="section-heading">
              <h3>软件更新</h3>
              <p>传统的检查、确认下载、重启安装流程。</p>
            </div>
            <div class="setting-card update-card" :class="update?.state">
              <div>
                <strong>infohub 更新</strong>
                <p>{{ updateDescription }}</p>
              </div>
              <button
                v-if="update?.state === 'ready'"
                class="primary"
                @click="store.installUpdate()"
              >
                重启并安装
              </button>
              <button v-else :disabled="updateBusy" @click="store.checkUpdate()">
                {{ updateBusy ? (update?.state === 'downloading' ? '下载中…' : '检查中…') : '检查更新' }}
              </button>
            </div>
          </section>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.settings-mask {
  position: fixed;
  inset: 0;
  z-index: 100;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 24px;
  background: rgba(54, 43, 29, 0.42);
}
.settings-dialog {
  display: flex;
  flex-direction: column;
  width: min(1040px, 100%);
  height: min(760px, calc(100vh - 48px));
  overflow: hidden;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-lg);
  background: var(--bg-elevated);
  box-shadow: var(--shadow-md);
}
.settings-header {
  flex: 0 0 auto;
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 20px;
  padding: 20px 24px 17px;
  border-bottom: 1px solid var(--border);
}
.settings-header h2,
.settings-header p,
.section-heading h3,
.section-heading p,
.setting-card p {
  margin: 0;
}
.settings-header h2 {
  font-size: 17px;
  line-height: 1.35;
}
.settings-header p {
  margin-top: 3px;
  color: var(--text-dim);
  font-size: 12px;
}
.close {
  width: 30px;
  height: 30px;
  padding: 0;
  border-color: transparent;
  background: transparent;
  color: var(--text-dim);
  font-size: 22px;
  line-height: 1;
}
.settings-body {
  display: grid;
  grid-template-columns: 184px minmax(0, 1fr);
  flex: 1 1 auto;
  min-height: 0;
}
.settings-nav {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 16px 12px;
  border-right: 1px solid var(--border);
  background: var(--bg-sidebar);
}
.settings-nav button {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 9px 11px;
  border-color: transparent;
  background: transparent;
  color: var(--text-secondary);
  text-align: left;
}
.settings-nav button:hover {
  background: var(--bg-hover);
}
.settings-nav button.active {
  background: var(--bg-active);
  color: var(--accent-strong);
  font-weight: 650;
}
.connected-dot {
  width: 7px;
  height: 7px;
  flex: 0 0 auto;
  border-radius: 50%;
  background: var(--ok);
}
.settings-content {
  min-width: 0;
  min-height: 0;
  overflow-y: auto;
  padding: 28px 30px 40px;
}
.settings-section {
  max-width: 620px;
  margin: 0 auto;
}
.settings-section-wide {
  max-width: 780px;
}
.section-heading {
  margin-bottom: 18px;
}
.section-heading h3 {
  font-size: 20px;
  line-height: 1.25;
}
.section-heading p {
  margin-top: 4px;
  color: var(--text-dim);
  font-size: 12.5px;
}
.eyebrow {
  display: block;
  margin-bottom: 7px;
  color: var(--accent);
  font-size: 10px;
  font-weight: 750;
  letter-spacing: 1.2px;
}
.setting-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  padding: 16px;
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  background: var(--bg-subtle);
}
.setting-card strong {
  font-weight: 600;
}
.setting-card p {
  margin-top: 4px;
  color: var(--text-dim);
  font-size: 12px;
  line-height: 1.55;
}
.setting-card button {
  flex: 0 0 auto;
}
.update-card.error {
  border-color: color-mix(in srgb, var(--warn) 42%, var(--border));
}
@media (max-width: 620px) {
  .settings-mask {
    padding: 10px;
  }
  .settings-dialog {
    height: calc(100vh - 20px);
  }
  .settings-body {
    grid-template-columns: 1fr;
    grid-template-rows: auto minmax(0, 1fr);
  }
  .settings-nav {
    flex-direction: row;
    overflow-x: auto;
    border-right: 0;
    border-bottom: 1px solid var(--border);
  }
  .settings-nav button {
    width: auto;
    flex: 0 0 auto;
  }
  .settings-content {
    padding: 18px;
  }
  .setting-card {
    align-items: flex-start;
    flex-direction: column;
    gap: 12px;
  }
}
</style>
