# 存储层（store）

> 上级：[overview.md](overview.md) · 契约：[contract.md](contract.md)

存储分三层：**Raw 是按内容寻址的不可变抓取证据；Article Markdown 与其 sidecar 是 infohub 管理的当前规范化投影；SQLite 是可重建索引。** 外部处理结果位于 `outputs/`，不参与 Store、团队同步或索引。schema v3 在 v2 的阅读状态、去重键基础上增加可由 Article 文件重建的本机团队贡献标记；SQLite 列表投影另缓存来源名和正文 sidecar 路径，用于避免热路径读取 Markdown。

## 运行时布局

默认资料库为 `app.getPath('userData')/data`，也可由固定 bootstrap 指向用户选择的目录；它不是仓库里的 `data/`：

```text
资料库/
├── infohub-library.json
├── INFOHUB_DATA.md
├── articles/<sourceType>/<sourceId>/<articleId>.md
├── articles/<sourceType>/<sourceId>/<articleId>.<content-sha256>.content.html
├── raw/<sourceType>/<sourceId>/<external-id-sha256>/<content-sha256>.json
├── raw/<sourceType>/<sourceId>/pages/<content-sha256>.page.html
├── outputs/<producer>/...
├── index.sqlite
└── sources.json

Electron userData/state/              # 固定私有状态，不迁移
├── data-location.json
├── data-location.initialized.json
├── legacy-private-import.json
├── settings.json
├── migrations/
├── team/
└── secrets/
```

仓库 `.gitignore` 已排除根级 `data/`。打包应用使用系统用户数据目录，开发环境通常也落到该目录；不要把真实凭据复制回仓库。

`outputs/` 由外部消费者拥有，Store 不扫描、不回灌；`infohub-library.json` 和 `INFOHUB_DATA.md` 用于识别并解释资料库。旧版本创建的 `.claude/skills/`、`briefings/` 或 `README.md` 不会被自动删除，但新版本完全忽略它们。

固定 `state/settings.json` 保存非敏感运行设置，包括 `wechat.hourlyRequestLimit`、团队地址/启用状态，以及自动采集开关/周期。它使用临时文件 + rename 更新；字段缺失或越界时仅回退对应保守默认值。账号 Cookie、token 和限流观测仍在 `state/secrets/wx-accounts.enc`，团队设备 token 在 `state/secrets/team-device.enc`；这些都不会写入资料库。首次入组的共享 `TEAM_TOKEN` 不持久化。Chromium `persist:` 登录分区同样固定在 Electron `userData`，不随资料库迁移。

## 文章文件

文件格式是 YAML 外观的 frontmatter，但每个值实际用 `JSON.stringify` 编码，以避免引入 YAML 依赖并保证 round-trip：

```markdown
---
id: "wechat-Mzk0-2247511129"
externalId: "aid:2247511129_1"
title: "文章标题"
publishedAt: 1750925178000
sourceUrl: "https://mp.weixin.qq.com/s?..."
source: {"id":"wx-Mzk0","type":"wechat","name":"示例公众号"}
ext: {"fakeid":"Mzk0...","author_name":"作者"}
content: {"status":"complete","parserVersion":2,"contentHtmlPath":"wechat/wx-Mzk0/wechat-Mzk0-2247511129.7b2c....content.html","pageHtmlPath":"wechat/wx-Mzk0/pages/0a1b....page.html","lastAttemptPageHtmlPath":"wechat/wx-Mzk0/pages/0a1b....page.html","lastAttemptAt":1750925200000,"lastSuccessAt":1750925200000}
team: {"remoteId":"art_...","contributedByMe":false,"contributors":[]}
read: false
archived: false
createdAt: 1750925200000
updatedAt: 1750925200000
---

正文 Markdown
```

实现：`src/core/store/markdown.ts`。`filePath` 只保存在 SQLite/运行时对象，不写入 frontmatter。`team` 仅在团队文章存在时写入；旧文件没有该字段时按本机历史贡献处理。`content` 只写正文生命周期和 sidecar 相对路径，不把 HTML 塞进 frontmatter。新文章不写 `summary/score/tags` 等空占位；旧文件中的非空兼容注释会保留。

微信公众号内容还会产生两个明文 HTML 文件：

