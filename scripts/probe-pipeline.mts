// 全链路验证：模拟 UI「加公众号」触发的完整流程。
// search → 建 Source → collectSource（含正文抓取）→ 存文件+索引 → 读回。
// 存到临时目录，不碰真实数据。极保守：单账号串行、单次 1 页。
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { makePaths } from '../src/core/paths'
import { Store } from '../src/core/store'
import { AccountPool } from '../src/core/collect/account-pool'
import { Collector } from '../src/core/collect/collector'
import type { WxAccount } from '../src/shared/wechat'
import type { Source } from '../src/shared/contract'

const query = process.argv[2] || '特工宇宙'
const poolPath = join(homedir(), '.config', 'infohub', 'data', 'secrets', 'wx-accounts.enc')
const accounts = JSON.parse(readFileSync(poolPath, 'utf8')) as WxAccount[]

const dir = mkdtempSync(join(tmpdir(), 'infohub-pipeline-'))
const store = new Store(makePaths(dir))
const pool = new AccountPool(accounts)
const collector = new Collector(pool, store)

console.log(`用账号：${accounts[0]?.nickname || accounts[0]?.id}`)
console.log(`临时数据目录：${dir}\n`)

// 1. search（UI: AddSourceDialog）
console.log(`[1] 搜索「${query}」…`)
const results = await collector.search(query)
if (!results.length) {
  console.log('搜索无结果，退出')
  process.exit(0)
}
const target = results[0]
console.log(`  选中：${target.nickname} (${target.fakeid})`)

// 2. 建 Source（UI: source:add handler）
const source: Source = {
  id: `wx-${target.fakeid}`,
  type: 'wechat',
  name: target.nickname,
  enabled: true,
  config: { fakeid: target.fakeid, alias: target.alias, signature: target.signature }
}
store.saveSources([source])

// 3. collectSource（含正文抓取）
console.log(`\n[2] 采集「${source.name}」第 1 页（含正文抓取）…`)
const r = await collector.collectSource(source, 1)
console.log(`  状态：${r.status}，新入库：${r.newArticles} 篇`)

// 4. 读回（UI: article:list）
console.log(`\n[3] 从库读回文章列表：`)
const list = store.listArticles()
for (const a of list.slice(0, 5)) {
  const bodyLen = a.body?.length ?? 0
  console.log(`  · ${a.title}`)
  console.log(`      来源=${a.source.name} 时间=${new Date(a.publishedAt).toLocaleDateString()} 正文=${bodyLen}字 url=${a.sourceUrl.slice(0, 50)}…`)
}

// 5. 未读计数（UI: 左栏徽标）
console.log(`\n[4] 未读计数：`, store.unreadCounts())

// 6. 验证文件真的落地（文件为源）
const first = list[0]
if (first?.filePath) {
  const full = join(dir, 'articles', first.filePath)
  const md = readFileSync(full, 'utf8')
  console.log(`\n[5] 文件为源验证：${first.filePath}`)
  console.log(`      文件大小 ${md.length} 字节，frontmatter 头：`)
  console.log('      ' + md.split('\n').slice(0, 3).join('\n      '))
}

rmSync(dir, { recursive: true, force: true })
console.log('\n✅ 全链路验证完成（search→add→collect→正文→存文件+索引→读回）')
