// RSS 解析 + adapter + 归一化测试（离线，注入假 fetch）。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { parseFeed, fetchFeed, entryToRawItem } from '../src/core/ingest/rss'
import { RssAdapter } from '../src/core/ingest/rss-adapter'
import { normalizeRss } from '../src/core/process/rss'
import type { Source } from '../src/shared/contract'

const RSS_XML = `<?xml version="1.0"?>
<rss version="2.0"><channel>
  <title>测试博客</title>
  <item>
    <title>第一篇文章</title>
    <link>https://example.com/a</link>
    <guid>https://example.com/a</guid>
    <pubDate>Wed, 02 Jul 2025 10:00:00 GMT</pubDate>
    <description>摘要内容</description>
    <content:encoded><![CDATA[<p>正文<strong>加粗</strong></p>]]></content:encoded>
  </item>
  <item>
    <title>第二篇</title>
    <link>https://example.com/b</link>
    <guid>https://example.com/b</guid>
  </item>
</channel></rss>`

const ATOM_XML = `<?xml version="1.0"?>
<feed xmlns="http://www.w3.org/2005/Atom">
  <title>Atom 源</title>
  <entry>
    <title>Atom 文章</title>
    <link href="https://example.com/atom1"/>
    <id>urn:atom1</id>
    <updated>2025-07-01T12:00:00Z</updated>
    <summary>atom 摘要</summary>
  </entry>
</feed>`

test('parseFeed 解析 RSS', () => {
  const feed = parseFeed(RSS_XML)
  assert.equal(feed.title, '测试博客')
  assert.equal(feed.entries.length, 2)
  assert.equal(feed.entries[0].title, '第一篇文章')
  assert.equal(feed.entries[0].link, 'https://example.com/a')
  assert.ok(feed.entries[0].content?.includes('正文'))
})

test('parseFeed 解析 Atom（link href + id）', () => {
  const feed = parseFeed(ATOM_XML)
  assert.equal(feed.title, 'Atom 源')
  assert.equal(feed.entries[0].link, 'https://example.com/atom1')
  assert.equal(feed.entries[0].guid, 'urn:atom1')
})

test('RssAdapter.fetch 产出 RawItem', async () => {
  const fakeFetch = (async () => ({ ok: true, text: async () => RSS_XML })) as unknown as typeof fetch
  const adapter = new RssAdapter({ fetchImpl: fakeFetch })
  const source: Source = { id: 'rss-x', type: 'rss', name: '测试', enabled: true, config: { feedUrl: 'http://x' } }
  const out = await adapter.fetch(source)
  assert.equal(out.status, 'ok')
  assert.equal(out.items.length, 2)
  assert.equal(out.items[0].sourceType, 'rss')
})

test('RssAdapter.discover 试探 feed URL', async () => {
  const fakeFetch = (async () => ({ ok: true, text: async () => RSS_XML })) as unknown as typeof fetch
  const adapter = new RssAdapter({ fetchImpl: fakeFetch })
  const results = await adapter.discover('https://example.com/feed.xml')
  assert.equal(results.length, 1)
  assert.equal(results[0].name, '测试博客')
  assert.equal((results[0].config as { feedUrl: string }).feedUrl, 'https://example.com/feed.xml')
  // 非 URL 不接受
  assert.equal((await adapter.discover('随便搜索词')).length, 0)
})

test('normalizeRss：content→markdown 正文 + 时间', () => {
  const entry = parseFeed(RSS_XML).entries[0]
  const raw = entryToRawItem('rss-x', entry)
  const source: Source = { id: 'rss-x', type: 'rss', name: '测试', enabled: true, config: {} }
  const article = normalizeRss(raw, source)
  assert.equal(article.title, '第一篇文章')
  assert.ok(article.body.includes('**加粗**')) // HTML→md
  assert.ok(article.publishedAt > 0)
  assert.equal(article.source.type, 'rss')
})

test('fetchFeed 失败返回 null', async () => {
  const fakeFetch = (async () => ({ ok: false })) as unknown as typeof fetch
  assert.equal(await fetchFeed('http://x', fakeFetch), null)
})