- `articles/.../<articleId>.<content-sha256>.content.html`：版本化正文投影；经典图文保留外层 `#js_content`、节点顺序和内联样式，图片消息生成确定性的图片/图注结构。准确路径以 Article frontmatter 为准。
- `raw/.../pages/<content-sha256>.page.html`：HTTP 响应的完整未改写页面，按页面内容 SHA-256 寻址，供诊断和离线重解析。

`article:list` 直接查询 SQLite 并返回 `ArticleListItem`，不读取任何 Markdown；`article:get` 只读取选中的单篇 Markdown；`article:getContentHtml` 才依据受根目录约束的 `contentHtmlPath` 读取正文 HTML。这样切换来源和沉浸阅读不会扫描资料库或搬运无关大文本。

## 当前 SQLite schema

SQLite 使用 Node 内置 `node:sqlite`，没有第三方 SQLite 包。

```sql
CREATE TABLE articles (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  published_at  INTEGER,
  source_id     TEXT,
  source_type   TEXT,
  source_name   TEXT,
  source_url    TEXT,
  content_html_path TEXT,
  summary       TEXT,
  score         INTEGER,
  staleness     TEXT,
  tags          TEXT,
  read          INTEGER DEFAULT 0,
  archived      INTEGER DEFAULT 0,
  file_path     TEXT,
  created_at    INTEGER,
  updated_at    INTEGER,
  contributed_by_me INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE seen_items (
  source_id   TEXT,
  external_id TEXT,
  article_id  TEXT,
  PRIMARY KEY (source_id, external_id)
);

CREATE TABLE store_meta (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
```

另有 `published_at`、`source_id` 普通索引。`source_name` 直接支持轻量列表；`content_html_path` 只用于定位按需 sidecar。`contributed_by_me` 由 Article frontmatter 的 `team.contributedByMe` 派生，用于“我的 / 团队”筛选；无 `team` 的旧文件默认是本机贡献。`summary/score/staleness/tags` 列只为兼容已发布的 v0.1.0 schema，不是产品核心字段。**FTS5 当前未创建**，全文检索属于后续能力。

## 团队同步状态

以下路径全部相对固定私有 `state/`，而不是用户资料库：

- `team/outbox/*.json`：本地 Article 成功落盘后生成的一事件一文件队列；微信 Article 只有 `content.status=complete` 时才允许入队并携带 `contentHtml`，`partial/failed` 不会被远端误记成完整正文。eventId 由 API 协议版本、团队实例、设备和完整公开 payload 确定性派生；断网或进程退出会保留。阅读/归档不推进 `updatedAt`，因此不会为同一内容制造新事件。
- `team/acked/*.ack`：服务端 2xx 后先原子写入的确认标记，再删除 outbox。每次启动重扫历史文章时，已确认或已排队事件会跳过。
- `team/quarantine/*.json`：无法解析、超过协议限制、包含私有 RSS 凭据或被服务端永久 4xx 拒绝的事件。坏项被隔离后不阻塞其余事件。
- `team/sync-state.json`：服务端增量 pull 的单调 cursor；文章页全部落盘后才推进。
- `secrets/team-device.enc`：服务端签发的设备凭据，必须使用 Electron `safeStorage`；不可用时拒绝入组落盘。

退出团队会清空 outbox、acked、quarantine、cursor 和设备凭据，但不会删除已同步到本机的 Article。重新加入后会从 Article 文件枚举全部本机贡献并重新排队，因此不依赖旧 outbox 才能恢复。

`v0.3.0` 硬切 API v2，不提供能力协商或 v1 fallback。必须先升级配套团队服务端，再升级全部桌面端；混合版本不受支持。eventId 的协议版本输入改为 2，因此旧 ack/quarantine 不会拦住当前事件；测试期不做旧标记迁移。

## 写入与去重

一次新条目的顺序是：

