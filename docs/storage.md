# 存储层（store）

> 上级：[overview.md](overview.md) · 契约：[contract.md](contract.md)

原则是：**Article Markdown 与其声明的内容 sidecar 为内容源，SQLite 是派生索引。** schema v3 在 v2 的阅读状态、去重键和外部文件同步基础上，增加可由文件重建的本机团队贡献标记；微信公众号 HTML 不需要新增 SQLite 列。

## 运行时布局

数据根目录由 `app.getPath('userData')/data` 决定，不是仓库里的 `data/`：

```text
data/
├── INFOHUB_DATA.md
├── articles/<sourceType>/<sourceId>/<articleId>.md
├── articles/<sourceType>/<sourceId>/<articleId>.content.html
├── raw/<sourceType>/<sourceId>/<encodedExternalId>.json
├── raw/<sourceType>/<sourceId>/<sha256>.page.html
├── index.sqlite
├── sources.json
├── settings.json
├── team/
│   ├── outbox/*.json
│   ├── acked/*.ack
│   ├── quarantine/*.json
│   └── sync-state.json
└── secrets/
    ├── wx-accounts.enc
    └── team-device.enc
```

仓库 `.gitignore` 已排除根级 `data/`。打包应用使用系统用户数据目录，开发环境通常也落到该目录；不要把真实凭据复制回仓库。

旧版本创建的 `.claude/skills/`、`briefings/` 或 `README.md` 不会被自动删除，但新版本完全忽略它们。

`settings.json` 只保存非敏感运行设置，目前包含 `wechat.hourlyRequestLimit` 与团队地址/启用状态。它使用临时文件 + rename 更新；文件缺失、损坏或字段越界时回退保守默认值。账号 Cookie、token 和限流观测仍在 `secrets/wx-accounts.enc`，团队设备 token 在 `secrets/team-device.enc`；这些都不会写入明文设置文件。首次入组的共享 `TEAM_TOKEN` 不持久化。

## 文章文件

文件格式是 YAML 外观的 frontmatter，但每个值实际用 `JSON.stringify` 编码，以避免引入 YAML 依赖并保证 round-trip：

```markdown
---
id: "wechat-Mzk0-2247511129"
externalId: "https://mp.weixin.qq.com/s?..."
title: "文章标题"
publishedAt: 1750925178000
sourceUrl: "https://mp.weixin.qq.com/s?..."
source: {"id":"wx-Mzk0","type":"wechat","name":"示例公众号"}
ext: {"fakeid":"Mzk0...","author_name":"作者"}
content: {"status":"complete","parserVersion":1,"contentHtmlPath":"wechat/wx-Mzk0/wechat-Mzk0-2247511129.content.html","pageHtmlPath":"wechat/wx-Mzk0/0a1b....page.html","lastAttemptAt":1750925200000,"lastSuccessAt":1750925200000}
team: {"remoteId":"art_...","contributedByMe":false,"contributors":[]}
read: false
archived: false
createdAt: 1750925200000
updatedAt: 1750925200000
---

正文 Markdown
```

实现：`src/core/store/markdown.ts`。`filePath` 只保存在 SQLite/运行时对象，不写入 frontmatter。`team` 仅在团队文章存在时写入；旧文件没有该字段时按本机历史贡献处理。`content` 只写正文生命周期和 sidecar 相对路径，不把 HTML 塞进 frontmatter。新文章不写 `summary/score/tags` 等空占位；旧文件中的非空兼容注释会保留。

微信公众号经典图文还会产生两个明文 HTML 文件：

- `articles/.../<articleId>.content.html`：保留外层 `#js_content`、节点顺序和内联样式；仅提升懒加载资源属性并补全相对 URL，供看板/外部消费者直接呈现。
- `raw/.../<sha256>.page.html`：HTTP 响应的完整未改写页面，文件名由 `externalId/sourceUrl/id` 的稳定 SHA-256 派生，供诊断和未来离线重解析。

`article:list` 只读 Markdown/frontmatter 并返回轻量 Article；`article:get` 才依据受根目录约束的 `contentHtmlPath` 读取正文 HTML。这样列表与同步索引不会反复搬运大文本。

## 当前 SQLite schema

SQLite 使用 Node 内置 `node:sqlite`，没有第三方 SQLite 包。

