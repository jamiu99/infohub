// 存储层：文件为源 + SQLite 索引。见 docs/storage.md。
// SQLite 用 Node 内置 node:sqlite（禁止三方库）。
import { DatabaseSync } from 'node:sqlite'
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  readdirSync,
  renameSync,
  rmSync
} from 'node:fs'
import { dirname, join, resolve, sep } from 'node:path'
import type { Article, Source, RawItem } from '../../shared/contract'
import type { Paths } from '../paths'
import { articleToMarkdown, parseArticleMarkdown } from './markdown'

const STORE_SCHEMA_VERSION = 3
const FILE_SYNC_THROTTLE_MS = 500

/** 文件先写临时文件再 rename；失败时旧文件仍完整。 */
function writeFileAtomic(path: string, content: string): void {
  const tmp = `${path}.${process.pid}.tmp`
  try {
    writeFileSync(tmp, content)
    renameSync(tmp, path)
  } finally {
    if (existsSync(tmp)) rmSync(tmp, { force: true })
  }
}

/** 防止来自 frontmatter / adapter 的路径片段逃出 data 子目录。 */
function resolveInside(root: string, ...parts: string[]): string {
  const base = resolve(root)
  const target = resolve(base, ...parts)
  if (target !== base && !target.startsWith(base + sep)) {
    throw new Error(`非法数据路径: ${parts.join('/')}`)
  }
  return target
}

export class Store {
  private db: DatabaseSync
  private lastFileSyncAt = 0

