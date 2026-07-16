import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildWechatSrcdoc,
  normalizeWechatExternalLinks
} from '../src/renderer/src/wechat-html'

test('微信正文 srcdoc 保留原始节点与内联样式，并设置原文为相对链接基准', () => {
  const content = '<div id="js_content"><section style="color:#f00">原始排版</section></div>'
  const document = buildWechatSrcdoc(content, 'https://mp.weixin.qq.com/s/example?a=1&b=2')
  assert.match(document, /<base href="https:\/\/mp\.weixin\.qq\.com\/s\/example\?a=1&amp;b=2" target="_blank">/)
  assert.ok(document.includes(content))
  assert.match(document, /#js_content \{[\s\S]*visibility: visible !important;/)
})

test('空正文不会生成 iframe 文档', () => {
  assert.equal(buildWechatSrcdoc('   ', 'https://mp.weixin.qq.com/'), '')
})

test('srcdoc 的 base 只接受微信官方 HTTPS 域名', () => {
  const document = buildWechatSrcdoc('<div id="js_content">正文</div>', 'https://example.com/bad')
  assert.match(document, /<base href="https:\/\/mp\.weixin\.qq\.com\/"/)
  assert.doesNotMatch(document, /example\.com/)
})

test('旧正文里会留在 iframe 的链接在展示时统一改为外部打开', () => {
  const normalized = normalizeWechatExternalLinks(
    '<div><a href="/s/next" target="_self" rel="opener">下一篇</a></div>'
  )
  assert.match(normalized, /href="\/s\/next"/)
  assert.match(normalized, /target="_blank"/)
  assert.match(normalized, /rel="noopener noreferrer"/)
  assert.doesNotMatch(normalized, /target="_self"|rel="opener"/)
})