```sql
CREATE TABLE articles (
  id            TEXT PRIMARY KEY,
  title         TEXT NOT NULL,
  published_at  INTEGER,
  source_id     TEXT,
  source_type   TEXT,
  source_url    TEXT,
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

另有 `published_at`、`source_id` 普通索引。`contributed_by_me` 由 Article frontmatter 的 `team.contributedByMe` 派生，用于“我的 / 团队”筛选；无 `team` 的旧文件默认是本机贡献。`summary/score/staleness/tags` 列只为兼容已发布的 v0.1.0 schema，不是产品核心字段。**FTS5 当前未创建**，全文检索属于后续能力。

## 团队同步状态

- `team/outbox/*.json`：本地 Article 成功落盘后生成的一事件一文件队列；Article 有正文 HTML 时，公开 payload 直接包含 `contentHtml`。eventId 由 API 协议版本、团队实例、设备和完整公开 payload 确定性派生；断网或进程退出会保留。阅读/归档不推进 `updatedAt`，因此不会为同一内容制造新事件。
- `team/acked/*.ack`：服务端 2xx 后先原子写入的确认标记，再删除 outbox。每次启动重扫历史文章时，已确认或已排队事件会跳过。
- `team/quarantine/*.json`：无法解析、超过协议限制、包含私有 RSS 凭据或被服务端永久 4xx 拒绝的事件。坏项被隔离后不阻塞其余事件。
- `team/sync-state.json`：服务端增量 pull 的单调 cursor；文章页全部落盘后才推进。
- `secrets/team-device.enc`：服务端签发的设备凭据，必须使用 Electron `safeStorage`；不可用时拒绝入组落盘。

退出团队会清空 outbox、acked、quarantine、cursor 和设备凭据，但不会删除已同步到本机的 Article。重新加入后会从 Article 文件枚举全部本机贡献并重新排队，因此不依赖旧 outbox 才能恢复。

`v0.3.0` 硬切 API v2，不提供能力协商或 v1 fallback。必须先升级配套团队服务端，再升级全部桌面端；混合版本不受支持。eventId 的协议版本输入改为 2，因此旧 ack/quarantine 不会拦住当前事件；测试期不做旧标记迁移。

## 写入与去重

一次新条目的顺序是：

1. 用 `(sourceId, externalId)` 查询 `seen_items`。
2. 写 `raw/...json`。
3. normalizer 生成 Article，并按需补正文。
4. 微信详情抓取后原子写完整 `.page.html` 与正文 `.content.html`，并把路径/状态写入 Article。
5. 原子写文章 Markdown（临时文件 + rename）。
6. upsert `articles`，并由 `saveArticle()` 自动登记 `seen_items`。

`seen_items` 仍只表示列表项已发现，不再阻止正文补全：正文状态为 `failed/partial`、解析器版本落后、正文 sidecar 丢失，或微信条目的本机 `pageHtmlPath`/对应 `.page.html` 文件缺失时，只要该条目再次出现在后续手动刷新结果中就会重试；成功后更新既有 Article，而不是创建重复文章。这也保证先从团队取得正文 HTML 的文章，在本机真实采到后能补存完整页面，并修复被外部删除的页面快照。抓取失败也可保留完整返回页和中文错误，供后续分析。

公众号 `externalId` 优先用文章 link，RSS 用 guid 或 link。取关时 `purgeSource()` 删除纯本地 Article Markdown 及其 `.content.html`；带 `team.remoteId` 的团队副本继续保留，并重建 `seen_items` 防止 pull 或重新订阅产生重复。列表 Raw JSON 与完整 `.page.html` 目前不会清理。

## schema v2 一致性与迁移

### 文件与状态

- Article frontmatter 持久化 `externalId`、`read`、`archived`。
- `setRead()` / `setArchived()` 读取最新文件，更新状态后通过 `saveArticle()` 同步文件和索引，因此不会覆盖其他兼容字段。
- Article Markdown、正文 HTML、完整页面 HTML 与 raw JSON 使用临时文件 + `rename` 原子替换；文件写失败时旧文件仍在，索引不变。若文件成功而 SQLite 写失败，下次同步可从文件恢复。
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

- App 每次启动完整重建索引。
- 运行中读取文章列表或未读数前，`syncIndexFromFiles()` 最多每 500ms 扫描一次 Markdown 并 upsert 索引。
- 因此外部工具在保持格式合法的前提下修改文件后，重启或下一次 UI 刷新即可回灌，无需手工删库。默认仍建议消费者只读。

`rebuildIndex()` 目前仍是 Store API，没有独立 CLI/IPC；外部直接删除文件时，运行中增量同步不会主动清除旧索引，重启/完整 rebuild 会清理。

## 敏感数据

`src/main/secrets.ts` 在 `safeStorage.isEncryptionAvailable()` 时使用系统 keychain 加密账号池；不可用时仍会回退成明文，文件名仍为 `.enc`。`src/main/team-secrets.ts` 的团队设备 token 不允许该 fallback：没有安全存储时入组失败，不写明文。

- 该回退曾为个人 WSL 开发场景接受，不代表适合公开分发。
- UI 当前没有明确显示“凭据正在明文保存”。
- 加密可用性变化时没有格式标记或迁移机制；读取失败会返回空账号池。

稳定版前应加入格式版本、明确告警和迁移/恢复路径；不要把 cookie/token 写入日志或测试夹具。

## 已有测试与缺口

现有测试已覆盖 Markdown/SQLite 往返、正文状态 frontmatter、HTML sidecar/完整页面写入与重启读取、列表/详情分离、sidecar 清理、自动去重登记、状态双写、`seen_items` 重建、外部文件同步、v0.1.0 状态迁移和路径防逃逸。尚缺故障注入（磁盘满/rename 或 SQLite 写失败）、损坏文件隔离、跨平台 Windows 文件替换与大量文章性能测试。
