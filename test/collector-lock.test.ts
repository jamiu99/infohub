// 验证采集全局串行锁：并发调用绝不重叠（保护账号不被并发请求打爆）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Collector } from '../src/core/collect/collector'
import { AdapterRegistry } from '../src/core/ingest/adapter'
import type { SourceAdapter, FetchOutcome } from '../src/core/ingest/adapter'
import { registerNormalizer } from '../src/core/process/normalize'
import type { Source } from '../src/shared/contract'

// 注册一个测试 normalizer
registerNormalizer('test', (item, source) => ({
  id: `${source.id}-${item.externalId}`,
  externalId: item.externalId,
  title: 't',
  body: '',
  publishedAt: 0,
  sourceUrl: '',
  source: { id: source.id, type: source.type, name: source.name },
  ext: {},
  createdAt: 0,
  updatedAt: 0
}))

// 一个可观测并发的假 adapter：fetch 里记录同时进入的数量
function makeProbeAdapter(): { adapter: SourceAdapter; maxActive: () => number } {
  let active = 0
  let maxActive = 0
  const adapter: SourceAdapter = {
    type: 'test',
    async fetch(): Promise<FetchOutcome> {
      active++
      maxActive = Math.max(maxActive, active)
      await new Promise((r) => setTimeout(r, 20)) // 模拟耗时
      active--
      return { items: [], status: 'ok' }
    }
  }
  return { adapter, maxActive: () => maxActive }
}

const fakeStore = { isSeen: () => false, saveRaw() {}, saveArticle: (a: unknown) => a, markSeen() {} } as never

test('并发 collectSource 调用被串行化，无重叠', async () => {
  const { adapter, maxActive } = makeProbeAdapter()
  const registry = new AdapterRegistry()
  registry.register(adapter)
  const collector = new Collector(registry, fakeStore)

  const src = (id: string): Source => ({ id, type: 'test', name: id, enabled: true, config: {} })
  await Promise.all([
    collector.collectSource(src('s1')),
    collector.collectSource(src('s2')),
    collector.collectSource(src('s3'))
  ])
  assert.equal(maxActive(), 1) // 任何时刻临界区最多 1 个
})

test('未知 type 返回 error，不阻塞后续', async () => {
  const registry = new AdapterRegistry()
  const collector = new Collector(registry, fakeStore)
  const r1 = await collector.collectSource({ id: 's', type: 'nope', name: 'x', enabled: true, config: {} })
  assert.equal(r1.status, 'error')
  // 链继续：注册 test adapter 后可正常跑
  registry.register(makeProbeAdapter().adapter)
  const r2 = await collector.collectSource({ id: 's2', type: 'test', name: 'y', enabled: true, config: {} })
  assert.equal(r2.status, 'ok')
})
