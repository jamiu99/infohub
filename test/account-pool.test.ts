// 账号池/限流调度核心逻辑测试（纯逻辑，无 Electron）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { AccountPool } from '../src/core/collect/account-pool.ts'
import { RATE_LIMIT } from '../src/core/collect/rate-limit.ts'
import type { WxAccount } from '../src/shared/wechat.ts'

function acc(id: string, over: Partial<WxAccount> = {}): WxAccount {
  return {
    id,
    token: 't',
    cookies: {},
    partition: `persist:wx-${id}`,
    status: 'active',
    requestsThisHour: 0,
    windowStart: 0,
    totalRequests: 0,
    ...over
  }
}

test('pick 选用得最少的 active 账号（负载均衡）', () => {
  const pool = new AccountPool([acc('a', { requestsThisHour: 10 }), acc('b', { requestsThisHour: 2 })], {
    now: () => 1000
  })
  assert.equal(pool.pick()?.id, 'b')
})

test('超小时配额的账号不被选', () => {
  const pool = new AccountPool([acc('a', { requestsThisHour: RATE_LIMIT.hourLimit })], { now: () => 1000 })
  assert.equal(pool.pick(), null)
})

test('自定义小时上限立即用于调度和健康快照', () => {
  const pool = new AccountPool([acc('a', { requestsThisHour: 7 })], {
    now: () => 1000,
    hourLimit: 7
  })
  assert.equal(pool.views()[0].hourLimit, 7)
  assert.equal(pool.pick(), null)

  pool.setHourLimit(8)
  assert.equal(pool.views()[0].hourLimit, 8)
  assert.equal(pool.pick()?.id, 'a')
})

test('命中 200013 → 账号 cooldown 且提示换号重试', () => {
  let t = 1000
  const pool = new AccountPool([acc('a')], { now: () => t })
  const { retry } = pool.handleResult('a', { ok: false, reason: 'freq_control', message: '200013' })
  assert.equal(retry, true)
  assert.equal(pool.get('a')?.status, 'cooldown')
  assert.equal(pool.pick(), null) // cooldown 中不可选
})

test('记录累计请求数和最近一次触发 200013 的准确请求序号', () => {
  const now = 1_700_000_000_000
  const pool = new AccountPool(
    [acc('a', { requestsThisHour: 11, totalRequests: 34, windowStart: now })],
    { now: () => now }
  )

  pool.noteRequest('a')
  pool.handleResult('a', { ok: false, reason: 'freq_control', message: '200013' })

  const view = pool.views()[0]
  assert.equal(view.requestsThisHour, 12)
  assert.equal(view.totalRequests, 35)
  assert.equal(view.lastRateLimitedAt, now)
  assert.equal(view.requestsAtLastRateLimit, 12)
  assert.equal(view.totalRequestsAtLastRateLimit, 35)
})

test('cooldown 到期后自动恢复 active', () => {
  let t = 1000
  const pool = new AccountPool([acc('a')], { now: () => t })
  pool.handleResult('a', { ok: false, reason: 'freq_control', message: '200013' })
  t += RATE_LIMIT.cooldownMs + 1
  assert.equal(pool.pick()?.id, 'a')
})

test('cookie 失效 → expired 且换号', () => {
  const pool = new AccountPool([acc('a')], { now: () => 1000 })
  const { retry } = pool.handleResult('a', { ok: false, reason: 'expired', message: '-1' })
  assert.equal(retry, true)
  assert.equal(pool.get('a')?.status, 'expired')
})

test('小时窗口滚动后计数清零', () => {
  let t = 1000
  const pool = new AccountPool([acc('a', { requestsThisHour: RATE_LIMIT.hourLimit, windowStart: 1000 })], {
    now: () => t
  })
  assert.equal(pool.pick(), null)
  t += 60 * 60 * 1000 + 1
  assert.equal(pool.pick()?.id, 'a')
  assert.equal(pool.get('a')?.requestsThisHour, 0)
})

test('小时窗口滚动只清当前配额，不清累计与限流观测', () => {
  let t = 1000
  const pool = new AccountPool(
    [
      acc('a', {
        requestsThisHour: 20,
        windowStart: t,
        totalRequests: 80,
        lastRateLimitedAt: 900,
        requestsAtLastRateLimit: 18,
        totalRequestsAtLastRateLimit: 78
      })
    ],
    { now: () => t }
  )
  t += 60 * 60 * 1000 + 1
  const view = pool.views()[0]
  assert.equal(view.requestsThisHour, 0)
  assert.equal(view.totalRequests, 80)
  assert.equal(view.lastRateLimitedAt, 900)
  assert.equal(view.requestsAtLastRateLimit, 18)
})

test('升级旧账号记录时用当前窗口计数初始化累计请求数', () => {
  const legacy = acc('a', { requestsThisHour: 6 }) as WxAccount & { totalRequests?: number }
  delete legacy.totalRequests
  const pool = new AccountPool([legacy as WxAccount], { now: () => 1000 })
  assert.equal(pool.views()[0].totalRequests, 6)
})

test('重新扫码后凭证刷新并复活', () => {
  const pool = new AccountPool([acc('a', { status: 'expired' })], { now: () => 1000 })
  pool.refreshCredentials('a', { token: 'new', cookies: { x: '1' } })
  assert.equal(pool.get('a')?.status, 'active')
  assert.equal(pool.get('a')?.token, 'new')
})

test('earliestRecovery：有可用账号返回当前时刻', () => {
  const pool = new AccountPool([acc('a')], { now: () => 5000 })
  assert.equal(pool.earliestRecovery(), 5000)
})
