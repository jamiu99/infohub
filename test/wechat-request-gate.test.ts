import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WechatRequestGate } from '../src/core/collect/wechat-request-gate.ts'

test('并发提交的认证请求全局串行，开始时间至少间隔默认值', async () => {
  let now = 0
  const sleeps: number[] = []
  const starts: number[] = []
  const gate = new WechatRequestGate({
    intervalMs: 10_000,
    now: () => now,
    sleep: async (delay) => {
      sleeps.push(delay)
      now += delay
    }
  })

  const values = await Promise.all([
    gate.run(() => {
      starts.push(now)
      return 'a'
    }),
    gate.run(() => {
      starts.push(now)
      return 'b'
    }),
    gate.run(() => {
      starts.push(now)
      return 'c'
    })
  ])

  assert.deepEqual(values, ['a', 'b', 'c'])
  assert.deepEqual(starts, [0, 10_000, 20_000])
  assert.deepEqual(sleeps, [10_000, 10_000])
})

test('从上一个请求完成后计算完整间隔，保持保守节流', async () => {
  let now = 0
  const sleeps: number[] = []
  const starts: number[] = []
  const gate = new WechatRequestGate({
    intervalMs: 10_000,
    now: () => now,
    sleep: async (delay) => {
      sleeps.push(delay)
      now += delay
    }
  })

  await gate.run(() => {
    starts.push(now)
    now += 4_000
  })
  await gate.run(() => {
    starts.push(now)
  })

  assert.deepEqual(starts, [0, 14_000])
  assert.deepEqual(sleeps, [10_000])
})

test('失败请求不会污染队列，后续请求仍遵守间隔', async () => {
  let now = 0
  const starts: number[] = []
  const gate = new WechatRequestGate({
    intervalMs: 10_000,
    now: () => now,
    sleep: async (delay) => {
      now += delay
    }
  })

  const failed = gate.run(() => {
    starts.push(now)
    throw new Error('200013')
  })
  const recovered = gate.run(() => {
    starts.push(now)
    return 'ok'
  })

  await assert.rejects(failed, /200013/)
  assert.equal(await recovered, 'ok')
  assert.deepEqual(starts, [0, 10_000])
})

test('单次可提高请求前间隔，供换号重试使用', async () => {
  let now = 0
  const starts: number[] = []
  const gate = new WechatRequestGate({
    intervalMs: 10_000,
    now: () => now,
    sleep: async (delay) => {
      now += delay
    }
  })

  await gate.run(() => starts.push(now))
  await gate.run(() => starts.push(now), 15_000)

  assert.deepEqual(starts, [0, 15_000])
})

test('非法间隔被拒绝且不会执行请求', async () => {
  let called = false
  assert.throws(() => new WechatRequestGate({ intervalMs: -1 }), /非负数/)

  const gate = new WechatRequestGate({ intervalMs: 10 })
  await assert.rejects(
    gate.run(() => {
      called = true
    }, -1),
    /非负数/
  )
  assert.equal(called, false)
})