  constructor(private paths: Paths) {
    mkdirSync(paths.articles, { recursive: true })
    mkdirSync(paths.raw, { recursive: true })
    mkdirSync(paths.secrets, { recursive: true })
    this.db = new DatabaseSync(paths.index)
    this.initSchema()
    this.migrateLegacyFiles()
    // 文件是内容源：每次启动从文件完整恢复文章索引与 seen_items。
    this.rebuildIndex()
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
        updated_at   INTEGER,
        contributed_by_me INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS idx_articles_published ON articles(published_at);
      CREATE INDEX IF NOT EXISTS idx_articles_source ON articles(source_id);
      CREATE TABLE IF NOT EXISTS seen_items (
        source_id   TEXT,
        external_id TEXT,
        article_id  TEXT,
        PRIMARY KEY (source_id, external_id)
      );
      CREATE TABLE IF NOT EXISTS store_meta (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `)
    const columns = this.db.prepare('PRAGMA table_info(articles)').all() as Array<{ name: string }>
    if (!columns.some((column) => column.name === 'contributed_by_me')) {
      this.db.exec('ALTER TABLE articles ADD COLUMN contributed_by_me INTEGER NOT NULL DEFAULT 1')
    }
  }

  /**
   * v0.1.0 的 read/archived 只写 SQLite。升级到 v2 时先把旧索引状态回填文件，
   * 再由文件重建索引，避免用户已有阅读状态丢失。迁移只执行一次。
   */
  private migrateLegacyFiles(): void {
    const row = this.db.prepare("SELECT value FROM store_meta WHERE key = 'schema_version'").get() as
      | { value: string }
      | undefined
    const version = Number(row?.value ?? 1)
    if (version >= STORE_SCHEMA_VERSION) return

    const rows = this.db
      .prepare('SELECT file_path, read, archived FROM articles WHERE file_path IS NOT NULL')
      .all() as Array<{ file_path: string; read: number; archived: number }>
    for (const current of rows) {
      let full: string
      try {
        full = resolveInside(this.paths.articles, current.file_path)
      } catch {
        continue
      }
      if (!existsSync(full)) continue
      const article = parseArticleMarkdown(readFileSync(full, 'utf8'), current.file_path)
      article.read = !!current.read
      article.archived = !!current.archived
      writeFileAtomic(full, articleToMarkdown(article))
    }

    this.db
      .prepare(
        `INSERT INTO store_meta (key, value) VALUES ('schema_version', ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`
      )
      .run(String(STORE_SCHEMA_VERSION))
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
    const dir = resolveInside(this.paths.raw, item.sourceType, item.sourceId)
    mkdirSync(dir, { recursive: true })
    const name = encodeURIComponent(item.externalId).slice(0, 180) + '.json'
    writeFileAtomic(join(dir, name), JSON.stringify(item, null, 2))
  }

  // —— 文章：文件为源 + 索引 ——
  saveArticle(article: Article): Article {
    const relPath = article.filePath ?? join(article.source.type, article.source.id, `${article.id}.md`)
    const filePath = resolveInside(this.paths.articles, relPath)
    const dir = dirname(filePath)
    mkdirSync(dir, { recursive: true })
    const withPath = { ...article, filePath: relPath }
    writeFileAtomic(filePath, articleToMarkdown(withPath))
    this.upsertIndex(withPath)
    if (withPath.externalId) this.markSeen(withPath.source.id, withPath.externalId, withPath.id)
    return withPath
  }

  private upsertIndex(a: Article): void {
    this.db
      .prepare(
        `INSERT INTO articles
          (id, title, published_at, source_id, source_type, source_url, summary, score,
          staleness, tags, read, archived, file_path, created_at, updated_at, contributed_by_me)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET
           title=excluded.title, published_at=excluded.published_at,
           source_id=excluded.source_id, source_type=excluded.source_type,
           source_url=excluded.source_url, summary=excluded.summary,
           score=excluded.score, staleness=excluded.staleness, tags=excluded.tags,
           read=excluded.read, archived=excluded.archived, file_path=excluded.file_path,
           created_at=excluded.created_at, updated_at=excluded.updated_at,
           contributed_by_me=excluded.contributed_by_me`
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
        a.updatedAt,
        a.team?.contributedByMe === false ? 0 : 1
      )
  }

  listArticles(opts?: {
    sourceId?: string
    filter?: 'unread' | 'all' | 'archived'
    scope?: 'mine' | 'team'
  }): Article[] {
    this.syncIndexFromFiles()
    const where: string[] = []
    const params: string[] = []
    const filter = opts?.filter ?? 'all'
    if ((opts?.scope ?? 'mine') === 'mine') where.push('contributed_by_me = 1')
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

  /** 首次加入团队时使用：枚举全部本机贡献（含已归档），不受看板 500 条上限影响。 */
  listContributedArticlesForSync(): Article[] {
    this.syncIndexFromFiles(true)
    const rows = this.db
      .prepare('SELECT id FROM articles WHERE contributed_by_me = 1 ORDER BY published_at ASC')
      .all() as Array<{ id: string }>
    return rows.map((row) => this.getArticle(row.id)).filter((article): article is Article => !!article)
  }

  getArticle(id: string): Article | null {
    const row = this.db.prepare('SELECT file_path FROM articles WHERE id = ?').get(id) as
      | { file_path: string }
      | undefined
    if (!row?.file_path) return null
    let full: string
    try {
      full = resolveInside(this.paths.articles, row.file_path)
    } catch {
      return null
    }
    if (!existsSync(full)) return null
    return parseArticleMarkdown(readFileSync(full, 'utf8'), row.file_path)
  }

  findArticleByExternalId(sourceId: string, externalId: string): Article | null {
    const row = this.db
      .prepare('SELECT article_id FROM seen_items WHERE source_id = ? AND external_id = ?')
      .get(sourceId, externalId) as { article_id: string } | undefined
    return row ? this.getArticle(row.article_id) : null
  }

  /**
   * 取消本地关注：纯本地文章删除；已有团队 remoteId 的副本继续保留在团队视图。
   * retained 文章的 seen 映射会重建为团队语义，后续 pull/重新订阅仍命中同一文件。
   */
  purgeSource(sourceId: string): void {
    const rows = this.db
      .prepare('SELECT id, file_path FROM articles WHERE source_id = ?')
      .all(sourceId) as Array<{ id: string; file_path: string | null }>
    const retained: Article[] = []
    for (const r of rows) {
      const article = this.getArticle(r.id)
      if (article?.team?.remoteId) {
        retained.push(this.saveArticle({
          ...article,
          team: {
            ...article.team,
            contributedByMe: false,
            detachedFromLocalSource: true
          }
        }))
        continue
      }
      if (r.file_path) {
        let full: string
        try {
          full = resolveInside(this.paths.articles, r.file_path)
        } catch {
          continue
        }
        if (existsSync(full)) rmSync(full, { force: true })
      }
      this.db.prepare('DELETE FROM articles WHERE id = ?').run(r.id)
    }
    // 清掉旧映射，再只为保留的团队副本登记映射；映射的 mine/team 语义来自 Article 文件。
    this.db.prepare('DELETE FROM seen_items WHERE source_id = ?').run(sourceId)
    for (const article of retained) {
      if (article.externalId) this.markSeen(sourceId, article.externalId, article.id)
    }
  }

  setRead(id: string, read: boolean): void {
    this.updateArticle(id, { read })
  }

  setArchived(id: string, archived: boolean): void {
    this.updateArticle(id, { archived })
  }

  private updateArticle(id: string, patch: Pick<Article, 'read'> | Pick<Article, 'archived'>): void {
    const article = this.getArticle(id)
    if (!article) return
    this.saveArticle({ ...article, ...patch, updatedAt: Date.now() })
  }

  unreadCounts(): Record<string, number> {
    this.syncIndexFromFiles()
    const rows = this.db
      .prepare(
        'SELECT source_id, COUNT(*) c FROM articles WHERE read = 0 AND archived = 0 AND contributed_by_me = 1 GROUP BY source_id'
      )
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
    writeFileAtomic(this.paths.sources, JSON.stringify(sources, null, 2))
  }

  /** 把外部文件修改回灌 articles/seen_items；频繁读取时做短暂节流。 */
  syncIndexFromFiles(force = false): number {
    const now = Date.now()
    if (!force && now - this.lastFileSyncAt < FILE_SYNC_THROTTLE_MS) return 0
    let n = 0
    const walk = (dir: string): void => {
      if (!existsSync(dir)) return
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, entry.name)
        if (entry.isDirectory()) walk(p)
        else if (entry.name.endsWith('.md')) {
          const rel = p.slice(this.paths.articles.length + 1)
          const a = parseArticleMarkdown(readFileSync(p, 'utf8'), rel)
          if (!a.id || !a.source.id) continue
          this.upsertIndex(a)
          if (a.externalId) this.markSeen(a.source.id, a.externalId, a.id)
          n++
        }
      }
    }
    walk(this.paths.articles)
    this.lastFileSyncAt = Date.now()
    return n
  }

  /** 从 data/articles/**.md 完整重建文章索引与去重表。 */
  rebuildIndex(): number {
    this.db.exec('BEGIN')
    try {
      this.db.exec('DELETE FROM articles; DELETE FROM seen_items;')
      const n = this.syncIndexFromFiles(true)
      this.db.exec('COMMIT')
      return n
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }

  close(): void {
    this.db.close()
  }
}