1. 用 `(sourceId, externalId)` 查询 `seen_items`。
2. 把 `RawItem` 的稳定证据字段 `sourceId/sourceType/externalId/raw` 序列化后写入 `raw/.../<content-sha256>.json`；运行时观察时间 `fetchedAt` 不参与 blob 或哈希，只允许创建、不覆盖。
3. normalizer 生成 Article，并按需补正文。
4. 微信详情收到任何页面（包括 HTTP 错误/验证页）时，先按内容寻址追加不可变 `.page.html`；解析成功后先创建新的内容寻址正文 sidecar，再原子切换 Article 路径。提交后才清理旧投影，崩溃最多留下无引用文件，不会丢上一份可用正文。
5. 原子写文章 Markdown（临时文件 + rename）。
6. upsert `articles`，并由 `saveArticle()` 自动登记 `seen_items`。

`seen_items` 仍只表示列表项已发现，不再阻止正文补全：正文失败/不完整、解析器版本落后、sidecar 或当前页面缺失时会重试；正式维护入口还能绕过上游“最近一页”列表，按单篇、来源或全部文章重放。成功后更新既有 Article，而不是创建重复文章。

离线重新解析不访问网络、不产生新快照：Article 已完整时优先读取 `pageHtmlPath`，尚未成功时优先读取 `lastAttemptPageHtmlPath`，首选文件缺失才回退到另一个。它不会改写最近网络请求的 `lastAttemptAt/error/lastAttemptPageHtmlPath`；若失败快照被新版 parser 完整识别，只把该快照提升为当前 `pageHtmlPath`。网络重新抓取访问 `sourceUrl`，每个实际响应形成新快照。`pageHtmlPath` 指向当前可用投影依据，`lastAttemptPageHtmlPath` 指向最近一次网络收到的响应。失败重抓如果遇到验证页/空页，只追加诊断快照并更新 `lastAttemptAt/error`，不会替换既有完整正文或其成功页面。批量维护枚举含归档文章的 Store 索引，不受看板 500 条上限影响。

公众号 `externalId` 优先用稳定 `aid`，否则使用 `appmsgid/mid + itemidx/idx` 或 URL 的 `__biz + mid + idx`；不把易变化的 `chksm/scene` 当身份。RSS 用 guid 或 link。取关时 `purgeSource()` 删除纯本地 Article Markdown 及其当前正文 sidecar；带 `team.remoteId` 的团队副本继续保留，并重建 `seen_items` 防止 pull 或重新订阅产生重复。列表 Raw JSON 与完整 `.page.html` 目前不会清理。

## schema 一致性与历史迁移

### 文件与状态

- Article frontmatter 持久化 `externalId`、`read`、`archived`。
- `setRead()` / `setArchived()` 读取最新文件，更新状态后通过 `saveArticle()` 同步文件和索引，因此不会覆盖其他兼容字段。
- Article Markdown 使用临时文件 + `rename` 原子替换；正文 HTML、Raw JSON 与完整页面按内容寻址并独占创建，相同内容复用，既有文件永不替换。正文新版本落盘后才切换 Markdown 指针，提交成功再清理旧引用。若 Article 文件成功而 SQLite 写失败，下次启动可从文件恢复。
- 所有文章/raw 路径都必须解析在各自 data 子目录内；来自 frontmatter 或 adapter 的 `..`/绝对路径不能逃逸。

### v0.1.0 一次性迁移

旧版本把阅读/归档只写 SQLite，文章文件没有 `externalId`。首次用新版本打开数据目录时：

1. 检查 `store_meta.schema_version`；无记录按 v1 处理。
2. 把旧 SQLite 的 `read/archived` 回填到对应 Markdown。
3. 微信旧文件用 `sourceUrl` 推导 `externalId`；RSS 优先用 `ext.guid`，再退回 URL/文章 id。
4. 记录 schema v2，并从文件完整重建 `articles` 与 `seen_items`。

迁移不修改正文或已有的非空兼容注释。

### schema v3 团队贡献索引

升级到 v3 时，`articles` 增加 `contributed_by_me`，随后仍从所有 Article 文件完整重建。旧文件没有 `team`，默认写入 `1`；团队 pull 的文件依据 `team.contributedByMe` 写入 `0/1`。SQLite 丢失后，“我的 / 团队”范围仍能恢复。

### 外部文件变化

