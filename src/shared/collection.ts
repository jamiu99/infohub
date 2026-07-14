/** 内容自动采集设置。它与桌面软件自动更新是两条完全独立的能力。 */
export const AUTO_COLLECT_INTERVAL = {
  defaultMinutes: 4 * 60,
  minMinutes: 60,
  maxMinutes: 7 * 24 * 60
} as const

export interface CollectionSettingsView {
  autoCollectEnabled: boolean
  intervalMinutes: number
  minIntervalMinutes: number
  maxIntervalMinutes: number
  recommendedIntervalMinutes: number
}

export type CollectionScheduleState =
  | 'disabled'
  | 'scheduled'
  | 'running'
  | 'paused'
  | 'error'

export interface CollectionScheduleStatus {
  state: CollectionScheduleState
  enabled: boolean
  intervalMinutes: number
  nextRunAt?: number
  lastRunAt?: number
  message?: string
}

export function validateAutoCollectIntervalMinutes(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < AUTO_COLLECT_INTERVAL.minMinutes ||
    value > AUTO_COLLECT_INTERVAL.maxMinutes
  ) {
    throw new Error(
      `自动采集间隔必须是 ${AUTO_COLLECT_INTERVAL.minMinutes}–${AUTO_COLLECT_INTERVAL.maxMinutes} 分钟的整数`
    )
  }
  return value
}
