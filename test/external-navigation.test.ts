import { test } from 'node:test'
import assert from 'node:assert/strict'
import { shouldOpenFrameExternally } from '../src/main/external-navigation'

test('公众号子 frame 的 http(s) 导航交给系统浏览器', () => {
  assert.equal(
    shouldOpenFrameExternally({ isMainFrame: false, url: 'https://mp.weixin.qq.com/s/next' }),
    true
  )
  assert.equal(
    shouldOpenFrameExternally({ isMainFrame: false, url: 'http://example.com/article' }),
    true
  )
})

test('主 frame 与非网页协议不会被子 frame 外链兜底接管', () => {
  assert.equal(
    shouldOpenFrameExternally({ isMainFrame: true, url: 'https://example.com/' }),
    false
  )
  assert.equal(
    shouldOpenFrameExternally({ isMainFrame: false, url: 'javascript:alert(1)' }),
    false
  )
  assert.equal(
    shouldOpenFrameExternally({ isMainFrame: false, url: 'file:///tmp/private' }),
    false
  )
})
