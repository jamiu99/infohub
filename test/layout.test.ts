import { test } from 'node:test'
import assert from 'node:assert/strict'
import { defaultLayout, normalizeLayout, resizePair } from '../src/renderer/src/layout'

test('损坏的界面布局配置回退到安全默认值', () => {
  const layout = normalizeLayout({
    sources: { visible: false, size: -100 },
    flow: { visible: 'yes', size: Number.NaN },
    detail: null
  })
  assert.equal(layout.sources.visible, false)
  assert.equal(layout.sources.size, 176)
  assert.deepEqual(layout.flow, defaultLayout().flow)
  assert.deepEqual(layout.detail, defaultLayout().detail)
})

test('拖动分隔线保持总宽度并遵守两侧最小宽度', () => {
  assert.deepEqual(resizePair(300, 500, 100, 176, 260), [400, 400])
  assert.deepEqual(resizePair(300, 500, -500, 176, 260), [176, 624])
  assert.deepEqual(resizePair(300, 500, 500, 176, 320), [480, 320])
})
