<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, reactive, ref, type CSSProperties } from 'vue'
import { store } from './stores/app'
import SourceList from './components/SourceList.vue'
import ArticleFlow from './components/ArticleFlow.vue'
import ArticleDetail from './components/ArticleDetail.vue'
import SettingsDialog from './components/SettingsDialog.vue'
import UpdateBanner from './components/UpdateBanner.vue'
import {
  MIN_PANE_WIDTH,
  defaultLayout,
  normalizeLayout,
  resizePair,
  type LayoutPreferences,
  type PaneId
} from './layout'

const LAYOUT_STORAGE_KEY = 'infohub.layout.v1'

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
    showSettings.value = true
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
      <div class="brand"><span class="brand-mark"></span><span>infohub</span></div>
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
        <button class="settings-button" title="设置（Ctrl/Cmd + ,）" @click="showSettings = true">
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
  background: var(--bg);
}
.app-toolbar {
  position: relative;
  z-index: 20;
  flex: 0 0 44px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 0 10px 0 14px;
  border-bottom: 1px solid var(--border);
  background: color-mix(in srgb, var(--bg-elevated) 94%, transparent);
}
.brand {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  font-size: 14px;
  font-weight: 680;
  letter-spacing: 0.15px;
}
.brand-mark {
  width: 10px;
  height: 10px;
  flex: 0 0 auto;
  border-radius: 3px;
  background: var(--accent);
  box-shadow: 0 0 0 3px var(--accent-soft);
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
.settings-button {
  min-height: 28px;
  padding: 3px 10px;
  border-color: transparent;
  background: transparent;
  color: var(--text-dim);
  box-shadow: none;
}
.view-button.active {
  background: var(--bg-elevated);
  color: var(--text);
  box-shadow: var(--shadow-sm);
}
.view-button:hover,
.settings-button:hover {
  color: var(--text);
  background: var(--bg-hover);
}
.settings-button {
  border-color: var(--border);
  background: var(--bg-elevated);
  color: var(--text-secondary);
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
.pane-flow,
.pane-detail {
  background: var(--bg);
}
.resize-handle {
  position: relative;
  z-index: 10;
  flex: 0 0 7px;
  width: 7px;
  cursor: col-resize;
  outline: none;
  background: var(--bg);
  touch-action: none;
}
.resize-handle::after {
  content: '';
  position: absolute;
  inset: 0 3px;
  background: var(--border);
  transition: inset 0.12s, background 0.12s;
}
.resize-handle:hover::after,
.resize-handle:focus-visible::after {
  inset: 0 2px;
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
  .brand span:last-child {
    display: none;
  }
  .view-button,
  .settings-button {
    padding-inline: 8px;
  }
}
</style>
