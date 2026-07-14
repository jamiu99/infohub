import { test } from 'node:test'
import assert from 'node:assert/strict'
import { WechatAdapter } from '../src/core/ingest/wechat-adapter.ts'
import { WechatRequestGate } from '../src/core/collect/wechat-request-gate.ts'
import type { AccountPool } from '../src/core/collect/account-pool.ts'
import type { Source } from '../src/shared/contract.ts'
import type { WxAccount } from '../src/shared/wechat.ts'

function account(id: string): WxAccount {
  return {
    id,
    token: 'token',
    cookies: {},
    partition: `persist:${id}`,
    status: 'active',
    requestsThisHour: 0,
    windowStart: 0,
    totalRequests: 0
  }
}

function source(id: string): Source {
  return { id, type: 'wechat', name: id, enabled: true, config: { fakeid: id } }
}

test('不同公众号连续采集也经过同一个 10 秒请求门', async () => {
  let now = 0
  const starts: number[] = []
  const selected = account('one')
  const pool = {
    pick: () => selected,
    noteRequest: () => undefined,
    handleResult: () => ({ retry: false })
  } as unknown as AccountPool
  const gate = new WechatRequestGate({
    intervalMs: 10_000,
    now: () => now,
    sleep: async (delay) => {
      now += delay
    }
  })
  const adapter = new WechatAdapter(pool, {
    requestGate: gate,
    listArticlesPage: async () => {
      starts.push(now)
      return { ok: true, data: { total: 0, items: [] } }
    }
  })

  await adapter.fetch(source('wx-a'))
  await adapter.fetch(source('wx-b'))

  assert.deepEqual(starts, [0, 10_000])
})

test('换号重试在下一次后台请求前等待 15 秒', async () => {
  let now = 0
  const starts: number[] = []
  const accounts = [account('one'), account('two')]
  let picked = 0
  const pool = {
    pick: () => accounts[Math.min(picked++, accounts.length - 1)],
    noteRequest: () => undefined,
    handleResult: () => ({ retry: true })
  } as unknown as AccountPool
  const gate = new WechatRequestGate({
    intervalMs: 10_000,
    now: () => now,
    sleep: async (delay) => {
      now += delay
    }
  })
  let calls = 0
  const adapter = new WechatAdapter(pool, {
    requestGate: gate,
    listArticlesPage: async () => {
      starts.push(now)
      calls++
      if (calls === 1) return { ok: false, reason: 'expired', message: 'expired' }
      return { ok: true, data: { total: 0, items: [] } }
    }
  })

  await adapter.fetch(source('wx-a'))

  assert.deepEqual(starts, [0, 15_000])
})

test('批量公开正文重抓共用 2 秒请求门', async () => {
  let now = 0
  const starts: number[] = []
  const pool = { pick: () => null } as unknown as AccountPool
  const gate = new WechatRequestGate({
    intervalMs: 2_000,
    now: () => now,
    sleep: async (delay) => {
      now += delay
    }
  })
  const adapter = new WechatAdapter(pool, {
    contentRequestGate: gate,
    fetchArticleContent: async () => {
      starts.push(now)
      return { body: '正文', status: 'complete', parserVersion: 2 }
    }
  })

  await adapter.enrichContent('https://mp.weixin.qq.com/s/one')
  await adapter.enrichContent('https://mp.weixin.qq.com/s/two')

  assert.deepEqual(starts, [0, 2_000])
})
