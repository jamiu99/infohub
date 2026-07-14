// 存储层往返测试：文件为源落地 + SQLite 索引 + 去重 + 重建索引。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  readdirSync,
  writeFileSync
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { Store } from '../src/core/store/index'
import { makePaths } from '../src/core/paths'
import { normalizeWechat } from '../src/core/process/wechat'
import { toRawItem } from '../src/core/ingest/wechat'
import type { Article, RawItem, Source } from '../src/shared/contract'

const source: Source = {
  id: 'wx-abc',
  type: 'wechat',
  name: '特工宇宙',
  enabled: true,
  config: { fakeid: 'Mzk0NTYzNDQ5NQ==' }
}

const rawItem = {
  aid: '2247511129_1',
  appmsgid: 2247511129,
  title: '测试文章标题',
  digest: '摘要',
  link: 'http://mp.weixin.qq.com/s?__biz=abc&mid=2247511129',
  cover: 'https://x/cover.jpg',
  author_name: '特工少女',
  create_time: 1750925178
}

function freshStore(): { store: Store; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), 'infohub-test-'))
  return { store: new Store(makePaths(dir)), dir }
}

function maintenanceArticle(
  id: string,
  sourceId: string,
  type: string,
  options: { archived?: boolean; contributedByMe?: boolean; publishedAt?: number } = {}
): Article {
  const now = options.publishedAt ?? Date.now()
  return {
    id,
    externalId: `${type}-${sourceId}-${id}`,
    title: `维护文章 ${id}`,
    body: `正文 ${id}`,
    publishedAt: now,
    sourceUrl: `https://example.com/${id}`,
    source: { id: sourceId, type, name: sourceId },
    ext: {},
    team:
      options.contributedByMe === false
        ? { remoteId: `remote-${id}`, contributedByMe: false }
        : undefined,
    read: false,
    archived: options.archived ?? false,
    createdAt: now,
    updatedAt: now
  }
}

