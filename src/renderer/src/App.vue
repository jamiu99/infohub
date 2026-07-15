<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, type CSSProperties } from 'vue'
import { store } from './stores/app'
import SourceList from './components/SourceList.vue'
import ArticleFlow from './components/ArticleFlow.vue'
import ArticleDetail from './components/ArticleDetail.vue'
import SettingsDialog from './components/SettingsDialog.vue'
import UpdateBanner from './components/UpdateBanner.vue'
import brandLogoUrl from '../../../resources/branding/infohub-icon-v1.png'
import {
  MIN_PANE_WIDTH,
  defaultLayout,
  normalizeLayout,
  resizePair,
  type LayoutPreferences,
  type PaneId
} from './layout'

const LAYOUT_STORAGE_KEY = 'infohub.layout.v1'
type SettingsSection = 'sources' | 'accounts' | 'library' | 'team' | 'appearance' | 'update'

const paneDefinitions = [
  { id: 'sources' as const, label: '信源', component: SourceList },
  { id: 'flow' as const, label: '文章', component: ArticleFlow },
  { id: 'detail' as const, label: '正文', component: ArticleDetail }
]

function loadLayout(): LayoutPreferences {
  try {
    return normalizeLayout(JSON.parse(localStorage.getItem(LAYOUT_STORAGE_KEY) || 'null'))
  } catch {
    return defaultLayout()
  }
}

const layout = reactive<LayoutPreferences>(loadLayout())
const showSettings = ref(false)
const settingsSection = ref<SettingsSection>('sources')
const paneElements: Partial<Record<PaneId, HTMLElement>> = {}
const visiblePanes = computed(() => paneDefinitions.filter((pane) => layout[pane.id].visible))
let removeResizeListeners: (() => void) | null = null

function saveLayout(): void {
  localStorage.setItem(LAYOUT_STORAGE_KEY, JSON.stringify(layout))
}

function setPaneElement(id: PaneId, value: unknown): void {
  if (value instanceof HTMLElement) paneElements[id] = value
  else delete paneElements[id]
}

function paneStyle(id: PaneId): CSSProperties {
  return {
    flexGrow: layout[id].size,
    flexBasis: '0px',
    minWidth: `${MIN_PANE_WIDTH[id]}px`
  }
}

function togglePane(id: PaneId): void {
  layout[id].visible = !layout[id].visible
  saveLayout()
}

function resetLayout(): void {
  const next = defaultLayout()
  for (const id of Object.keys(next) as PaneId[]) {
    layout[id].visible = next[id].visible
    layout[id].size = next[id].size
  }
  saveLayout()
}

function openSettings(section: SettingsSection = 'sources'): void {
  settingsSection.value = section
  showSettings.value = true
}

function currentPair(leftId: PaneId, rightId: PaneId): [number, number] | null {
  const left = paneElements[leftId]
  const right = paneElements[rightId]
  if (!left || !right) return null
  return [left.getBoundingClientRect().width, right.getBoundingClientRect().width]
}

function setPair(leftId: PaneId, rightId: PaneId, left: number, right: number): void {
  layout[leftId].size = left
  layout[rightId].size = right
}

function startResize(event: PointerEvent, leftId: PaneId, rightId: PaneId): void {
  const pair = currentPair(leftId, rightId)
  if (!pair) return
  event.preventDefault()
  removeResizeListeners?.()

  // 把当前渲染宽度写回权重，拖动过程中不会因之前隐藏过栏目而突然跳动。
  for (const pane of visiblePanes.value) {
    const element = paneElements[pane.id]
    if (element) layout[pane.id].size = element.getBoundingClientRect().width
  }

  const [leftStart, rightStart] = pair
  const pointerStart = event.clientX
  document.documentElement.classList.add('is-resizing-panes')

  const move = (moveEvent: PointerEvent): void => {
    const [left, right] = resizePair(
      leftStart,
      rightStart,
      moveEvent.clientX - pointerStart,
      MIN_PANE_WIDTH[leftId],
      MIN_PANE_WIDTH[rightId]
    )
    setPair(leftId, rightId, left, right)
  }

  const finish = (): void => {
    window.removeEventListener('pointermove', move)
    window.removeEventListener('pointerup', finish)
    window.removeEventListener('pointercancel', finish)
    document.documentElement.classList.remove('is-resizing-panes')
    removeResizeListeners = null
    saveLayout()
  }

  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', finish)
  window.addEventListener('pointercancel', finish)
  removeResizeListeners = finish
}

function resizeByKeyboard(event: KeyboardEvent, leftId: PaneId, rightId: PaneId): void {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
  const pair = currentPair(leftId, rightId)
  if (!pair) return
  event.preventDefault()
  const [left, right] = resizePair(
    pair[0],
    pair[1],
    event.key === 'ArrowLeft' ? -16 : 16,
    MIN_PANE_WIDTH[leftId],
    MIN_PANE_WIDTH[rightId]
  )
  setPair(leftId, rightId, left, right)
  saveLayout()
}

function handleGlobalKey(event: KeyboardEvent): void {
  if (event.key === ',' && (event.ctrlKey || event.metaKey)) {
    event.preventDefault()
    openSettings('sources')
  }
}

onMounted(() => {
  void store.init()
  window.addEventListener('keydown', handleGlobalKey)
})

onBeforeUnmount(() => {
  removeResizeListeners?.()
  window.removeEventListener('keydown', handleGlobalKey)
})
</script>

