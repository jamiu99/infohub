// 正文抓取 HTML→markdown 转换测试。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractContentHtml, htmlToMarkdown, fetchArticleBody } from '../src/core/process/content'

test('extractContentHtml 截取 #js_content 内容', () => {
  const html = `<html><body><div id="js_content" class="rich_media"><p>正文段落</p></div><script>x</script></body></html>`
  const c = extractContentHtml(html)
  assert.ok(c && c.includes('正文段落'))
})

test('htmlToMarkdown：段落/标题/加粗/链接/图片', () => {
  const html =
    '<h2>小标题</h2><p>这是<strong>重点</strong>内容</p>' +
    '<p><a href="https://x.com">链接</a></p>' +
    '<img data-src="https://x.com/a.jpg" />'
  const md = htmlToMarkdown(html)
  assert.ok(md.includes('## 小标题'))
  assert.ok(md.includes('**重点**'))
  assert.ok(md.includes('[链接](https://x.com)'))
  assert.ok(md.includes('![](https://x.com/a.jpg)'))
})

test('htmlToMarkdown 解码 HTML 实体', () => {
  assert.equal(htmlToMarkdown('<p>a&amp;b&nbsp;c</p>'), 'a&b c')
})

test('fetchArticleBody 失败返回 null（不抛）', async () => {
  const fakeFetch = (async () => ({ ok: false })) as unknown as typeof fetch
  assert.equal(await fetchArticleBody('http://x', fakeFetch), null)
})

test('fetchArticleBody 成功抓取并转换', async () => {
  const page = `<div id="js_content"><p>你好<strong>世界</strong></p></div><script></script>`
  const fakeFetch = (async () => ({ ok: true, text: async () => page })) as unknown as typeof fetch
  const md = await fetchArticleBody('http://x', fakeFetch)
  assert.ok(md && md.includes('你好**世界**'))
})