- App 正常启动直接使用现有 SQLite，不再每次完整扫描。索引首次创建、投影结构升级，或 `index_dirty=1` 表明上次在 Markdown rename 与 SQLite 提交之间中断时，才从全部 Article 文件重建。
- `saveArticle()` 在文件切换前写 dirty 标记，文件和索引一致后清除；批量已读使用批次级 dirty 与单个 SQLite 事务。列表、未读统计和筛选不调用文件扫描。
- `syncIndexFromFiles()` / `rebuildIndex()` 仍保留为显式恢复能力和迁移机制，不是外部写入 API。外部消费者不得修改 Article/Raw；它们的结果只写 `outputs/<producer>/`，该目录不会被扫描或回灌。

`rebuildIndex()` 目前仍是 Store API，没有独立 CLI/IPC；外部直接修改或删除文件不会在普通 UI 查询时自动回灌，必须显式 rebuild。这个限制与外部消费者只读 `articles/` 的正式契约一致。

## 资料库定位与迁移

`state/data-location.json` 是 schema v1 bootstrap，记录资料库的绝对 `activeRoot`、最近一次已知可用路径和稳定 `libraryId`。根目录 `infohub-library.json` 必须携带相同 `libraryId`，App 才会创建 Store：

- 只有 bootstrap、初始化 marker 和 manifest 都不存在时才视为真正首次运行，允许创建默认 `userData/data`。已初始化后 bootstrap 缺失会 fail-closed，不会静默回到默认旧库/空库。
- 已配置根不存在、不是目录、是符号链接/目录联接、不可读写、manifest 缺失/损坏或 `libraryId` 不匹配时显式停止，不在原路径静默创建空资料库。这也防止 Windows 盘符被分配给另一块盘时误开同路径目录。
- 设置页只排队迁移请求；App 停止采集/同步并重启，在 Store 打开前执行复制。目标必须为空且不能与源互相嵌套。
- 在目标同一父目录创建 staging，逐文件复制并校验大小与 SHA-256；全部通过后 rename 提交，再原子切换 bootstrap。
- 源目录始终保留。App 不代用户删除；用户应在新资料库验收后自行备份/清理。
- `index.sqlite`、SQLite 临时文件和 `.tmp` 不复制；目标启动时重建索引。
- bootstrap 提交前的失败仍使用原资料库，并把中文结果写入 `state/migrations/last-result.json`。bootstrap 一旦原子切换就是提交点；此后的收尾异常会阻断当次启动，绝不回旧 sourceRoot 继续写入。下次启动会识别“pending 目标已是 activeRoot”并安全收尾。
- v0.3.x 混放在旧 data 下的 `settings.json`、`secrets/`、`team/` 只在首次 v0.4 启动时安全复制到固定 `state/`，目标已存在则不覆盖，旧文件仍保留。完成后写入一次性 `legacy-private-import.json`；以后即使新凭据文件被删除，也不会从保留的旧目录复活 Cookie 或团队 token。迁移日志也固定保存在 `state/migrations/`。

这种拆分让用户能把 `articles/raw/outputs` 放到大容量磁盘或交给外部工具，同时不会把 Cookie、设备 token、outbox 或浏览器登录态一起暴露。

## 敏感数据

`src/main/secrets.ts` 在 `safeStorage.isEncryptionAvailable()` 时使用系统 keychain 加密账号池；不可用时仍会回退成明文，文件名仍为 `.enc`。`src/main/team-secrets.ts` 的团队设备 token 不允许该 fallback：没有安全存储时入组失败，不写明文。

- 该回退曾为个人 WSL 开发场景接受，不代表适合公开分发。
- UI 当前没有明确显示“凭据正在明文保存”。
- 加密可用性变化时没有格式标记或迁移机制；读取失败会返回空账号池。

稳定版前应加入格式版本、明确告警和迁移/恢复路径；不要把 cookie/token 写入日志或测试夹具。

## 已有测试与缺口

现有测试覆盖 Markdown/SQLite 往返、正文状态 frontmatter、内容寻址 Raw/页面多版本共存、HTML sidecar 与失败尝试保留、维护文章全量枚举、列表/详情分离、状态双写、`seen_items` 重建、外部文件同步、旧 schema 状态迁移、资料库定位/缺盘失败和迁移复制/校验/恢复。尚缺磁盘满、真实跨盘断电、Windows 文件锁/原子替换、损坏文件隔离和大量文章性能测试。
