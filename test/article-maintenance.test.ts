import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Collector } from '../src/core/collect/collector'
import { AdapterRegistry, type SourceAdapter } from '../src/core/ingest/adapter'
import { Store } from '../src/core/store'
import { makePaths } from '../src/core/paths'
import type { Article, Source } from '../src/shared/contract'

function files(root: string): string[] {
  const output: string[] = []
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) walk(path)
      else output.push(path)
    }
  }
  walk(root)
  return output.sort()
}

test('离线重解析只重建派生正文，联网失败追加快照且不覆盖完整正文', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'infohub-maintenance-'))
  const paths = makePaths(dir)
  const store = new Store(paths)
  const source: Source = {
    id: 'wx-maintenance',
    type: 'maintenance-test',
    name: '维护测试',
    enabled: true,
    config: {}
  }
  const originalPage = '<html><div id="body">新版正文</div></html>'
  const article: Article = {
    id: 'maintenance-article',
    externalId: 'external-1',
    title: '旧文章',
    body: '',
    publishedAt: 1,
    sourceUrl: 'https://example.test/article',
    source: { id: source.id, type: source.type, name: source.name },
    content: {
      status: 'failed',
      parserVersion: 1,
      lastAttemptAt: 1,
      error: { code: 'old_parser', message: '旧解析器未识别' }
    },
    ext: {},
    createdAt: 1,
    updatedAt: 1
  }
  const saved = store.saveArticle(article, { pageHtml: originalPage })
  store.saveSources([source])

  let networkCalls = 0
  const adapter: SourceAdapter = {
    type: source.type,
    contentParserVersion: 2,
    async fetch() {
      return { items: [], status: 'ok' }
    },
    parseContentPage(pageHtml) {
      assert.equal(pageHtml, originalPage)
      return {
        body: '新版正文',
        contentHtml: '<div id="body">新版正文</div>',
        pageHtml,
        status: 'complete',
        parserVersion: 2
      }
    },
    async enrichContent() {
      networkCalls++
      return {
        body: '',
        pageHtml: '<html>临时验证失败页</html>',
        status: 'failed',
        parserVersion: 2,
        error: { code: 'verification', message: '原文暂时要求验证' }
      }
    }
  }
  const registry = new AdapterRegistry()
  registry.register(adapter)
  const notified: string[] = []
  const collector = new Collector(registry, store, (_source, current) => notified.push(current.id))

  try {
    const beforeRaw = files(paths.raw)
    const failedSnapshotPath = saved.content?.lastAttemptPageHtmlPath
    assert.ok(failedSnapshotPath)
    assert.equal(saved.content?.pageHtmlPath, undefined)
    const offline = await collector.reprocessArticle(saved, 'offline')
    assert.equal(offline.status, 'updated')
    assert.equal(networkCalls, 0)
    assert.deepEqual(files(paths.raw), beforeRaw)
    const completed = store.getArticleDetail(saved.id)!
    assert.equal(completed.body, '新版正文')
    assert.equal(completed.content?.status, 'complete')
    assert.equal(completed.content?.parserVersion, 2)
    assert.equal(completed.content?.pageHtmlPath, failedSnapshotPath)
    assert.equal(completed.content?.lastAttemptAt, 1)
    assert.match(completed.contentHtml ?? '', /新版正文/)
    assert.deepEqual(notified, [saved.id])

    const successfulPagePath = completed.content?.pageHtmlPath
    const network = await collector.reprocessArticle(completed, 'network')
    assert.equal(network.status, 'failed')
    assert.equal(networkCalls, 1)
    const preserved = store.getArticleDetail(saved.id)!
    assert.equal(preserved.body, '新版正文')
    assert.equal(preserved.content?.status, 'complete')
    assert.equal(preserved.content?.pageHtmlPath, successfulPagePath)
    assert.notEqual(preserved.content?.lastAttemptPageHtmlPath, successfulPagePath)
    assert.match(
      readFileSync(join(paths.raw, preserved.content!.lastAttemptPageHtmlPath!), 'utf8'),
      /临时验证失败页/
    )
    const failedAttemptAt = preserved.content?.lastAttemptAt
    const failedAttemptPagePath = preserved.content?.lastAttemptPageHtmlPath

    const replayed = await collector.reprocessArticle(preserved, 'offline')
    assert.equal(replayed.status, 'unchanged')
    const afterReplay = store.getArticleDetail(saved.id)!
    assert.equal(afterReplay.content?.lastAttemptAt, failedAttemptAt)
    assert.equal(afterReplay.content?.lastAttemptPageHtmlPath, failedAttemptPagePath)
    assert.equal(afterReplay.content?.pageHtmlPath, successfulPagePath)
    assert.equal(afterReplay.content?.error?.code, 'verification')
    assert.equal(afterReplay.body, '新版正文')
    assert.deepEqual(notified, [saved.id])
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('联网重抓返回期间重读文章，只合并正文并保留用户与团队的并发修改', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'infohub-maintenance-stale-'))
  const paths = makePaths(dir)
  const store = new Store(paths)
  const source: Source = {
    id: 'wx-stale',
    type: 'maintenance-stale-test',
    name: '并发状态测试',
    enabled: true,
    config: {}
  }
  const saved = store.saveArticle(
    {
      id: 'stale-article',
      externalId: 'stale-external',
      title: '原始标题',
      body: '旧正文',
      publishedAt: 1,
      sourceUrl: 'https://example.test/stale',
      source: { id: source.id, type: source.type, name: source.name },
      content: {
        status: 'complete',
        parserVersion: 1,
        lastAttemptAt: 1,
        lastSuccessAt: 1
      },
      ext: {},
      read: false,
      archived: false,
      createdAt: 1,
      updatedAt: 1
    },
    {
      contentHtml: '<div id="body">旧正文</div>',
      pageHtml: '<html><div id="body">旧正文</div></html>'
    }
  )
  store.saveSources([source])

  let releaseNetwork!: () => void
  let markStarted!: () => void
  const started = new Promise<void>((resolve) => {
    markStarted = resolve
  })
  const release = new Promise<void>((resolve) => {
    releaseNetwork = resolve
  })
  const registry = new AdapterRegistry()
  registry.register({
    type: source.type,
    contentParserVersion: 2,
    async fetch() {
      return { items: [], status: 'ok' }
    },
    async enrichContent() {
      markStarted()
      await release
      return {
        body: '新正文',
        contentHtml: '<div id="body">新正文</div>',
        pageHtml: '<html><div id="body">新正文</div></html>',
        status: 'complete',
        parserVersion: 2
      }
    }
  })
  const collector = new Collector(registry, store)

  try {
    const pending = collector.reprocessArticle(saved, 'network')
    await started
    store.setRead(saved.id, true)
    store.setArchived(saved.id, true)
    const current = store.getArticle(saved.id)!
    store.saveArticle({
      ...current,
      title: '处理中修改的标题',
      tags: ['用户标签'],
      team: {
        remoteId: 'remote-stale',
        contributedByMe: true,
        contributors: [
          { deviceId: 'peer', memberName: '伙伴', deviceName: '同事电脑', collectedAt: 2 }
        ]
      }
    })
    releaseNetwork()

    assert.equal((await pending).status, 'updated')
    const final = store.getArticleDetail(saved.id)!
    assert.equal(final.body, '新正文')
    assert.equal(final.contentHtml, '<div id="body">新正文</div>')
    assert.equal(final.content?.parserVersion, 2)
    assert.equal(final.read, true)
    assert.equal(final.archived, true)
    assert.equal(final.title, '处理中修改的标题')
    assert.deepEqual(final.tags, ['用户标签'])
    assert.equal(final.team?.remoteId, 'remote-stale')
    assert.equal(final.team?.contributors?.[0]?.deviceId, 'peer')
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
