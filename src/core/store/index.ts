// 存储层：文件为源 + SQLite 索引。见 docs/storage.md。
// SQLite 用 Node 内置 node:sqlite（禁止三方库）。
import { DatabaseSync } from 'node:sqlite'
import { createHash } from 'node:crypto'
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
import type { Article, ArticleDetail, Source, RawItem } from '../../shared/contract'
import type { Paths } from '../paths'
import { articleToMarkdown, parseArticleMarkdown } from './markdown'

const STORE_SCHEMA_VERSION = 3
const FILE_SYNC_THROTTLE_MS = 500

export interface ArticleArtifacts {
  /** #js_content outerHTML，写入 articles/ 下与 Markdown 同名的 sidecar。 */
  contentHtml?: string
  /** 未改写的完整公开页面，使用 HTML 内容 SHA-256 命名并写入 raw/。 */
  pageHtml?: string
  /** 未指定时仅 complete 状态会提升为 pageHtmlPath；false 可显式只留诊断快照。 */
  promotePageHtml?: boolean
}

/** 后台维护/重放使用；与看板筛选和分页上限相互独立。 */
export interface MaintenanceArticleQuery {
  sourceId?: string
  type?: string
  mineOnly?: boolean
}

export interface ArticleReplayPage {
  /** 相对 raw/ 的不可变页面路径。 */
  path: string
  pageHtml: string
}

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

function sha256(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex')
}

/**
 * 内容寻址文件只允许首次创建。相同内容直接复用；即使发生理论上的哈希碰撞，
 * 也宁可报错而不覆盖已有快照。
 */