<template>
  <div class="app-shell">
    <header class="app-toolbar">
      <div class="brand" aria-label="infohub 阅读工作台">
        <span class="brand-logo-crop" aria-hidden="true">
          <img :src="brandLogoUrl" alt="" />
        </span>
        <span class="brand-copy">
          <strong>infohub</strong>
          <small>阅读工作台</small>
        </span>
      </div>
      <div class="toolbar-actions">
        <div class="view-switcher" role="group" aria-label="显示或隐藏阅读栏目">
          <button
            v-for="pane in paneDefinitions"
            :key="pane.id"
            class="view-button"
            :class="{ active: layout[pane.id].visible }"
            :aria-pressed="layout[pane.id].visible"
            :title="`${layout[pane.id].visible ? '隐藏' : '显示'}${pane.label}栏`"
            @click="togglePane(pane.id)"
          >
            {{ pane.label }}
          </button>
        </div>
        <button class="source-settings-button" @click="openSettings('sources')">
          来源与抓取
        </button>
        <button class="settings-button" title="设置（Ctrl/Cmd + ,）" @click="openSettings('accounts')">
          设置
        </button>
      </div>
    </header>

    <main class="workspace">
      <template v-for="(pane, index) in visiblePanes" :key="pane.id">
        <section
          :ref="(element) => setPaneElement(pane.id, element)"
          class="pane"
          :class="`pane-${pane.id}`"
          :style="paneStyle(pane.id)"
        >
          <component :is="pane.component" />
        </section>
        <div
          v-if="index < visiblePanes.length - 1"
          class="resize-handle"
          role="separator"
          aria-orientation="vertical"
          :aria-label="`调整${pane.label}栏宽度`"
          tabindex="0"
          title="拖动调整宽度，双击恢复默认布局"
          @pointerdown="startResize($event, pane.id, visiblePanes[index + 1].id)"
          @keydown="resizeByKeyboard($event, pane.id, visiblePanes[index + 1].id)"
          @dblclick="resetLayout"
        ></div>
      </template>

      <div v-if="visiblePanes.length === 0" class="all-hidden">
        <p>阅读栏目都已隐藏</p>
        <button class="primary" @click="resetLayout">恢复默认布局</button>
      </div>
    </main>

    <SettingsDialog
      v-if="showSettings"
      :initial-section="settingsSection"
      @close="showSettings = false"
      @reset-layout="resetLayout"
    />
    <UpdateBanner />
  </div>
</template>

<style scoped>
.app-shell {
  display: flex;
  flex-direction: column;
  height: 100vh;
  overflow: hidden;
  background: var(--bg-canvas);
}
.app-toolbar {
  position: relative;
  z-index: 20;
  flex: 0 0 58px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 0 14px 0 16px;
  border-bottom: 1px solid var(--border);
  background: var(--bg-toolbar);
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  color: var(--text);
}
.brand-logo-crop {
  position: relative;
  width: 34px;
  height: 34px;
  flex: 0 0 auto;
  overflow: hidden;
  border: 1px solid var(--border-strong);
  border-radius: 9px;
  background: var(--bg-elevated);
}
.brand-logo-crop img {
  position: absolute;
  left: 50%;
  top: 50%;
  width: 76px;
  height: 76px;
  max-width: none;
  transform: translate(-50%, -50%);
}
.brand-copy {
  display: flex;
  flex-direction: column;
  min-width: 0;
  line-height: 1.15;
}
.brand-copy strong {
  font-size: 14px;
  font-weight: 720;
  letter-spacing: 0.2px;
}
.brand-copy small {
  margin-top: 3px;
  color: var(--text-dim);
  font-size: 10.5px;
}
.toolbar-actions,
.view-switcher {
  display: flex;
  align-items: center;
}
.toolbar-actions {
  gap: 8px;
}
.view-switcher {
  gap: 2px;
  padding: 2px;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-subtle);
}
.view-button,
.source-settings-button,
.settings-button {
  min-height: 30px;
  padding: 4px 11px;
  border-color: transparent;
  background: transparent;
  color: var(--text-dim);
  box-shadow: none;
}
.view-button.active {
  background: var(--bg-active);
  color: var(--text);
}
.view-button:hover,
.source-settings-button:hover,
.settings-button:hover {
  color: var(--text);
  background: var(--bg-hover);
}
.source-settings-button,
.settings-button {
  border-color: var(--border);
  background: var(--bg-elevated);
  color: var(--text-secondary);
}
.source-settings-button {
  color: var(--accent-strong);
}
.workspace {
  display: flex;
  flex: 1 1 auto;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
}
.pane {
  flex-shrink: 1;
  height: 100%;
  min-height: 0;
  overflow: hidden;
}
.pane-sources {
  background: var(--bg-sidebar);
}
.pane-flow {
  background: var(--bg);
}
.pane-detail {
  background: var(--bg-reading);
}
.resize-handle {
  position: relative;
  z-index: 10;
  flex: 0 0 5px;
  width: 5px;
  cursor: col-resize;
  outline: none;
  background: var(--bg-canvas);
  touch-action: none;
}
.resize-handle::after {
  content: '';
  position: absolute;
  inset: 0 2px;
  background: var(--border);
  transition: inset 0.12s, background 0.12s;
}
.resize-handle:hover::after,
.resize-handle:focus-visible::after {
  inset: 0 1px;
  background: var(--accent);
}
.all-hidden {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--text-dim);
}
.all-hidden p {
  margin: 0;
}
@media (max-width: 760px) {
  .app-toolbar {
    gap: 8px;
  }
  .brand-copy small {
    display: none;
  }
  .source-settings-button {
    display: none;
  }
  .view-button,
  .settings-button {
    padding-inline: 8px;
  }
}
</style>
