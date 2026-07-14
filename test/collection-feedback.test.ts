import { test } from 'node:test'
import assert from 'node:assert/strict'
import { automaticCollectionFeedback } from '../src/core/collect/collection-feedback'
import type { CollectionBatchResult } from '../src/core/collect/collection-runner'
import type { Source } from '../src/shared/contract'

const wechat: Source = {
  id: 'wx-one',
  type: 'wechat',
  name: '示例公众号',
  enabled: true,
  config: { fakeid: 'fake-one' }
}

function batch(
  overrides: Partial<CollectionBatchResult> = {}
): CollectionBatchResult {
  return {
    origin: 'automatic',
    status: 'completed',
    results: [],
    skippedSourceIds: [],
    metadataErrors: [],
    ...overrides
  }
}

test('自动采集成功不留下旧错误反馈', () => {
  assert.equal(
    automaticCollectionFeedback(batch({
      results: [{
        source: wechat,
        result: { sourceId: wechat.id, newArticles: 1, updatedArticles: 0, status: 'ok' }
      }]
    })),
    null
  )
})

test('no_account 与英文底层错误会转换成可展示的中文摘要', () => {
  const feedback = automaticCollectionFeedback(batch({
    results: [
      {
        source: wechat,
        result: {
          sourceId: wechat.id,
          newArticles: 0,
          updatedArticles: 0,
          status: 'no_account'
        }
      },
      {
        source: { ...wechat, id: 'rss-one', type: 'rss', name: '示例 RSS' },
        result: {
          sourceId: 'rss-one',
          newArticles: 0,
          updatedArticles: 0,
          status: 'error',
          message: 'socket hang up'
        }
      }
    ],
    skippedSourceIds: ['wx-two']
  }))

  assert.equal(feedback?.state, 'error')
  assert.match(feedback?.message ?? '', /没有可用的公众号账号/)
  assert.match(feedback?.message ?? '', /采集失败。请重试/)
  assert.match(feedback?.message ?? '', /1 个公众号因账号不可用而跳过/)
  assert.doesNotMatch(feedback?.message ?? '', /no_account|socket hang up/i)
})

test('忙时跳过使用 paused 状态和中文说明', () => {
  const feedback = automaticCollectionFeedback(batch({ status: 'skipped_busy' }))
  assert.deepEqual(feedback, {
    state: 'paused',
    message: '已有采集或维护任务在运行，本轮自动采集已跳过。'
  })
})
