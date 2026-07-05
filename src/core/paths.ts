// 数据目录布局。真相源在文件里，SQLite 只做索引。见 docs/storage.md。
import { join } from 'node:path'

export interface Paths {
  root: string // data/
  articles: string // data/articles/
  raw: string // data/raw/
  index: string // data/index.sqlite
  sources: string // data/sources.json
  secrets: string // data/secrets/
  wxAccounts: string // data/secrets/wx-accounts.enc
}

export function makePaths(dataRoot: string): Paths {
  return {
    root: dataRoot,
    articles: join(dataRoot, 'articles'),
    raw: join(dataRoot, 'raw'),
    index: join(dataRoot, 'index.sqlite'),
    sources: join(dataRoot, 'sources.json'),
    secrets: join(dataRoot, 'secrets'),
    wxAccounts: join(dataRoot, 'secrets', 'wx-accounts.enc')
  }
}
