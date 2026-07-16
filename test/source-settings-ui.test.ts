import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const sourcePanel = readFileSync(
  new URL('../src/renderer/src/components/SourceSettingsPanel.vue', import.meta.url),
  'utf8'
)
const maintenancePanel = readFileSync(
  new URL('../src/renderer/src/components/ArticleMaintenancePanel.vue', import.meta.url),
  'utf8'
)

test('来源设置把检查新文章与修复已保存文章展示为两个独立操作', () => {
  assert.match(sourcePanel, /这是两个独立操作，不分先后/)
  assert.match(sourcePanel, /检查这个来源的新文章/)
  assert.match(sourcePanel, /<ArticleMaintenancePanel[\s\S]*?scope="source"/)
  assert.match(sourcePanel, /<ArticleMaintenancePanel scope="all"/)
})

test('文章修复按固定范围默认折叠，并隐藏工程实现词', () => {
  assert.match(maintenancePanel, /<details class="maintenance-card">/)
  assert.doesNotMatch(maintenancePanel, /<details[^>]+open/)
  assert.match(maintenancePanel, /scope: props\.scope/)
  assert.match(maintenancePanel, /处理范围固定为/)

  const visibleCopy = `${sourcePanel}\n${maintenancePanel}`
  for (const engineeringCopy of ['HISTORY', 'Raw', '解析器', '第一步', '第二步', '选择范围']) {
    assert.doesNotMatch(visibleCopy, new RegExp(engineeringCopy))
  }
})

test('删除来源明确提示会删除本机文章且不能撤销', () => {
  assert.match(sourcePanel, /删除来源及本机文章/)
  assert.match(sourcePanel, /仅保存在本机的该来源文章及正文会一起删除/)
  assert.match(sourcePanel, /此操作不能撤销/)
})
