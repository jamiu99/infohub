# 存储层（store）

> 上级：[overview.md](overview.md) · 契约：[contract.md](contract.md)

原则是：**文章文件为内容源，SQLite 是派生索引。** schema v2 已把阅读状态、去重键和外部文件变化纳入可同步、可重建流程。

## 运行时布局

数据根目录由 `app.getPath('userData')/data` 决定，不是仓库里的 `data/`：

```text
data/
├── INFOHUB_DATA.md
├── articles/<sourceType>/<sourceId>/<articleId>.md
├── raw/<sourceType>/<sourceId>/<encodedExternalId>.json
├── index.sqlite
├── sources.json
└── secrets/wx-accounts.enc
```

仓库 `.gitignore` 已排除根级 `data/`。打包应用使用系统用户数据目录，开发环境通常也落到该目录；不要把真实凭据复制回仓库。

旧版本创建的 `.claude/skills/`、`briefings/` 或 `README.md` 不会被自动删除，但新版本完全忽略它们。

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
read: false
archived: false
createdAt: 1750925200000
updatedAt: 1750925200000
---

正文 Markdown
```

实现：`src/core/store/markdown.ts`。`filePath` 只保存在 SQLite/运行时对象，不写入 frontmatter。新文章不写 `summary/score/tags` 等空占位；旧文件中的非空兼容注释会保留。

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
  updated_at    INTEGER
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

另有 `published_at`、`source_id` 普通索引。`summary/score/staleness/tags` 列只为兼容已发布的 v0.1.0 schema，不是产品核心字段。**FTS5 当前未创建**，全文检索属于后续能力。

## 写入与去重

一次新条目的顺序是：

1. 用 `(sourceId, externalId)` 查询 `seen_items`。
2. 写 `raw/...json`。
3. normalizer 生成 Article，并按需补正文。
4. 原子写文章 Markdown（临时文件 + rename）。
5. upsert `articles`，并由 `saveArticle()` 自动登记 `seen_items`。

公众号 `externalId` 优先用文章 link，RSS 用 guid 或 link。取关时 `purgeSource()` 会删除该源的文章文件、`articles` 与 `seen_items`；原始 `raw/` 目前不会清理。

## schema v2 一致性与迁移

### 文件与状态

- Article frontmatter 持久化 `externalId`、`read`、`archived`。
- `setRead()` / `setArchived()` 读取最新文件，更新状态后通过 `saveArticle()` 同步文件和索引，因此不会覆盖其他兼容字段。
- 文章与 raw JSON 使用临时文件 + `rename` 原子替换；文件写失败时旧文件仍在，索引不变。若文件成功而 SQLite 写失败，下次同步可从文件恢复。
- 所有文章/raw 路径都必须解析在各自 data 子目录内；来自 frontmatter 或 adapter 的 `..`/绝对路径不能逃逸。

### v0.1.0 一次性迁移

旧版本把阅读/归档只写 SQLite，文章文件没有 `externalId`。首次用新版本打开数据目录时：

1. 检查 `store_meta.schema_version`；无记录按 v1 处理。
2. 把旧 SQLite 的 `read/archived` 回填到对应 Markdown。
3. 微信旧文件用 `sourceUrl` 推导 `externalId`；RSS 优先用 `ext.guid`，再退回 URL/文章 id。
4. 记录 schema v2，并从文件完整重建 `articles` 与 `seen_items`。

迁移不修改正文或已有的非空兼容注释。

### 外部文件变化

- App 每次启动完整重建索引。
- 运行中读取文章列表或未读数前，`syncIndexFromFiles()` 最多每 500ms 扫描一次 Markdown 并 upsert 索引。
- 因此外部工具在保持格式合法的前提下修改文件后，重启或下一次 UI 刷新即可回灌，无需手工删库。默认仍建议消费者只读。

`rebuildIndex()` 目前仍是 Store API，没有独立 CLI/IPC；外部直接删除文件时，运行中增量同步不会主动清除旧索引，重启/完整 rebuild 会清理。

## 敏感数据

`src/main/secrets.ts` 在 `safeStorage.isEncryptionAvailable()` 时使用系统 keychain 加密账号池；不可用时回退成明文 JSON，文件名仍为 `.enc`。

- 该回退曾为个人 WSL 开发场景接受，不代表适合公开分发。
- UI 当前没有明确显示“凭据正在明文保存”。
- 加密可用性变化时没有格式标记或迁移机制；读取失败会返回空账号池。

稳定版前应加入格式版本、明确告警和迁移/恢复路径；不要把 cookie/token 写入日志或测试夹具。

## 已有测试与缺口

现有测试已覆盖 Markdown/SQLite 往返、自动去重登记、状态双写、`seen_items` 重建、外部文件同步、v0.1.0 状态迁移和路径防逃逸。尚缺故障注入（磁盘满/rename 或 SQLite 写失败）、损坏文件隔离、跨平台 Windows 文件替换与大量文章性能测试。
