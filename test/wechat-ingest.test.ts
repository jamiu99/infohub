import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  listArticlesPage,
  toRawItem,
  WECHAT_BACKEND_TIMEOUT_MS,
  wechatExternalId
} from '../src/core/ingest/wechat.ts'
import { normalizeWechat } from '../src/core/process/wechat.ts'
import type { Source } from '../src/shared/contract.ts'
import type { WxAccount } from '../src/shared/wechat.ts'

const source: Source = {
  id: 'wechat-source',
  type: 'wechat',
  name: '测试公众号',
  enabled: true,
  config: { fakeid: 'fakeid-for-tests' }
}

function account(): WxAccount {
  return {
    id: 'wechat-account',
    token: 'test-token',
    cookies: { session: 'test-session' },
    partition: 'persist:wechat-account',
    status: 'active',
    requestsThisHour: 0,
    windowStart: 0,
    totalRequests: 0
  }
}

test('微信公开链接的可变参数不影响 externalId', () => {
  const first = wechatExternalId({
    link:
      'https://mp.weixin.qq.com/s?__biz=MzYyMTY1NDA0Nw==&mid=2247519535&idx=1&sn=first&chksm=aaa&scene=126#rd'
  })
  const second = wechatExternalId({
    link:
      'https://mp.weixin.qq.com/s?scene=21&chksm=bbb&__biz=MzYyMTY1NDA0Nw==&idx=1&mid=2247519535&sn=second#wechat_redirect'
  })

  assert.equal(first, 'biz:MzYyMTY1NDA0Nw==:mid:2247519535:idx:1')
  assert.equal(second, first)
})

test('后台 aid 优先于 appmsgid 和公开链接', () => {
  assert.equal(
    wechatExternalId({
      aid: '2247519535_1',
      appmsgid: 'another-message',
      itemidx: 9,
      link: 'https://mp.weixin.qq.com/s?__biz=biz&mid=third-message&idx=3'
    }),
    'aid:2247519535_1'
  )
})

test('同一 appmsgid 的不同 itemidx 保持为不同条目和 Article', () => {
  const first = toRawItem(source.id, {
    appmsgid: '2247519535',
    itemidx: 1,
    title: '头条',
    link: 'https://mp.weixin.qq.com/s?mid=2247519535&idx=1'
  })
  const second = toRawItem(source.id, {
    appmsgid: '2247519535',
    itemidx: 2,
    title: '次条',
    link: 'https://mp.weixin.qq.com/s?mid=2247519535&idx=2'
  })

  assert.equal(first.externalId, 'mid:2247519535:idx:1')
  assert.equal(second.externalId, 'mid:2247519535:idx:2')
  assert.notEqual(first.externalId, second.externalId)
  assert.notEqual(normalizeWechat(first, source).id, normalizeWechat(second, source).id)
})

test('listArticlesPage 使用约 15 秒的 AbortSignal timeout', { concurrency: false }, async () => {
  const originalFetch = globalThis.fetch
  const originalTimeout = Object.getOwnPropertyDescriptor(AbortSignal, 'timeout')
  const timeoutSignal = new AbortController().signal
  let requestedTimeout: number | undefined
  let requestSignal: AbortSignal | null | undefined

  Object.defineProperty(AbortSignal, 'timeout', {
    configurable: true,
    writable: true,
    value: (milliseconds: number) => {
      requestedTimeout = milliseconds
      return timeoutSignal
    }
  })
  globalThis.fetch = (async (_input, init) => {
    requestSignal = init?.signal
    return new Response(
      JSON.stringify({ base_resp: { ret: 0, err_msg: 'ok' }, app_msg_cnt: 0, app_msg_list: [] }),
      { status: 200, headers: { 'content-type': 'application/json' } }
    )
  }) as typeof fetch

  try {
    const result = await listArticlesPage(account(), 'fakeid-for-tests', 0)

    assert.equal(result.ok, true)
    assert.equal(WECHAT_BACKEND_TIMEOUT_MS, 15_000)
    assert.equal(requestedTimeout, WECHAT_BACKEND_TIMEOUT_MS)
    assert.equal(requestSignal, timeoutSignal)
  } finally {
    globalThis.fetch = originalFetch
    if (originalTimeout) Object.defineProperty(AbortSignal, 'timeout', originalTimeout)
  }
})
