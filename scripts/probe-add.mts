// 复刻 source:add 处理器的真实逻辑，计时找卡点。
// ⚠️ 只读真实账号池，写入【临时目录】，绝不污染真实数据（articles/sources）。
import { readFileSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { makePaths } from '../src/core/paths'
import { Store } from '../src/core/store'
import { AccountPool } from '../src/core/collect/account-pool'
import { Collector } from '../src/core/collect/collector'
import type { WxAccount } from '../src/shared/wechat'
import type { Source } from '../src/shared/contract'

// 账号池：从真实目录只读
const realPool = join(homedir(), '.config', 'infohub', 'data', 'secrets', 'wx-accounts.enc')
const accounts = JSON.parse(readFileSync(realPool, 'utf8')) as WxAccount[]
console.log('账号池（只读）：', accounts.map((a) => a.nickname || a.id).join(', ') || '(空)')

// 数据：写临时目录，跑完删掉
const dir = mkdtempSync(join(tmpdir(), 'infohub-probe-add-'))
const store = new Store(makePaths(dir))
const pool = new AccountPool(accounts)
const collector = new Collector(pool, store)

const t0 = Date.now()
console.log('\n[search] 搜索 "特工宇宙"…')
const results = await collector.search('特工宇宙')
console.log(`  用时 ${Date.now() - t0}ms，结果 ${results.length} 个`)
if (results.length) {
  const target = results[0]
  const source: Source = {
    id: `wx-${target.fakeid}`,
    type: 'wechat',
    name: target.nickname,
    enabled: true,
    config: { fakeid: target.fakeid }
  }
  console.log(`\n[add→collect] 模拟点「关注」（含正文抓取，UI 会卡在"添加中…"）…`)
  const t1 = Date.now()
  const r = await collector.collectSource(source, 1)
  console.log(`  用时 ${Date.now() - t1}ms，状态 ${r.status}，入库 ${r.newArticles} 篇`)
  console.log(`\n结论：点「关注」到返回共约 ${Date.now() - t0}ms`)
}
rmSync(dir, { recursive: true, force: true })
console.log('（临时目录已清理，未碰真实数据）')
