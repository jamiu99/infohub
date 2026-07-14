// seen_items 只负责列表去重；正文失败必须允许后续手动刷新重试并补齐 HTML sidecar。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Collector } from '../src/core/collect/collector'
import { AdapterRegistry, type SourceAdapter } from '../src/core/ingest/adapter'
import { registerNormalizer } from '../src/core/process/normalize'
import { Store } from '../src/core/store'
import { makePaths } from '../src/core/paths'
import type { RawItem, Source } from '../src/shared/contract'

const type = 'content-retry-test'

registerNormalizer(type, (item, source) => ({
  id: `${source.id}-${item.externalId}`,
  externalId: item.externalId,
  title: String(item.raw.title ?? ''),
  body: '',
  publishedAt: 100,
  sourceUrl: String(item.raw.url ?? ''),
  source: { id: source.id, type: source.type, name: source.name },
  ext: {},
  createdAt: 100,
  updatedAt: 100
}))

test('已入库但正文失败的文章会在后续刷新重试并补齐原始排版', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'infohub-collector-content-'))
  const paths = makePaths(dir)
  const store = new Store(paths)
  let enrichmentCalls = 0
  const raw: RawItem = {
    sourceId: 'retry-source',
    sourceType: type,
    fetchedAt: 100,
    externalId: 'article-1',
    raw: { title: '待补正文', url: 'https://mp.weixin.qq.com/s/retry' }
  }
  const adapter: SourceAdapter = {
    type,
    contentParserVersion: 1,
    async fetch() {
      return { items: [raw], status: 'ok' }
    },
    async enrichContent() {
      enrichmentCalls++
      if (enrichmentCalls === 1) {
        return {
          body: '',
          pageHtml: '<html>临时提示页</html>',
          status: 'failed',
          parserVersion: 1,
          error: { code: 'content_missing', message: '暂未找到正文' }
        }
      }
      if (enrichmentCalls === 4) {
        return {
          body: '不完整的新正文',
          contentHtml: '<div id="js_content">不完整的新排版</div>',
          pageHtml: '<html>临时验证页 4</html>',
          status: 'partial',
          parserVersion: 2,
          error: { code: 'content_partial', message: '本次正文不完整' }
        }
      }
      if (enrichmentCalls === 5) {
        return {
          body: '',
          pageHtml: '<html>临时验证页 5</html>',
          status: 'failed',
          parserVersion: 2,
          error: { code: 'content_missing', message: '本次只返回验证页' }
        }
      }
      return {
        body: '补齐后的正文',
        contentHtml: '<div id="js_content"><p>补齐后的正文</p></div>',
        pageHtml: '<html><div id="js_content"><p>补齐后的正文</p></div></html>',
        status: 'complete',
        parserVersion: 1
      }
    }
  }
  const registry = new AdapterRegistry()
  registry.register(adapter)
  const source: Source = {
    id: 'retry-source',
    type,
    name: '正文重试测试',
    enabled: true,
    config: {}
  }
  const changed: string[] = []
  const collector = new Collector(registry, store, (_source, article) => changed.push(article.id))

  try {
    const first = await collector.collectSource(source)
    assert.equal(first.newArticles, 1)
    assert.equal(first.updatedArticles, 0)
    const failed = store.findArticleByExternalId(source.id, raw.externalId)
    assert.equal(failed?.content?.status, 'failed')
    assert.ok(failed?.content?.pageHtmlPath)
    assert.equal(failed?.content?.contentHtmlPath, undefined)

    const second = await collector.collectSource(source)
    assert.equal(second.newArticles, 0)
    assert.equal(second.updatedArticles, 1)
    assert.equal(enrichmentCalls, 2)
    const completed = store.getArticleDetail(failed!.id)
    assert.equal(completed?.content?.status, 'complete')
    assert.equal(completed?.body, '补齐后的正文')
    assert.match(completed?.contentHtml ?? '', /补齐后的正文/)
    assert.equal(changed.length, 2)

    rmSync(join(paths.articles, completed!.content!.contentHtmlPath!), { force: true })
    const repaired = await collector.collectSource(source)
    assert.equal(repaired.updatedArticles, 1)
    assert.equal(enrichmentCalls, 3)
    assert.match(store.getArticleDetail(failed!.id)?.contentHtml ?? '', /补齐后的正文/)
    assert.equal(changed.length, 3)

    const completePagePath = join(paths.raw, completed!.content!.pageHtmlPath!)
    const completePage = readFileSync(completePagePath, 'utf8')
    adapter.contentParserVersion = 2
    const failedAgain = await collector.collectSource(source)
    assert.equal(failedAgain.updatedArticles, 0)
    assert.equal(enrichmentCalls, 4)
    assert.equal(store.getArticle(failed!.id)?.content?.status, 'complete')
    assert.equal(store.getArticle(failed!.id)?.body, '补齐后的正文')
    assert.match(store.getArticleDetail(failed!.id)?.contentHtml ?? '', /补齐后的正文/)
    assert.doesNotMatch(store.getArticleDetail(failed!.id)?.contentHtml ?? '', /不完整/)
    assert.equal(readFileSync(completePagePath, 'utf8'), completePage)
    assert.doesNotMatch(readFileSync(completePagePath, 'utf8'), /临时验证页/)
    assert.equal(changed.length, 3)

    // 已有完整正文但本机 page sidecar 丢失时，失败响应仍应留档供诊断；
    // 不能因为要保护正文 HTML 而把唯一可用的 HTTP 页面也丢掉。
    rmSync(completePagePath, { force: true })
    const pageRepair = await collector.collectSource(source)
    assert.equal(pageRepair.updatedArticles, 0)
    assert.equal(enrichmentCalls, 5)
    assert.equal(store.getArticle(failed!.id)?.content?.status, 'complete')
    assert.match(readFileSync(completePagePath, 'utf8'), /临时验证页 5/)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
