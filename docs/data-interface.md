# 数据接口

> 上级：[overview.md](overview.md) · 存储实现：[storage.md](storage.md) · 字段契约：[contract.md](contract.md)

infohub 的产品边界是**采集、归一化、索引和快速浏览**。它不调用模型、不启动 AI CLI、不安装 Skill，也不管理任何 Agent 任务。AI、Agent、脚本或其他分析工具只是普通下游消费者：只读 infohub 管理的 Article 投影，把自己的结果写进隔离的输出目录。

## 运行时入口

默认资料库位于 Electron 的 `app.getPath('userData')/data`，用户可以在设置中选择其他绝对路径并迁移。当前路径由固定私有状态中的 `state/data-location.json` 定位；bootstrap 和资料库 `infohub-library.json` 必须具有相同的稳定 `libraryId`，才会在创建 Store 前通过身份校验。资料库本身不包含账号、Cookie、设备 token 或团队队列。App 每次启动都会生成 `INFOHUB_DATA.md`，让人和机器在目录内就能理解结构。

```text
用户资料库/
├── infohub-library.json
├── INFOHUB_DATA.md
├── articles/<sourceType>/<sourceId>/<articleId>.md
├── articles/<sourceType>/<sourceId>/<articleId>.<content-sha256>.content.html
├── raw/<sourceType>/<sourceId>/<external-id-sha256>/<content-sha256>.json
├── raw/<sourceType>/<sourceId>/pages/<content-sha256>.page.html
├── outputs/<producer>/...
├── sources.json
└── index.sqlite
```

`infohub-library.json` 标识这是 infohub 资料库，并保存创建后不会被说明文档生成器覆盖的 `libraryId`；`INFOHUB_DATA.md` 是面向人和外部工具的就地说明。`outputs/` 由外部消费者拥有，infohub 不扫描、不索引、不团队同步，也不会把其中结果回灌 Article。

固定私有状态位于 Electron `userData/state/`：`settings.json`、`secrets/`、`team/`、数据位置 bootstrap 和迁移日志都不属于数据接口，不随资料库迁移。Chromium 的持久登录分区仍由 Electron 放在 `userData` 下，也不迁移。升级前的 `.claude/skills/`、`briefings/` 或旧 `README.md` 可能仍留在旧目录；新版本不会使用它们。

## Article：稳定内容接口

`articles/` 是 infohub 当前的**规范化产品投影**。每篇文件由 JSON 值 frontmatter 和 Markdown 正文组成；它可由不可变 Raw 重新生成，且只能由 infohub 更新：

```markdown
---
id: "wechat-..."
externalId: "aid:2247511129_1"
title: "文章标题"
publishedAt: 1750925178000
sourceUrl: "https://mp.weixin.qq.com/s?..."
source: {"id":"wx-...","type":"wechat","name":"来源名"}
ext: {"author_name":"作者","cover":"https://..."}
content: {"status":"complete","parserVersion":2,"contentHtmlPath":"wechat/wx-.../wechat-....7b2c....content.html","pageHtmlPath":"wechat/wx-.../pages/0a1b....page.html","lastAttemptPageHtmlPath":"wechat/wx-.../pages/0a1b....page.html","lastAttemptAt":1750925200000,"lastSuccessAt":1750925200000}
read: false
archived: false
createdAt: 1750925200000
updatedAt: 1750925200000
---

正文 Markdown
```

稳定字段：

| 字段 | 含义 |
|------|------|
| `id` | infohub 全局文章 ID |
| `externalId` | 信源内去重键；微信优先 `aid`，否则使用 `appmsgid/mid + itemidx` 或 URL 的 `__biz + mid + idx`，不把可变 `chksm/scene` 当身份 |
| `title` / 正文 | 归一化后的标题与 Markdown 内容 |
| `publishedAt` | UTC 毫秒时间戳 |
| `sourceUrl` | 原始页面，用于溯源 |
| `source` | 来源 ID、类型、显示名 |
| `ext` | 信源特有元数据；新增字段不会破坏核心契约 |
| `content` | 可选正文状态、解析器版本、HTML sidecar、当前可用页面/最近尝试页面相对路径、尝试/成功时间和失败原因 |
| `team` | 可选团队来源、贡献者和 `contributedByMe`；不含登录凭据 |
| `read` / `archived` | 看板状态 |
| `createdAt` / `updatedAt` | infohub 创建时间 / 内容版本时间；只改 `read`、`archived` 不推进 `updatedAt` |

旧文件中可能存在 `summary/score/tags/staleness/provenance`。infohub 只为兼容历史数据而保留它们，不生成、不展示，也不承诺将其作为长期核心契约。

微信公众号经典图文会在 Markdown 同目录保存按正文 SHA-256 版本化的 `.content.html`。它保留外层 `#js_content` 与内联样式，采集时只为展示提升 `data-src` 等懒加载属性并补全相对 URL。微信图片消息会从页面的已知静态图片列表生成确定性的图片/图注 HTML；不会执行页面脚本。Markdown 是跨信源、方便检索的稳定正文投影；准确 sidecar 由 `content.contentHtmlPath` 指向。新 sidecar 完整落盘后才原子切换 Markdown 指针，避免崩溃时丢失上一份可用投影。两者均为 UTF-8 明文，不压缩、不 Base64。

