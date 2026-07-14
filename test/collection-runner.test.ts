import { test } from 'node:test'
import assert from 'node:assert/strict'
import { CollectionRunner } from '../src/core/collect/collection-runner.ts'
import type { CollectResult } from '../src/core/collect/collector.ts'
import type { Source } from '../src/shared/contract.ts'

function source(
  id: string,
  type: 'wechat' | 'rss',
  lastFetchedAt?: number,
  enabled = true
): Source {
  return { id, type, name: id, enabled, config: {}, lastFetchedAt }
}

function ok(id: string): CollectResult {
  return { sourceId: id, newArticles: 0, updatedArticles: 0, status: 'ok' }
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

test('自动批次只采 enabled source，并按最久未采集优先', async () => {
  const sources = [
    source('newer', 'rss', 300),
    source('disabled', 'rss', undefined, false),
    source('never-b', 'wechat'),
    source('old', 'rss', 100),
    source('never-a', 'rss')
  ]
  const order: string[] = []
  const marked: Array<[string, number]> = []
  const runner = new CollectionRunner({
    listSources: () => sources,
    collectSource: async (item) => {
      order.push(item.id)
      return ok(item.id)
    },
    markFetchedAt: (id, time) => marked.push([id, time]),
    now: () => 999
  })

  const result = await runner.runAutomatic()

  assert.equal(result.status, 'completed')
  assert.deepEqual(order, ['never-a', 'never-b', 'old', 'newer'])
  assert.deepEqual(marked, [
    ['never-a', 999],
    ['never-b', 999],
    ['old', 999],
    ['newer', 999]
  ])
})

test('批次运行期间自动触发直接 skipped_busy，不追加到队尾', async () => {
  const hold = deferred<CollectResult>()
  const runner = new CollectionRunner({
    listSources: () => [source('one', 'rss')],
    collectSource: () => hold.promise
  })

  const manual = runner.runManual()
  assert.equal(runner.isBusy(), true)

  const automatic = await runner.runAutomatic()
  assert.equal(automatic.status, 'skipped_busy')
  assert.deepEqual(automatic.results, [])

  hold.resolve(ok('one'))
  assert.equal((await manual).status, 'completed')
  assert.equal(runner.isBusy(), false)
})

test('微信 no_account 后跳过本轮剩余微信 source，但继续采集 RSS', async () => {
  const sources = [
    source('wx-1', 'wechat', 1),
    source('wx-2', 'wechat', 2),
    source('rss-1', 'rss', 3),
    source('wx-3', 'wechat', 4),
    source('rss-2', 'rss', 5)
  ]
  const calls: string[] = []
  const runner = new CollectionRunner({
    listSources: () => sources,
    collectSource: async (item) => {
      calls.push(item.id)
      if (item.id === 'wx-1') {
        return {
          sourceId: item.id,
          newArticles: 0,
          updatedArticles: 0,
          status: 'no_account'
        }
      }
      return ok(item.id)
    }
  })

  const result = await runner.runAutomatic()

  assert.deepEqual(calls, ['wx-1', 'rss-1', 'rss-2'])
  assert.deepEqual(result.skippedSourceIds, ['wx-2', 'wx-3'])
  assert.deepEqual(result.results.map((item) => item.source.id), ['wx-1', 'rss-1', 'rss-2'])
})

test('单个 source 异常转为 error 结果，其余 source 继续采集', async () => {
  const calls: string[] = []
  const errors: string[] = []
  const runner = new CollectionRunner({
    listSources: () => [source('bad', 'rss'), source('good', 'rss')],
    collectSource: async (item) => {
      calls.push(item.id)
      if (item.id === 'bad') throw new Error('network probe')
      return ok(item.id)
    },
    onError: (error) => errors.push((error as Error).message)
  })

  const result = await runner.runManual()

  assert.deepEqual(calls, ['bad', 'good'])
  assert.equal(result.results[0].result.status, 'error')
  assert.equal(result.results[0].result.message, '采集失败：network probe')
  assert.equal(result.results[1].result.status, 'ok')
  assert.deepEqual(errors, ['network probe'])
})

test('lastFetchedAt 写入失败不改写已完成的采集结果', async () => {
  const runner = new CollectionRunner({
    listSources: () => [source('one', 'rss')],
    collectSource: async (item) => ok(item.id),
    markFetchedAt: () => {
      throw new Error('sources.json locked')
    }
  })

  const result = await runner.runAutomatic()

  assert.equal(result.results[0].result.status, 'ok')
  assert.deepEqual(result.metadataErrors, [
    { sourceId: 'one', message: 'sources.json locked' }
  ])
})

test('手动指定 source 时可精确采集 disabled source，并始终发送 idle', async () => {
  const progress: string[] = []
  const runner = new CollectionRunner({
    listSources: () => [source('off', 'rss', undefined, false), source('on', 'rss')],
    collectSource: async (item) => ok(item.id),
    onProgress: (value) => progress.push(`${value.phase}:${value.currentSource ?? ''}`)
  })

  const result = await runner.runManual('off')

  assert.deepEqual(result.results.map((item) => item.source.id), ['off'])
  assert.deepEqual(progress, ['polling:off', 'idle:'])
})

test('waitForIdle 等待整批来源和 lastFetchedAt 写入完成', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  let metadataFinished = false
  const runner = new CollectionRunner({
    listSources: () => [source('a', 'rss')],
    collectSource: async (current) => {
      await gate
      return ok(current.id)
    },
    markFetchedAt: async () => {
      await Promise.resolve()
      metadataFinished = true
    }
  })

  const run = runner.runManual()
  let idle = false
  const waiting = runner.waitForIdle().then(() => {
    idle = true
  })
  await Promise.resolve()
  assert.equal(idle, false)
  release()
  await Promise.all([run, waiting])
  assert.equal(metadataFinished, true)
  assert.equal(idle, true)
})

