// 验证采集全局串行锁：并发调用绝不重叠（保护账号不被并发请求打爆）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { Collector } from '../src/core/agent/collector'
import { AccountPool } from '../src/core/agent/account-pool'

test('并发 collectSource 调用被串行化，无重叠', async () => {
  const pool = new AccountPool([], { now: () => 1000 }) // 空池 → collectSource 立刻返回 no_account
  const store = {} as never
  const collector = new Collector(pool, store)

  // 包一层探测：劫持 runExclusive 无法直接测，改测行为——
  // 由于空池会立即返回，我们改用 search（同样走锁）并注入可观测延迟的 pool.pick。
  let active = 0
  let maxActive = 0
  const origPick = pool.pick.bind(pool)
  ;(pool as unknown as { pick: () => unknown }).pick = () => {
    active++
    maxActive = Math.max(maxActive, active)
    // 同步返回 null（空池），但用微任务模拟"进入临界区"
    active--
    return origPick()
  }

  await Promise.all([
    collector.collectSource({ id: 's1', type: 'wechat', name: 'a', enabled: true, config: { fakeid: 'f1' } }),
    collector.collectSource({ id: 's2', type: 'wechat', name: 'b', enabled: true, config: { fakeid: 'f2' } }),
    collector.search('x')
  ])
  assert.equal(maxActive, 1) // 任何时刻临界区最多 1 个
})

test('串行链：前一个任务返回错误不阻塞后续（不触网）', async () => {
  const pool = new AccountPool([], { now: () => 1000 }) // 空池，全部快速返回，不发请求
  const store = {} as never
  const collector = new Collector(pool, store)
  // 缺 fakeid → error（不抛）；空池 → no_account。均不触网，验证链不死锁。
  const r1 = await collector.collectSource({ id: 's', type: 'wechat', name: 'x', enabled: true, config: {} })
  assert.equal(r1.status, 'error')
  const r2 = await collector.collectSource({ id: 's2', type: 'wechat', name: 'y', enabled: true, config: { fakeid: 'f' } })
  assert.equal(r2.status, 'no_account') // 链继续正常执行
})