`content.contentHtmlPath` 相对 `articles/`，`content.pageHtmlPath` 与 `content.lastAttemptPageHtmlPath` 相对 `raw/`。`pageHtmlPath` 指向当前投影所依据的可用页面，`lastAttemptPageHtmlPath` 记录最近一次确实收到的响应，包括 HTTP 错误页或验证页；失败重抓不会替换一份已有的完整投影。路径解析必须约束在各自根目录内。

## Raw：溯源接口

`raw/` 保存两类**不可变抓取快照**：

- `<external-id-sha256>/<content-sha256>.json`：采集列表阶段的稳定上游证据，包含 `sourceId/sourceType/externalId/raw`。运行时观察时间 `fetchedAt` 不进入 blob，避免上游载荷完全相同时每轮自动采集都制造重复文件；真实内容变化仍生成新版本。
- `pages/<content-sha256>.page.html`：微信详情请求返回的完整、未改写 HTML；按实际响应内容寻址，相同内容复用，不同响应（包括错误/验证页）并存。

快照只允许首次创建：命中同一路径时会核对内容，绝不覆盖；理论哈希冲突也以报错并保留旧文件处理。Raw 用于溯源、解析器回归和离线重放，不是外部 AI/Agent 的默认输入，因为不同信源的结构不统一、也可能含诊断页。完整页面只在本机保留，不进入团队同步。

## Outputs：外部处理接口

外部消费者需要持久化摘要、分类、标签、embedding、报告或中间文件时，统一写入：

```text
outputs/<producer>/...
```

`producer` 应使用稳定、互不冲突的名称，例如 `my-agent`、`team-search-v2`。具体内部格式由该消费者自己定义，建议记录输入 Article `id`、`updatedAt` 和工具版本以判断结果是否过期。infohub 不读取、不验证、不删除这些文件；重新解析 Article 也不会自动修改外部结果。`outputs/` 是资料库中唯一允许外部写入的区域；manifest、说明、`articles/`、`raw/`、`sources.json` 和 `index.sqlite` 全部只读。

## SQLite：派生索引接口

`index.sqlite` 用 Node 内置 `node:sqlite` 维护，核心表：

- `articles`：标题、发布时间、来源、状态和文件相对路径。
- `seen_items`：`(source_id, external_id) → article_id` 去重映射。
- `store_meta`：本地 schema 版本。

示例查询：

```sql
-- 最近 100 篇未归档文章
SELECT id, title, published_at, source_id, file_path
FROM articles
WHERE archived = 0 AND contributed_by_me = 1
ORDER BY published_at DESC
LIMIT 100;

-- 按来源统计
SELECT source_type, source_id, COUNT(*) AS article_count
FROM articles
GROUP BY source_type, source_id;
```

SQLite 是加速层，不是唯一数据源：启动时会从 Article 文件完整重建；运行中最多每 500ms 检查一次磁盘 Article 文件变化。该恢复机制不授权外部回写；消费者可以只读索引筛选，再根据 `file_path` 读取完整 Markdown。

## 消费约定

1. AI/Agent 的主输入只读 `articles/`；微信排版可按 `content.contentHtmlPath` 读取同目录 sidecar。
2. `raw/` 仅用于人工诊断或专门的解析器工具，仍然只读；不得“清理”、覆盖或格式化快照。
3. SQLite 以只读连接使用，只作筛选加速；结果排序使用 `publishedAt`，不依赖目录遍历顺序。
4. 外部处理结果只写 `outputs/<producer>/` 或资料库外的独立系统，不修改 Article frontmatter、正文或 sidecar。
5. 不读取 Electron `userData/state/`、Chromium 分区或旧目录中的凭据文件；它们不是资料库接口。
6. 不依赖 infohub 内部 TypeScript 模块、IPC 或团队 outbox。Article 字段和资料库说明才是跨版本接口。
7. 需要稳定增量处理时，用 Article `id + updatedAt` 标识当前投影版本；`read/archived` 变化不代表正文版本变化。

## 历史重处理语义

- **离线重新解析**：已有完整正文时优先读取 `content.pageHtmlPath`；尚未成功时优先读取 `lastAttemptPageHtmlPath`，首选文件丢失时回退到另一个现有快照。它使用当前解析器重新生成 Article/sidecar，不访问网络、不消耗公众号后台账号请求，也不产生新的 Raw；不会改写 `lastAttemptAt/error/lastAttemptPageHtmlPath` 这组最近网络请求诊断，若从失败快照解析成功则只把该快照提升为当前 `pageHtmlPath`。
- **网络重新抓取**：访问 Article 的 `sourceUrl`，任何收到的页面都先按内容寻址追加到 Raw，再解析。成功可推进当前投影；失败保留原有完整正文，只记录尝试时间、错误与 `lastAttemptPageHtmlPath`。
- 两种方式都可按单篇、来源或全部本机文章运行；批量维护包含归档文章，不受看板 500 条列表上限影响。团队独有、并非本机贡献的微信文章默认不代替其他成员重抓。
- 操作结果应给出成功、失败、跳过与错误摘要；长期可复核证据是不可变快照和 Article 的内容状态，不另外让外部工具改写 Raw 作为“修复”。

## 索引演进

当前索引覆盖列表、状态和去重。资料库迁移不复制 `index.sqlite`，目标启动时从 Article 文件重建。下一阶段可补 FTS5 全文索引与正式数据导出；不在 infohub 内增加向量模型、embedding 服务、RAG 或任何模型调用。