test('normalize + save：文件落地 + 索引可查 + 时间转 UTC ms', () => {
  const { store, dir } = freshStore()
  try {
    const raw = toRawItem(source.id, rawItem)
    const article = normalizeWechat(raw, source)
    assert.equal(article.publishedAt, 1750925178 * 1000) // 秒 → 毫秒
    assert.equal(article.externalId, raw.externalId)
    assert.equal(article.sourceUrl, rawItem.link)
    assert.equal(article.ext.author_name, '特工少女')

    const saved = store.saveArticle(article)
    assert.ok(saved.filePath)
    const articleFile = join(dir, 'articles', saved.filePath!)
    assert.ok(existsSync(articleFile))
    assert.doesNotMatch(readFileSync(articleFile, 'utf8'), /^(summary|score|tags|staleness|provenance):/m)

    const list = store.listArticles()
    assert.equal(list.length, 1)
    assert.equal(list[0].title, '测试文章标题')
    // 从文件读回正文/元数据一致
    const got = store.getArticle(saved.id)
    assert.equal(got?.ext.author_name, '特工少女')
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('去重：saveArticle 自动登记，重建后 seen_items 仍可恢复', () => {
  const { store, dir } = freshStore()
  try {
    const raw = toRawItem(source.id, rawItem)
    assert.equal(store.isSeen(source.id, raw.externalId), false)
    store.saveArticle(normalizeWechat(raw, source))
    assert.equal(store.isSeen(source.id, raw.externalId), true)
    store.rebuildIndex()
    assert.equal(store.isSeen(source.id, raw.externalId), true)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('raw 快照按 externalId 与内容寻址：同内容复用、不同内容和长 ID 均不覆盖', () => {
  const { store, dir } = freshStore()
  try {
    const base: RawItem = {
      sourceId: source.id,
      sourceType: source.type,
      fetchedAt: 100,
      externalId: `${'https://example.com/'.padEnd(240, 'x')}first`,
      raw: { title: '第一版', nested: { value: 1 } }
    }
    const firstPath = store.saveRaw(base)
    const duplicatePath = store.saveRaw(base)
    const observedAgainPath = store.saveRaw({ ...base, fetchedAt: 200 })
    const revisedPath = store.saveRaw({ ...base, raw: { ...base.raw, title: '第二版' } })
    const samePrefixPath = store.saveRaw({
      ...base,
      externalId: `${'https://example.com/'.padEnd(240, 'x')}second`
    })

    assert.equal(duplicatePath, firstPath)
    assert.equal(observedAgainPath, firstPath)
    assert.notEqual(revisedPath, firstPath)
    assert.notEqual(samePrefixPath, firstPath)
    const firstSnapshot = JSON.parse(readFileSync(join(dir, 'raw', firstPath), 'utf8')) as {
      fetchedAt?: number
      raw: { title: string }
    }
    assert.equal(firstSnapshot.raw.title, '第一版')
    assert.equal(Object.hasOwn(firstSnapshot, 'fetchedAt'), false)
    assert.equal(JSON.parse(readFileSync(join(dir, 'raw', revisedPath), 'utf8')).raw.title, '第二版')
    assert.equal(readdirSync(dirname(join(dir, 'raw', firstPath))).length, 2)
    assert.ok(existsSync(join(dir, 'raw', samePrefixPath)))
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('阅读/归档状态同时写入文件与索引，重建后保持', () => {
  const { store, dir } = freshStore()
  try {
    const a = store.saveArticle(normalizeWechat(toRawItem(source.id, rawItem), source))
    const contentUpdatedAt = a.updatedAt
    assert.equal(store.unreadCounts()[source.id], 1)
    store.setRead(a.id, true)
    assert.equal(store.unreadCounts()[source.id] ?? 0, 0)
    assert.equal(store.getArticle(a.id)?.read, true)
    assert.equal(store.getArticle(a.id)?.updatedAt, contentUpdatedAt)
    store.setArchived(a.id, true)
    assert.equal(store.getArticle(a.id)?.archived, true)
    assert.equal(store.getArticle(a.id)?.updatedAt, contentUpdatedAt)
    assert.equal(store.listArticles({ filter: 'archived' })[0]?.id, a.id)

    store.rebuildIndex()
    assert.equal(store.unreadCounts()[source.id] ?? 0, 0)
    assert.equal(store.listArticles({ filter: 'archived' })[0]?.archived, true)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('重建索引：删库后从 md 文件重灌', () => {
  const { store, dir } = freshStore()
  try {
    store.saveArticle(normalizeWechat(toRawItem(source.id, rawItem), source))
    const n = store.rebuildIndex()
    assert.equal(n, 1)
    assert.equal(store.listArticles().length, 1)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('外部工具修改 Markdown 后可同步回 SQLite', () => {
  const { store, dir } = freshStore()
  try {
    const a = store.saveArticle(normalizeWechat(toRawItem(source.id, rawItem), source))
    const full = join(dir, 'articles', a.filePath!)
    const edited = readFileSync(full, 'utf8')
      .replace('source: ', 'summary: "外部标注"\nsource: ')
      .replace('read: false', 'read: true')
    writeFileSync(full, edited)

    assert.equal(store.syncIndexFromFiles(true), 1)
    assert.equal(store.getArticle(a.id)?.summary, '外部标注')
    assert.equal(store.unreadCounts()[source.id] ?? 0, 0)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('v0.1.0 迁移：保留 SQLite 阅读状态并补 externalId', () => {
  const { store, dir } = freshStore()
  const raw = toRawItem(source.id, rawItem)
  const a = store.saveArticle(normalizeWechat(raw, source))
  const full = join(dir, 'articles', a.filePath!)
  store.close()

  // 模拟旧文件（无 externalId，状态仍为 false）和旧 SQLite（状态只存在索引）。
  writeFileSync(full, readFileSync(full, 'utf8').replace(/^externalId:.*\n/m, ''))
  const db = new DatabaseSync(join(dir, 'index.sqlite'))
  db.prepare("DELETE FROM store_meta WHERE key = 'schema_version'").run()
  db.prepare('UPDATE articles SET read = 1, archived = 1 WHERE id = ?').run(a.id)
  db.close()

  const migrated = new Store(makePaths(dir))
  try {
    const got = migrated.getArticle(a.id)
    // v0.1 文件没有 canonical externalId，只能从 sourceUrl 恢复旧去重键。
    const legacyExternalId = rawItem.link
    assert.equal(got?.read, true)
    assert.equal(got?.archived, true)
    assert.equal(got?.externalId, legacyExternalId)
    assert.equal(migrated.isSeen(source.id, legacyExternalId), true)
    assert.match(readFileSync(full, 'utf8'), /^externalId: /m)
  } finally {
    migrated.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('文章文件路径不能逃出 data/articles', () => {
  const { store, dir } = freshStore()
  try {
    const article = normalizeWechat(toRawItem(source.id, rawItem), source)
    assert.throws(() => store.saveArticle({ ...article, filePath: '../../escape.md' }), /非法数据路径/)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('微信正文产物分别落到 Markdown、正文 HTML sidecar 与原始页面，并可重启恢复', () => {
  const dir = mkdtempSync(join(tmpdir(), 'infohub-content-test-'))
  const paths = makePaths(dir)
  let store: Store | null = new Store(paths)
  try {
    const article = normalizeWechat(toRawItem(source.id, rawItem), source)
    const saved = store.saveArticle(
      {
        ...article,
        body: '完整正文',
        content: {
          status: 'complete',
          parserVersion: 1,
          lastAttemptAt: 100,
          lastSuccessAt: 100
        }
      },
      {
        contentHtml: '<div id="js_content"><p>完整正文</p></div>',
        pageHtml: '<!doctype html><html><body>原始微信页面</body></html>'
      }
    )

    assert.ok(saved.content?.contentHtmlPath)
    assert.ok(saved.content?.pageHtmlPath)
    const markdownPath = join(paths.articles, saved.filePath!)
    const contentPath = join(paths.articles, saved.content!.contentHtmlPath!)
    const pagePath = join(paths.raw, saved.content!.pageHtmlPath!)
    assert.ok(existsSync(markdownPath))
    assert.equal(readFileSync(contentPath, 'utf8'), '<div id="js_content"><p>完整正文</p></div>')
    assert.equal(
      readFileSync(pagePath, 'utf8'),
      '<!doctype html><html><body>原始微信页面</body></html>'
    )
    assert.match(readFileSync(markdownPath, 'utf8'), /^content: /m)

    const listed = store.listArticles()[0]
    assert.equal('contentHtml' in listed, false)
    assert.equal(store.getArticleDetail(saved.id)?.contentHtml, '<div id="js_content"><p>完整正文</p></div>')

    const firstContentPath = saved.content!.contentHtmlPath!
    assert.ok(
      firstContentPath.endsWith(
        `${createHash('sha256').update('<div id="js_content"><p>完整正文</p></div>').digest('hex')}.content.html`
      )
    )
    const revisedHtml = '<div id="js_content"><p>第二版正文</p></div>'
    const revised = store.saveArticle(
      {
        ...saved,
        body: '第二版正文',
        content: { ...saved.content!, lastAttemptAt: 200, lastSuccessAt: 200 }
      },
      { contentHtml: revisedHtml }
    )
    assert.notEqual(revised.content?.contentHtmlPath, firstContentPath)
    assert.equal(existsSync(join(paths.articles, firstContentPath)), false)
    assert.equal(store.getArticleDetail(saved.id)?.contentHtml, revisedHtml)

    store.close()
    store = new Store(paths)
    const restored = store.getArticleDetail(saved.id)
    assert.equal(restored?.content?.status, 'complete')
    assert.equal(restored?.contentHtml, revisedHtml)
    assert.equal(store.hasArticlePageHtml(restored!), true)
    rmSync(join(paths.raw, restored!.content!.pageHtmlPath!), { force: true })
    assert.equal(store.hasArticlePageHtml(restored!), false)
  } finally {
    store?.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('page HTML 快照按内容复用，失败响应只更新最近尝试且不替换成功引用', () => {
  const { store, dir } = freshStore()
  try {
    const article = normalizeWechat(toRawItem(source.id, rawItem), source)
    const successfulHtml = '<!doctype html><html><body>成功页面</body></html>'
    const failedHtml = '<!doctype html><html><body>访问验证失败页面</body></html>'
    const first = store.saveArticle(
      {
        ...article,
        content: {
          status: 'complete',
          parserVersion: 1,
          lastAttemptAt: 100,
          lastSuccessAt: 100
        }
      },
      { pageHtml: successfulHtml }
    )
    const firstPath = first.content!.pageHtmlPath!
    assert.ok(
      firstPath.endsWith(`${createHash('sha256').update(successfulHtml).digest('hex')}.page.html`)
    )
    const duplicate = store.saveArticle(first, { pageHtml: successfulHtml })
    assert.equal(duplicate.content?.pageHtmlPath, firstPath)

    const second = store.saveArticle(
      {
        ...duplicate,
        content: {
          ...duplicate.content!,
          status: 'failed',
          lastAttemptAt: 200,
          error: { code: 'VERIFY_REQUIRED', message: '需要访问验证' }
        }
      },
      { pageHtml: failedHtml }
    )
    const secondPath = second.content!.lastAttemptPageHtmlPath!

    assert.notEqual(secondPath, firstPath)
    assert.equal(second.content?.pageHtmlPath, firstPath)
    assert.ok(
      secondPath.endsWith(`${createHash('sha256').update(failedHtml).digest('hex')}.page.html`)
    )
    assert.equal(readFileSync(join(dir, 'raw', firstPath), 'utf8'), successfulHtml)
    assert.equal(readFileSync(join(dir, 'raw', secondPath), 'utf8'), failedHtml)
    assert.equal(readdirSync(dirname(join(dir, 'raw', firstPath))).length, 2)
    assert.equal(store.getArticlePageHtml(second.id), successfulHtml)
    assert.equal(store.getArticlePageHtml('missing'), null)

    assert.deepEqual(store.getArticleReplayPage(second.id), {
      path: secondPath,
      pageHtml: failedHtml
    })
    rmSync(join(dir, 'raw', secondPath), { force: true })
    assert.deepEqual(store.getArticleReplayPage(second.id), {
      path: firstPath,
      pageHtml: successfulHtml
    })
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('维护枚举独立于看板限制，支持 sourceId/type/mineOnly 并包含归档文章', () => {
  const { store, dir } = freshStore()
  try {
    const fixtures = [
      maintenanceArticle('wx-local', 'wx-a', 'wechat', { publishedAt: 500 }),
      maintenanceArticle('wx-archived', 'wx-a', 'wechat', {
        archived: true,
        publishedAt: 400
      }),
      maintenanceArticle('wx-team', 'wx-a', 'wechat', {
        contributedByMe: false,
        publishedAt: 300
      }),
      maintenanceArticle('rss-local', 'rss-a', 'rss', { publishedAt: 200 }),
      maintenanceArticle('wx-other', 'wx-b', 'wechat', { publishedAt: 100 })
    ]
    fixtures.forEach((article) => store.saveArticle(article))

    assert.deepEqual(
      store.listArticlesForMaintenance().map((article) => article.id),
      ['wx-local', 'wx-archived', 'wx-team', 'rss-local', 'wx-other']
    )
    assert.deepEqual(
      store.listArticlesForMaintenance({ sourceId: 'wx-a' }).map((article) => article.id),
      ['wx-local', 'wx-archived', 'wx-team']
    )
    assert.deepEqual(
      store.listArticlesForMaintenance({ type: 'rss' }).map((article) => article.id),
      ['rss-local']
    )
    assert.deepEqual(
      store
        .listArticlesForMaintenance({ sourceId: 'wx-a', type: 'wechat', mineOnly: true })
        .map((article) => article.id),
      ['wx-local', 'wx-archived']
    )
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('取消纯本地信源时删除文章与正文 sidecar，但保留 raw 原始页面用于溯源', () => {
  const { store, dir } = freshStore()
  try {
    const article = normalizeWechat(toRawItem(source.id, rawItem), source)
    const saved = store.saveArticle(
      {
        ...article,
        content: {
          status: 'complete',
          parserVersion: 1,
          lastAttemptAt: 100,
          lastSuccessAt: 100
        }
      },
      { contentHtml: '<div id="js_content">正文</div>', pageHtml: '<html>原页</html>' }
    )
    const markdownPath = join(dir, 'articles', saved.filePath!)
    const contentPath = join(dir, 'articles', saved.content!.contentHtmlPath!)
    const pagePath = join(dir, 'raw', saved.content!.pageHtmlPath!)

    store.purgeSource(source.id)

    assert.equal(existsSync(markdownPath), false)
    assert.equal(existsSync(contentPath), false)
    assert.equal(existsSync(pagePath), true)
  } finally {
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
