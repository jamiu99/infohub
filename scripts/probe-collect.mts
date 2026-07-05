// 一次性采集验证脚本（极保守：最多 2 次接口调用，全程串行）。
// 读已存账号池 → searchbiz 搜一个号 → appmsg 拉 1 页 → 打印。不写库，只读验证。
// 用法：node --import tsx scripts/probe-collect.mts "公众号名"
//
// 注意：需要 Electron 的 safeStorage 解密账号池，故用 electron 跑而非纯 node。
// 但为简单起见，这里直接用 node 读明文兜底（safeStorage 不可用时账号池是明文 JSON）。
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { searchBiz, listArticlesPage } from '../src/core/ingest/wechat'
import type { WxAccount } from '../src/shared/wechat'

const query = process.argv[2] || '特工宇宙'
const poolPath = join(homedir(), '.config', 'infohub', 'data', 'secrets', 'wx-accounts.enc')

if (!existsSync(poolPath)) {
  console.log('账号池不存在，请先在 App 里扫码登录')
  process.exit(1)
}

// 账号池可能被 safeStorage 加密。这个脚本读不了加密的——若解析失败给出提示。
let accounts: WxAccount[]
try {
  accounts = JSON.parse(readFileSync(poolPath, 'utf8')) as WxAccount[]
} catch {
  console.log('账号池是加密的（safeStorage），本脚本读不了。改用 electron 运行的探测。')
  process.exit(2)
}

const acc = accounts.find((a) => a.status === 'active')
if (!acc) {
  console.log('无可用账号')
  process.exit(1)
}
console.log(`用账号：${acc.nickname || acc.id}（token 尾 ...${acc.token.slice(-6)}）`)

console.log(`\n[1/2] searchbiz 搜索「${query}」…`)
const s = await searchBiz(acc, query)
if (!s.ok) {
  console.log('搜索失败：', s.reason, s.message)
  process.exit(0)
}
console.log(`搜到 ${s.data.length} 个：`)
for (const r of s.data) console.log(`  - ${r.nickname} (fakeid=${r.fakeid})`)

if (!s.data.length) process.exit(0)

const target = s.data[0]
console.log(`\n[2/2] appmsg 拉「${target.nickname}」第 1 页（10 条）…`)
const a = await listArticlesPage(acc, target.fakeid, 0, 10)
if (!a.ok) {
  console.log('拉取失败：', a.reason, a.message)
  process.exit(0)
}
console.log(`共 ${a.data.total} 篇，本页 ${a.data.items.length} 条：`)
for (const item of a.data.items.slice(0, 5)) {
  console.log(`  · ${(item as { title?: string }).title}`)
}
console.log('\n✅ 采集链路验证完成')