function writeImmutableContent(path: string, content: string): void {
  try {
    writeFileSync(path, content, { flag: 'wx' })
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
    if (readFileSync(path, 'utf8') !== content) {
      throw new Error(`内容寻址冲突，已保留原文件: ${path}`)
    }
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
  saveRaw(item: RawItem): string {
    // fetchedAt 是本次观察时间，不属于上游证据内容。把它放进内容哈希会让完全相同的
    // 列表响应在每轮自动采集时都生成新文件；Raw blob 只保存稳定、可重放的上游载荷。
    const evidence = {
      sourceId: item.sourceId,
      sourceType: item.sourceType,
      externalId: item.externalId,
      raw: item.raw
    }
    const content = JSON.stringify(evidence, null, 2)
    // externalId 使用完整摘要作为目录，避免 URL 编码截断造成不同条目共用文件名。
    const relPath = join(
      item.sourceType,
      item.sourceId,
      sha256(item.externalId),
      `${sha256(content)}.json`
    )
    const path = resolveInside(this.paths.raw, relPath)
    const dir = dirname(path)
    mkdirSync(dir, { recursive: true })
    writeImmutableContent(path, content)
    return relPath
  }

  private rawPageRelativePath(article: Article, pageHtml: string): string {
    // 页面快照按实际 HTML 字节寻址；同一页面复用，不同响应（含失败页）永久并存。
    return join(article.source.type, article.source.id, 'pages', `${sha256(pageHtml)}.page.html`)
  }

  private contentHtmlRelativePath(articleMarkdownPath: string, contentHtml: string): string {
    const base = articleMarkdownPath.endsWith('.md')
      ? articleMarkdownPath.slice(0, -3)
      : articleMarkdownPath
    // 正文投影也使用版本化 sidecar：先完整写入新版本，再让 Markdown 原子切换指针。
    // 即使切换失败，旧 Markdown 仍指向旧 sidecar，不会丢掉上一份成功正文。
    return `${base}.${sha256(contentHtml)}.content.html`
  }

  // —— 文章：文件为源 + 索引 ——
  saveArticle(article: Article, artifacts: ArticleArtifacts = {}): Article {
    const relPath = article.filePath ?? join(article.source.type, article.source.id, `${article.id}.md`)
    const filePath = resolveInside(this.paths.articles, relPath)
    const dir = dirname(filePath)
    mkdirSync(dir, { recursive: true })

    let content = article.content ? { ...article.content } : undefined
    const previousContentHtmlPath = content?.contentHtmlPath
    if (artifacts.pageHtml !== undefined) {
      if (!content) throw new Error('写入原始页面前必须提供 Article.content 状态')
      const pageRelPath = this.rawPageRelativePath(article, artifacts.pageHtml)
      const pagePath = resolveInside(this.paths.raw, pageRelPath)
      mkdirSync(dirname(pagePath), { recursive: true })
      writeImmutableContent(pagePath, artifacts.pageHtml)
      const promotePageHtml = artifacts.promotePageHtml ?? content.status === 'complete'
      content = {
        ...content,
        ...(promotePageHtml ? { pageHtmlPath: pageRelPath } : {}),
        lastAttemptPageHtmlPath: pageRelPath
      }
    }
    if (artifacts.contentHtml !== undefined && artifacts.contentHtml.length > 0) {
      if (!content) throw new Error('写入正文 HTML 前必须提供 Article.content 状态')
      const contentRelPath = this.contentHtmlRelativePath(relPath, artifacts.contentHtml)
      const contentPath = resolveInside(this.paths.articles, contentRelPath)
      mkdirSync(dirname(contentPath), { recursive: true })
      writeImmutableContent(contentPath, artifacts.contentHtml)
      content = { ...content, contentHtmlPath: contentRelPath }
    }

    const withPath = { ...article, ...(content ? { content } : {}), filePath: relPath }
    writeFileAtomic(filePath, articleToMarkdown(withPath))
    this.upsertIndex(withPath)
    if (withPath.externalId) this.markSeen(withPath.source.id, withPath.externalId, withPath.id)
    // Markdown 与索引都已成功指向新版本后，旧 projection 才可清理。崩溃发生在这里之前
    // 最多留下一个无引用旧文件，不会让当前文章失去可用正文。
    if (
      previousContentHtmlPath &&
      content?.contentHtmlPath &&
      previousContentHtmlPath !== content.contentHtmlPath
    ) {
      try {
        rmSync(resolveInside(this.paths.articles, previousContentHtmlPath), { force: true })
      } catch {
        // 旧版或损坏路径不影响已经提交的新投影。
      }
    }
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

  /**
   * 重新解析、重抓等后台维护任务使用：包含归档文章且不设看板的 500 条上限。
   * mineOnly=true 时排除仅来自团队的文章；false/未传时枚举本地索引全部文章。
   */
  listArticlesForMaintenance(opts: MaintenanceArticleQuery = {}): Article[] {
    this.syncIndexFromFiles(true)
    const where: string[] = []
    const params: string[] = []
    if (opts.sourceId) {
      where.push('source_id = ?')
      params.push(opts.sourceId)
    }
    if (opts.type) {
      where.push('source_type = ?')
      params.push(opts.type)
    }
    if (opts.mineOnly) where.push('contributed_by_me = 1')
    const sql =
      `SELECT id FROM articles ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ` +
      'ORDER BY published_at DESC'
    const rows = this.db.prepare(sql).all(...params) as Array<{ id: string }>
    return rows
      .map((row) => this.getArticle(row.id))
      .filter((article): article is Article => !!article)
  }

  /** 首次加入团队时使用：枚举全部本机贡献（含已归档），不受看板 500 条上限影响。 */
  listContributedArticlesForSync(): ArticleDetail[] {
    this.syncIndexFromFiles(true)
    const rows = this.db
      .prepare('SELECT id FROM articles WHERE contributed_by_me = 1 ORDER BY published_at ASC')
      .all() as Array<{ id: string }>
    return rows
      .map((row) => this.getArticleDetail(row.id))
      .filter((article): article is ArticleDetail => !!article)
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

  /** 详情 IPC 才读取正文 HTML，文章列表不会携带大体积 sidecar。 */
  getArticleDetail(id: string): ArticleDetail | null {
    const article = this.getArticle(id)
    if (!article) return null
    const relPath = article.content?.contentHtmlPath
    if (!relPath) return article
    try {
      const full = resolveInside(this.paths.articles, relPath)
      if (!existsSync(full)) return article
      return { ...article, contentHtml: readFileSync(full, 'utf8') }
    } catch {
      return article
    }
  }

  /** Collector 用于判断 frontmatter 指向的本机完整页面是否仍实际存在。 */
  hasArticlePageHtml(article: Article): boolean {
    const relPath = article.content?.pageHtmlPath
    if (!relPath) return false
    try {
      return existsSync(resolveInside(this.paths.raw, relPath))
    } catch {
      return false
    }
  }

  /** 读取文章当前 frontmatter 指向的最新完整页面；非法/缺失路径安全返回 null。 */
  getArticlePageHtml(id: string): string | null {
    const article = this.getArticle(id)
    const relPath = article?.content?.pageHtmlPath
    if (!relPath) return null
    try {
      const full = resolveInside(this.paths.raw, relPath)
      if (!existsSync(full)) return null
      return readFileSync(full, 'utf8')
    } catch {
      return null
    }
  }

  /**
   * 离线重放优先读取与当前正文对应的成功页面；正文尚未成功时读取最近尝试快照。
   * 这里只读取不可变 raw 文件，不会修改或提升任何快照引用。
   */
  getArticleReplayPage(id: string): ArticleReplayPage | null {
    const article = this.getArticle(id)
    if (!article?.content) return null
    const candidates = article.content.status === 'complete'
      ? [article.content.pageHtmlPath, article.content.lastAttemptPageHtmlPath]
      : [article.content.lastAttemptPageHtmlPath, article.content.pageHtmlPath]
    const visited = new Set<string>()
    for (const relPath of candidates) {
      if (!relPath || visited.has(relPath)) continue
      visited.add(relPath)
      try {
        const full = resolveInside(this.paths.raw, relPath)
        if (existsSync(full)) return { path: relPath, pageHtml: readFileSync(full, 'utf8') }
      } catch {
        // 路径损坏时继续尝试另一个合法候选。
      }
    }
    return null
  }

  getArticleReplayPageHtml(id: string): string | null {
    return this.getArticleReplayPage(id)?.pageHtml ?? null
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
        const contentRelPath = article?.content?.contentHtmlPath
        if (contentRelPath) {
          try {
            rmSync(resolveInside(this.paths.articles, contentRelPath), { force: true })
          } catch {
            // 损坏的旧路径不应阻止取消本地关注。
          }
        }
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

  markAllRead(opts: { sourceId?: string; scope?: 'mine' | 'team' } = {}): number {
    this.syncIndexFromFiles(true)
    const where = ['read = 0', 'archived = 0']
    const params: string[] = []
    if ((opts.scope ?? 'mine') === 'mine') where.push('contributed_by_me = 1')
    if (opts.sourceId) {
      where.push('source_id = ?')
      params.push(opts.sourceId)
    }
    const rows = this.db
      .prepare(`SELECT id FROM articles WHERE ${where.join(' AND ')} ORDER BY published_at DESC`)
      .all(...params) as Array<{ id: string }>
    for (const row of rows) this.setRead(row.id, true)
    return rows.length
  }

  setArchived(id: string, archived: boolean): void {
    this.updateArticle(id, { archived })
  }

  private updateArticle(id: string, patch: Pick<Article, 'read'> | Pick<Article, 'archived'>): void {
    const article = this.getArticle(id)
    if (!article) return
    // read / archived 是纯本机阅读状态，不是团队正文版本；不能推进内容 updatedAt。
    this.saveArticle({ ...article, ...patch })
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
