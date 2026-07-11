import { test } from 'node:test'
import assert from 'node:assert/strict'
import { renderMarkdown, safeExternalUrl } from '../src/renderer/src/markdown'

test('safeExternalUrl 只接受绝对 http(s) URL', () => {
  assert.equal(safeExternalUrl('https://example.com/a'), 'https://example.com/a')
  assert.equal(safeExternalUrl('http://example.com/a'), 'http://example.com/a')
  assert.equal(safeExternalUrl('javascript:alert(1)'), null)
  assert.equal(safeExternalUrl('data:text/html,<script>alert(1)</script>'), null)
  assert.equal(safeExternalUrl('file:///etc/passwd'), null)
  assert.equal(safeExternalUrl('/relative/path'), null)
})

test('renderMarkdown 保留受支持格式并给外链加隔离属性', () => {
  const html = renderMarkdown(
    '# 标题\n\n**重点** 和 [原文](https://example.com/a?x=1&y=2)\n\n![](https://img.example.com/a.png)'
  )
  assert.match(html, /<h1>标题<\/h1>/)
  assert.match(html, /<strong>重点<\/strong>/)
  assert.match(html, /href="https:\/\/example\.com\/a\?x=1&amp;y=2"/)
  assert.match(html, /rel="noopener noreferrer"/)
  assert.match(html, /<img src="https:\/\/img\.example\.com\/a\.png"/)
})

test('renderMarkdown 拒绝危险 scheme 并转义原始 HTML', () => {
  const html = renderMarkdown(
    '[危险链接](javascript:alert(1))\n\n![危险图片](data:image/svg+xml,<svg onload=alert(1)>)\n\n<script>alert(1)</script>'
  )
  assert.doesNotMatch(html, /<a\b/)
  assert.doesNotMatch(html, /<img\b/)
  assert.doesNotMatch(html, /<script\b/)
  assert.match(html, /&lt;script&gt;/)
})

test('renderMarkdown 不允许 URL 引号注入事件属性', () => {
  const html = renderMarkdown('![图](https://example.com/x" onerror="alert(1))')
  assert.doesNotMatch(html, /<img[^>]+\sonerror=/i)
})