test('优雅退出只等待当前 source 完成，不再启动批次剩余来源', async () => {
  const sources = [source('first', 'rss'), source('second', 'rss')]
  const started: string[] = []
  let stopping = false
  let releaseCurrent!: () => void
  const current = new Promise<void>((resolve) => { releaseCurrent = resolve })
  const runner = new CollectionRunner({
    listSources: () => sources,
    shouldStop: () => stopping,
    collectSource: async (item) => {
      started.push(item.id)
      if (item.id === 'first') await current
      return ok(item.id)
    }
  })

  const batch = runner.runManual()
  await Promise.resolve()
  stopping = true
  releaseCurrent()
  const result = await batch

  assert.deepEqual(started, ['first'])
  assert.deepEqual(result.results.map(({ source: item }) => item.id), ['first'])
  assert.equal(runner.isBusy(), false)
})

test('新增 source 在当前批次结束后补跑首次采集', async () => {
  const hold = deferred<CollectResult>()
  const started: string[] = []
  const runner = new CollectionRunner({
    listSources: () => [source('existing', 'rss'), source('new', 'rss')],
    collectSource: async (item) => {
      started.push(item.id)
      if (item.id === 'existing') return hold.promise
      return ok(item.id)
    }
  })

  const current = runner.runManual('existing')
  const initial = runner.runInitialWhenIdle('new')
  await Promise.resolve()
  assert.deepEqual(started, ['existing'])

  hold.resolve(ok('existing'))
  const [, initialResult] = await Promise.all([current, initial])
  assert.deepEqual(started, ['existing', 'new'])
  assert.equal(initialResult.status, 'completed')
  assert.deepEqual(initialResult.results.map(({ source: item }) => item.id), ['new'])
})

test('退出时取消仍在等待的新增 source 首次采集', async () => {
  const hold = deferred<CollectResult>()
  const started: string[] = []
  let stopping = false
  const runner = new CollectionRunner({
    listSources: () => [source('existing', 'rss'), source('new', 'rss')],
    shouldStop: () => stopping,
    collectSource: async (item) => {
      started.push(item.id)
      if (item.id === 'existing') return hold.promise
      return ok(item.id)
    }
  })

  const current = runner.runManual('existing')
  const initial = runner.runInitialWhenIdle('new')
  stopping = true
  hold.resolve(ok('existing'))
  const [, initialResult] = await Promise.all([current, initial])

  assert.deepEqual(started, ['existing'])
  assert.equal(initialResult.status, 'skipped_busy')
})
