import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  DEFAULT_APPEARANCE_PREFERENCES,
  READING_MODE_STORAGE_KEY,
  THEME_STORAGE_KEY,
  loadAppearancePreferences,
  normalizeReadingMode,
  normalizeTheme,
  resolveReadingMode
} from '../src/renderer/src/preferences'

test('阅读与主题偏好使用保守默认值，并忽略损坏值', () => {
  assert.deepEqual(loadAppearancePreferences(null), DEFAULT_APPEARANCE_PREFERENCES)
  assert.equal(normalizeReadingMode('unexpected'), 'reader')
  assert.equal(normalizeTheme('system'), 'light')

  const values = new Map([
    [READING_MODE_STORAGE_KEY, 'unexpected'],
    [THEME_STORAGE_KEY, 'system']
  ])
  assert.deepEqual(
    loadAppearancePreferences({ getItem: (key) => values.get(key) ?? null }),
    DEFAULT_APPEARANCE_PREFERENCES
  )
})

test('合法阅读与主题偏好可从设备本地存储恢复', () => {
  const values = new Map([
    [READING_MODE_STORAGE_KEY, 'original'],
    [THEME_STORAGE_KEY, 'dark']
  ])
  assert.deepEqual(
    loadAppearancePreferences({ getItem: (key) => values.get(key) ?? null }),
    { readingMode: 'original', theme: 'dark' }
  )
})

test('不支持原始 HTML 的文章只临时回退，不改变用户阅读偏好', () => {
  const preferred = 'original' as const
  assert.equal(resolveReadingMode(preferred, true), 'original')
  assert.equal(resolveReadingMode(preferred, false), 'reader')
  assert.equal(preferred, 'original')
})
