export const PANE_IDS = ['sources', 'flow', 'detail'] as const
export type PaneId = (typeof PANE_IDS)[number]

export interface PanePreference {
  visible: boolean
  size: number
}

export type LayoutPreferences = Record<PaneId, PanePreference>

export const DEFAULT_LAYOUT: LayoutPreferences = {
  sources: { visible: true, size: 248 },
  flow: { visible: true, size: 390 },
  detail: { visible: true, size: 660 }
}

export const MIN_PANE_WIDTH: Record<PaneId, number> = {
  sources: 176,
  flow: 260,
  detail: 320
}

export function defaultLayout(): LayoutPreferences {
  return {
    sources: { ...DEFAULT_LAYOUT.sources },
    flow: { ...DEFAULT_LAYOUT.flow },
    detail: { ...DEFAULT_LAYOUT.detail }
  }
}

/** localStorage 可能来自旧版本或被手工修改；这里只接受明确且有界的布局字段。 */
export function normalizeLayout(value: unknown): LayoutPreferences {
  const normalized = defaultLayout()
  if (!value || typeof value !== 'object') return normalized
  const fields = value as Record<string, unknown>

  for (const id of PANE_IDS) {
    const candidate = fields[id]
    if (!candidate || typeof candidate !== 'object') continue
    const pane = candidate as Record<string, unknown>
    if (typeof pane.visible === 'boolean') normalized[id].visible = pane.visible
    if (typeof pane.size === 'number' && Number.isFinite(pane.size)) {
      normalized[id].size = Math.max(MIN_PANE_WIDTH[id], Math.min(4000, pane.size))
    }
  }
  return normalized
}

export function resizePair(
  leftStart: number,
  rightStart: number,
  delta: number,
  leftMin: number,
  rightMin: number
): [number, number] {
  const total = leftStart + rightStart
  if (total <= leftMin + rightMin) return [leftStart, rightStart]
  const left = Math.max(leftMin, Math.min(total - rightMin, leftStart + delta))
  return [left, total - left]
}
