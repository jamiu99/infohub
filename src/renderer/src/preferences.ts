import { reactive, readonly } from 'vue'

export type ReadingModePreference = 'reader' | 'original'
export type ThemePreference = 'light' | 'dark'

export interface AppearancePreferences {
  readingMode: ReadingModePreference
  theme: ThemePreference
}

interface PreferenceStorage {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
}

export const READING_MODE_STORAGE_KEY = 'infohub.reading-mode.v1'
export const THEME_STORAGE_KEY = 'infohub.theme.v1'

export const DEFAULT_APPEARANCE_PREFERENCES: AppearancePreferences = {
  readingMode: 'reader',
  theme: 'light'
}

export function normalizeReadingMode(value: unknown): ReadingModePreference {
  return value === 'original' ? 'original' : 'reader'
}

export function normalizeTheme(value: unknown): ThemePreference {
  return value === 'dark' ? 'dark' : 'light'
}

export function loadAppearancePreferences(
  storage: Pick<PreferenceStorage, 'getItem'> | null
): AppearancePreferences {
  if (!storage) return { ...DEFAULT_APPEARANCE_PREFERENCES }
  try {
    return {
      readingMode: normalizeReadingMode(storage.getItem(READING_MODE_STORAGE_KEY)),
      theme: normalizeTheme(storage.getItem(THEME_STORAGE_KEY))
    }
  } catch {
    // localStorage 被系统策略禁用时仍应能阅读，只是不持久化本次选择。
    return { ...DEFAULT_APPEARANCE_PREFERENCES }
  }
}

/**
 * 原始排版是用户的全局阅读习惯；当前文章不支持时仅临时回退，不能覆盖偏好。
 */
export function resolveReadingMode(
  preferred: ReadingModePreference,
  canShowOriginal: boolean
): ReadingModePreference {
  return preferred === 'original' && canShowOriginal ? 'original' : 'reader'
}

function browserStorage(): PreferenceStorage | null {
  if (typeof window === 'undefined') return null
  try {
    return window.localStorage
  } catch {
    return null
  }
}

const mutablePreferences = reactive<AppearancePreferences>(
  loadAppearancePreferences(browserStorage())
)

export const appearancePreferences = readonly(mutablePreferences) as AppearancePreferences

function persist(key: string, value: string): void {
  try {
    browserStorage()?.setItem(key, value)
  } catch {
    // 偏好保存失败不阻止当前会话切换。
  }
}

export function setReadingModePreference(value: ReadingModePreference): void {
  mutablePreferences.readingMode = normalizeReadingMode(value)
  persist(READING_MODE_STORAGE_KEY, mutablePreferences.readingMode)
}

export function setThemePreference(value: ThemePreference): void {
  mutablePreferences.theme = normalizeTheme(value)
  persist(THEME_STORAGE_KEY, mutablePreferences.theme)
}
