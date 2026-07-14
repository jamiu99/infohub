// 正文抓取 HTML→markdown 转换测试。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  extractContentHtml,
  extractDisplayContentHtml,
  htmlToMarkdown,
  parseWechatArticleContent,
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

test('纯解析入口保留经典 #js_content 行为并使用新版解析器', () => {
  const page = '<html><div id="js_content"><p>经典正文</p></div></html>'
  const result = parseWechatArticleContent(page, 'https://mp.weixin.qq.com/s/classic')
  assert.equal(result.status, 'complete')
  assert.equal(result.parserVersion, 2)
  assert.equal(result.pageHtml, page)
  assert.match(result.contentHtml ?? '', /id="js_content"/)
  assert.match(result.body, /经典正文/)
})

test('图片消息读取 picture_page_info_list 的顶层正文图片与文案', () => {
  const page = String.raw`<!doctype html><html><body>
    <script>
      window.cgiDataNew = {
        item_show_type: '8' * 1,
        content_noencode: '第一段\x0a\x0a\x3ca href=\x22https://example.com/topic\x22\x3e@伙伴\x3c/a\x3e #话题',
        picture_page_info_list: [
          {
            cdn_url: 'https://mmbiz.qpic.cn/main-a.jpg?x=1\x26amp;y=2',
            width: '1188' * 1,
            height: '1358' * 1,
            watermark_info: { cdn_url: 'https://mmbiz.qpic.cn/watermark.jpg' },
            share_cover: { cdn_url: 'https://mmbiz.qpic.cn/share-a.jpg' }
          },
          {
            cdn_url: 'https://mmbiz.qpic.cn/main-b.jpg',
            width: 640,
            height: 480,
            share_cover: { cdn_url: 'https://mmbiz.qpic.cn/share-b.jpg' }
          }
        ]
      };
    </script>
    <div id="img_list"></div>
  </body></html>`

  const result = parseWechatArticleContent(page, 'https://mp.weixin.qq.com/s/picture')

  assert.equal(result.status, 'complete')
  assert.equal(result.parserVersion, 2)
  assert.match(result.contentHtml ?? '', /data-infohub-wechat-variant="picture"/)
  assert.match(result.contentHtml ?? '', /main-a\.jpg\?x=1&amp;y=2/)
  assert.match(result.contentHtml ?? '', /width="1188" height="1358"/)
  assert.match(result.contentHtml ?? '', /main-b\.jpg/)
  assert.match(result.contentHtml ?? '', /第一段/)
  assert.match(result.contentHtml ?? '', /@伙伴 #话题/)
  assert.doesNotMatch(result.contentHtml ?? '', /watermark\.jpg|share-[ab]\.jpg/)
  assert.match(result.body, /!\[\]\(https:\/\/mmbiz\.qpic\.cn\/main-a\.jpg\?x=1&y=2\)/)
  assert.match(result.body, /\[@伙伴\]\(https:\/\/example\.com\/topic\)/)
})

test('图片消息兼容独立 window.picture_page_info_list 静态数组', () => {
  const page = String.raw`<script>
    window.picture_page_info_list = [
      {
        cdn_url: 'https://mmbiz.qpic.cn/legacy-main.jpg',
        width: '800' * 1,
        height: '600' * 1,
        share_cover: { cdn_url: 'https://mmbiz.qpic.cn/legacy-share.jpg' }
      }
    ].slice(0, 20);
  </script><div id="img_list"></div>`
  const result = parseWechatArticleContent(page, 'https://mp.weixin.qq.com/s/legacy-picture')
  assert.equal(result.status, 'complete')
  assert.match(result.contentHtml ?? '', /legacy-main\.jpg/)
  assert.doesNotMatch(result.contentHtml ?? '', /legacy-share\.jpg/)
})

test('图片消息字段拒绝函数调用、拼接和模板字符串，不执行页面表达式', () => {
  const marker = '__infohubWechatParserMustNotExecute'
  ;(globalThis as Record<string, unknown>)[marker] = false
  const page = `<script>
    window.cgiDataNew = {
      content_noencode: (() => { globalThis.${marker} = true; return '危险文案' })(),
      picture_page_info_list: [{
        cdn_url: 'https://mmbiz.qpic.cn/not-static.jpg' + (() => {
          globalThis.${marker} = true
          return ''
        })(),
        width: getWidth(),
        height: \`600\`
      }]
    };
  </script>`
  try {
    const result = parseWechatArticleContent(page, 'https://mp.weixin.qq.com/s/reject-code')
    assert.equal(result.status, 'failed')
    assert.equal(result.error?.code, 'picture_content_invalid')
    assert.equal((globalThis as Record<string, unknown>)[marker], false)
    assert.equal(result.contentHtml, undefined)
  } finally {
    delete (globalThis as Record<string, unknown>)[marker]
  }
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

test('fetchArticleContent 对 HTTP 错误页也先保存未改写响应', async () => {
  const page = '<html><body><p>访问验证页</p></body></html>'
  const fakeFetch = (async () => ({
    ok: false,
    status: 403,
    text: async () => page
  })) as unknown as typeof fetch
  const result = await fetchArticleContent('https://mp.weixin.qq.com/s/example', fakeFetch)
  assert.equal(result.status, 'failed')
  assert.equal(result.error?.code, 'http_error')
  assert.equal(result.pageHtml, page)
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
