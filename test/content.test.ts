// 正文抓取 HTML→markdown 转换测试。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  extractContentHtml,
  extractDisplayContentHtml,
  htmlToMarkdown,
  fetchArticleContent
} from '../src/core/process/content'

test('extractContentHtml 截取 #js_content 内容', () => {
  const html = `<html><body><div id="js_content" class="rich_media"><p>正文段落</p></div><script>x</script></body></html>`
  const c = extractContentHtml(html)
  assert.ok(c && c.includes('正文段落'))
})

test('extractContentHtml 使用 DOM 解析，正文内部嵌套 div 不会提前截断', () => {
  const html = `<main><div id="js_content"><section><div><p>第一段</p></div><p>第二段</p></section></div><footer>页脚</footer></main>`
  const content = extractContentHtml(html)
  assert.ok(content?.includes('第一段'))
  assert.ok(content?.includes('第二段'))
  assert.doesNotMatch(content ?? '', /页脚/)
})

test('展示 HTML 保留正文外层样式，并把微信懒加载资源改成可直接加载', () => {
  const html = `<div id="js_content" style="color:red;visibility:hidden"><img src="data:image/gif;base64,x" data-src="/media/a.jpg"><a href="/s/next">下一篇</a></div>`
  const content = extractDisplayContentHtml(html, 'https://mp.weixin.qq.com/s/example')
  assert.match(content ?? '', /^<div id="js_content" style="color:red;visibility:hidden;visibility:visible!important;opacity:1!important;">/)
  assert.match(content ?? '', /src="https:\/\/mp\.weixin\.qq\.com\/media\/a\.jpg"/)
  assert.match(content ?? '', /href="https:\/\/mp\.weixin\.qq\.com\/s\/next"/)
  assert.match(content ?? '', /target="_blank"/)
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

test('fetchArticleContent 同时返回未改写页面、展示 HTML 与 Markdown', async () => {
  const page = `<html><body><div id="js_content"><p>完整正文</p><img data-src="https://mmbiz.qpic.cn/a.jpg"></div><script>window.x=1</script></body></html>`
  const fakeFetch = (async () => ({
    ok: true,
    status: 200,
    text: async () => page
  })) as unknown as typeof fetch
  const result = await fetchArticleContent('https://mp.weixin.qq.com/s/example', fakeFetch)
  assert.equal(result.status, 'complete')
  assert.equal(result.pageHtml, page)
  assert.match(result.contentHtml ?? '', /id="js_content"/)
  assert.match(result.body, /完整正文/)
  assert.match(result.body, /!\[\]\(https:\/\/mmbiz\.qpic\.cn\/a\.jpg\)/)
})

test('fetchArticleContent 找不到正文时仍保留完整页面，供以后重解析', async () => {
  const page = '<html><body><p>访问提示页</p></body></html>'
  const fakeFetch = (async () => ({
    ok: true,
    status: 200,
    text: async () => page
  })) as unknown as typeof fetch
  const result = await fetchArticleContent('https://mp.weixin.qq.com/s/example', fakeFetch)
  assert.equal(result.status, 'failed')
  assert.equal(result.error?.code, 'content_missing')
  assert.equal(result.pageHtml, page)
  assert.equal(result.contentHtml, undefined)
})

test('fetchArticleContent 不把空壳正文容器标记为完成', async () => {
  const page = '<html><body><div id="js_content"> \n <p><br></p></div></body></html>'
  const fakeFetch = (async () => ({
    ok: true,
    status: 200,
    text: async () => page
  })) as unknown as typeof fetch
  const result = await fetchArticleContent('https://mp.weixin.qq.com/s/example', fakeFetch)
  assert.equal(result.status, 'failed')
  assert.equal(result.error?.code, 'content_empty')
  assert.equal(result.pageHtml, page)
  assert.equal(result.contentHtml, undefined)
})

test('fetchArticleContent 把超时异常记录为可读中文', async () => {
  const fakeFetch = (async () => {
    throw new DOMException('The operation was aborted due to timeout', 'TimeoutError')
  }) as unknown as typeof fetch
  const result = await fetchArticleContent('https://mp.weixin.qq.com/s/example', fakeFetch)
  assert.equal(result.status, 'failed')
  assert.equal(result.error?.code, 'fetch_failed')
  assert.match(result.error?.message ?? '', /超时/)
  assert.doesNotMatch(result.error?.message ?? '', /operation was aborted/i)
})
