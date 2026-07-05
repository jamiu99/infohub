// 存储层：文件为源 + SQLite 索引。见 docs/storage.md。
// SQLite 用 Node 内置 node:sqlite（禁止三方库）。
import { DatabaseSync } from 'node:sqlite'
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import type { Article, Source, RawItem } from '../../shared/contract'
import type { Paths } from '../paths'
import { articleToMarkdown, parseArticleMarkdown } from './markdown'

export class Store {
  private db: DatabaseSync

  constructor(private paths: Paths) {
    mkdirSync(paths.articles, { recursive: true })
    mkdirSync(paths.raw, { recursive: true })
    mkdirSync(paths.secrets, { recursive: true })
    this.db = new DatabaseSync(paths.index)
    this.initSchema()
  }

  private initSchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS articles (
        id           TEXT PRIMARY KEY,
        title        TEXT NOT NULL,
        published_at INTEGER,
        source_id    TEXT,
        source_type  TEXT,
        source_url   TEXT,
        summary      TEXT,
        score        INTEGER,
        staleness    TEXT,
        tags         TEXT,
        read         INTEGER DEFAULT 0,
        archived     INTEGER DEFAULT 0,
        file_path    TEXT,
        created_at   INTEGER,
        updated_at   INTEGER
      );
      CREATE INDEX IF NOT EXISTS idx_articles_published ON articles(published_at);
      CREATE INDEX IF NOT EXISTS idx_articles_source ON articles(source_id);
      CREATE TABLE IF NOT EXISTS seen_items (
        source_id   TEXT,
        external_id TEXT,
        article_id  TEXT,
        PRIMARY KEY (source_id, external_id)
      );
    `)
  }

  // —— 去重 ——
  isSeen(sourceId: string, externalId: string): boolean {
    const row = this.db
      .prepare('SELECT 1 FROM seen_items WHERE source_id = ? AND external_id = ?')
      .get(sourceId, externalId)
    return !!row
  }

  markSeen(sourceId: string, externalId: string, articleId: string): void {
    this.db
      .prepare(
        'INSERT OR IGNORE INTO seen_items (source_id, external_id, article_id) VALUES (?, ?, ?)'
      )
      .run(sourceId, externalId, articleId)
  }

  // —— 原始载荷（溯源/重放）——
  saveRaw(item: RawItem): void {
    const dir = join(this.paths.raw, item.sourceType, item.sourceId)
    mkdirSync(dir, { recursive: true })
    const name = encodeURIComponent(item.externalId).slice(0, 180) + '.json'
    writeFileSync(join(dir, name), JSON.stringify(item, null, 2))
  }

  // —— 文章：文件为源 + 索引 ——
  saveArticle(article: Article): Article {
    const dir = join(this.paths.articles, article.source.type, article.source.id)
    mkdirSync(dir, { recursive: true })
    const relPath = join(article.source.type, article.source.id, `${article.id}.md`)
    const filePath = join(this.paths.articles, relPath)
    const withPath = { ...article, filePath: relPath }
    writeFileSync(filePath, articleToMarkdown(withPath))
    this.upsertIndex(withPath)
    return withPath
  }

  private upsertIndex(a: Article): void {
    this.db
      .prepare(
        `INSERT INTO articles
          (id, title, published_at, source_id, source_type, source_url, summary, score,
           staleness, tags, read, archived, file_path, created_at, updated_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           title=excluded.title, published_at=excluded.published_at, summary=excluded.summary,
           score=excluded.score, staleness=excluded.staleness, tags=excluded.tags,
           read=excluded.read, archived=excluded.archived, file_path=excluded.file_path,
           updated_at=excluded.updated_at`
      )
      .run(
        a.id,
        a.title,
        a.publishedAt,
        a.source.id,
        a.source.type,
        a.sourceUrl,
        a.summary ?? null,
        a.score ?? null,
        a.staleness ?? null,
        JSON.stringify(a.tags ?? []),
        a.read ? 1 : 0,
        a.archived ? 1 : 0,
        a.filePath ?? null,
        a.createdAt,
        a.updatedAt
      )
  }

  listArticles(opts?: { sourceId?: string; filter?: 'unread' | 'all' | 'archived' }): Article[] {
    const where: string[] = []
    const params: string[] = []
    const filter = opts?.filter ?? 'all'
    if (opts?.sourceId) {
      where.push('source_id = ?')
      params.push(opts.sourceId)
    }
    if (filter === 'unread') where.push('read = 0 AND archived = 0')
    else if (filter === 'archived') where.push('archived = 1')
    else where.push('archived = 0')
    const sql =
      `SELECT id FROM articles ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ` +
      'ORDER BY published_at DESC LIMIT 500'
    const rows = this.db.prepare(sql).all(...params) as Array<{ id: string }>
    return rows.map((r) => this.getArticle(r.id)).filter((a): a is Article => !!a)
  }

  getArticle(id: string): Article | null {
    const row = this.db.prepare('SELECT file_path FROM articles WHERE id = ?').get(id) as
      | { file_path: string }
      | undefined
    if (!row?.file_path) return null
    const full = join(this.paths.articles, row.file_path)
    if (!existsSync(full)) return null
    return parseArticleMarkdown(readFileSync(full, 'utf8'), row.file_path)
  }

  /** 删除某源的全部文章（文件 + 索引 + 已见记录）。取关时调用，避免孤儿数据。 */
  purgeSource(sourceId: string): void {
    const rows = this.db
      .prepare('SELECT file_path FROM articles WHERE source_id = ?')
      .all(sourceId) as Array<{ file_path: string | null }>
    for (const r of rows) {
      if (r.file_path) {
        const full = join(this.paths.articles, r.file_path)
        if (existsSync(full)) rmSync(full, { force: true })
      }
    }
    this.db.prepare('DELETE FROM articles WHERE source_id = ?').run(sourceId)
    this.db.prepare('DELETE FROM seen_items WHERE source_id = ?').run(sourceId)
  }

  setRead(id: string, read: boolean): void {
    this.db.prepare('UPDATE articles SET read = ?, updated_at = ? WHERE id = ?').run(read ? 1 : 0, Date.now(), id)
  }

  setArchived(id: string, archived: boolean): void {
    this.db
      .prepare('UPDATE articles SET archived = ?, updated_at = ? WHERE id = ?')
      .run(archived ? 1 : 0, Date.now(), id)
  }

  unreadCounts(): Record<string, number> {
    const rows = this.db
      .prepare('SELECT source_id, COUNT(*) c FROM articles WHERE read = 0 AND archived = 0 GROUP BY source_id')
      .all() as Array<{ source_id: string; c: number }>
    const out: Record<string, number> = {}
    for (const r of rows) out[r.source_id] = r.c
    return out
  }

  // —— 信源清单（sources.json）——
  listSources(): Source[] {
    if (!existsSync(this.paths.sources)) return []
    return JSON.parse(readFileSync(this.paths.sources, 'utf8')) as Source[]
  }

  saveSources(sources: Source[]): void {
    writeFileSync(this.paths.sources, JSON.stringify(sources, null, 2))
  }

  /** 从 data/articles/**.md 重建索引（文件为源的保证）。 */
  rebuildIndex(): number {
    this.db.exec('DELETE FROM articles; DELETE FROM seen_items;')
    let n = 0
    const walk = (dir: string): void => {
      if (!existsSync(dir)) return
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name)
        if (entry.isDirectory()) walk(p)
        else if (entry.name.endsWith('.md')) {
          const rel = p.slice(this.paths.articles.length + 1)
          const a = parseArticleMarkdown(readFileSync(p, 'utf8'), rel)
          this.upsertIndex(a)
          n++
        }
      }
    }
    walk(this.paths.articles)
    return n
  }
}
