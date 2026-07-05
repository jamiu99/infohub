// 存储层往返测试：文件为源落地 + SQLite 索引 + 去重 + 重建索引。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Store } from '../src/core/store/index'
import { makePaths } from '../src/core/paths'
import { normalizeWechat } from '../src/core/process/wechat'
import { toRawItem } from '../src/core/ingest/wechat'
import type { Source } from '../src/shared/contract'

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

test('normalize + save：文件落地 + 索引可查 + 时间转 UTC ms', () => {
  const { store, dir } = freshStore()
  try {
    const raw = toRawItem(source.id, rawItem)
    const article = normalizeWechat(raw, source)
    assert.equal(article.publishedAt, 1750925178 * 1000) // 秒 → 毫秒
    assert.equal(article.sourceUrl, rawItem.link)
    assert.equal(article.ext.author_name, '特工少女')

    const saved = store.saveArticle(article)
    assert.ok(saved.filePath)
    assert.ok(existsSync(join(dir, 'articles', saved.filePath!)))

    const list = store.listArticles()
    assert.equal(list.length, 1)
    assert.equal(list[0].title, '测试文章标题')
    // 从文件读回正文/元数据一致
    const got = store.getArticle(saved.id)
    assert.equal(got?.ext.author_name, '特工少女')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('去重：同 externalId 只入库一次', () => {
  const { store, dir } = freshStore()
  try {
    const raw = toRawItem(source.id, rawItem)
    assert.equal(store.isSeen(source.id, raw.externalId), false)
    const a = store.saveArticle(normalizeWechat(raw, source))
    store.markSeen(source.id, raw.externalId, a.id)
    assert.equal(store.isSeen(source.id, raw.externalId), true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('未读计数 + 标记已读', () => {
  const { store, dir } = freshStore()
  try {
    const a = store.saveArticle(normalizeWechat(toRawItem(source.id, rawItem), source))
    assert.equal(store.unreadCounts()[source.id], 1)
    store.setRead(a.id, true)
    assert.equal(store.unreadCounts()[source.id] ?? 0, 0)
  } finally {
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
    rmSync(dir, { recursive: true, force: true })
  }
})
