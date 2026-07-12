# 数据接口

> 上级：[overview.md](overview.md) · 存储实现：[storage.md](storage.md) · 字段契约：[contract.md](contract.md)

infohub 的产品边界是**采集、归一化、索引和快速浏览**。它不调用模型、不启动 AI CLI、不安装 Skill，也不管理任何 Agent 任务。AI、脚本或其他分析工具只是普通下游消费者，通过文件系统和 SQLite 读取数据。

## 运行时入口

数据根目录是 Electron 的 `app.getPath('userData')/data`。App 每次启动都会生成 `INFOHUB_DATA.md`，让人和机器在数据目录内就能理解结构。

```text
data/
├── INFOHUB_DATA.md
├── articles/<sourceType>/<sourceId>/<articleId>.md
├── raw/<sourceType>/<sourceId>/<encodedExternalId>.json
├── sources.json
├── settings.json
├── index.sqlite
├── team/
│   ├── outbox/*.json
│   ├── acked/*.ack
│   ├── quarantine/*.json
│   └── sync-state.json
└── secrets/
    ├── wx-accounts.enc
    └── team-device.enc
```

升级前的 `.claude/skills/`、`briefings/` 或旧 `README.md` 可能仍留在用户目录。新版本不会删除用户文件，但不再创建、更新、读取或打包这些目录。

`settings.json` 是 App 的非敏感本地运行设置，不属于稳定内容接口；`team/` 是上传队列和 cursor，也不是内容接口。外部消费者默认无需读取或修改它们。

## Article：稳定内容接口

`articles/` 是数据真相源。每篇文件由 JSON 值 frontmatter 和 Markdown 正文组成：

```markdown
---
id: "wechat-..."
externalId: "https://mp.weixin.qq.com/s?..."
title: "文章标题"
publishedAt: 1750925178000
sourceUrl: "https://mp.weixin.qq.com/s?..."
source: {"id":"wx-...","type":"wechat","name":"来源名"}
ext: {"author_name":"作者","cover":"https://..."}
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
| `externalId` | 信源内去重键 |
| `title` / 正文 | 归一化后的标题与 Markdown 内容 |
| `publishedAt` | UTC 毫秒时间戳 |
| `sourceUrl` | 原始页面，用于溯源 |
| `source` | 来源 ID、类型、显示名 |
| `ext` | 信源特有元数据；新增字段不会破坏核心契约 |
| `team` | 可选团队来源、贡献者和 `contributedByMe`；不含登录凭据 |
| `read` / `archived` | 看板状态 |
| `createdAt` / `updatedAt` | infohub 记录时间 |

旧文件中可能存在 `summary/score/tags/staleness/provenance`。infohub 只为兼容历史数据而保留它们，不生成、不展示，也不承诺将其作为长期核心契约。

## Raw：溯源接口

`raw/` 保存采集阶段的 `RawItem` JSON，包含 `sourceId/sourceType/fetchedAt/externalId/raw`。它适合排查字段映射或重放处理，不适合直接替代 Article，因为不同信源的 `raw` 结构不统一。

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

SQLite 是加速层，不是唯一数据源：启动时会从 Article 文件完整重建；运行中最多每 500ms 同步一次外部文件变化。消费者可以使用索引筛选，再根据 `file_path` 读取完整 Markdown。

## 消费约定

1. 默认只读 `articles/`、`raw/`、`sources.json` 和 `index.sqlite`。
2. 永远不要读取、复制或索引 `secrets/`。
3. `team/outbox` 与 `team/quarantine` 可能包含 Article 正文，但它们是内部可靠队列/隔离区；`team/acked` 是幂等恢复标记。消费者不要扫描、移动或删除。
4. 完整内容与元数据以 Article 文件为准，SQLite 只用于加速。
5. 不依赖目录遍历顺序；排序使用 `publishedAt`。
6. 不修改稳定核心字段。外部产物应写入自己的目录或系统，不要污染 infohub 真相源。
7. 若确需添加兼容注释，必须保持 frontmatter 每行 `key: <JSON value>` 格式。

## 索引演进

当前索引覆盖列表、状态和去重。下一阶段应补 FTS5 全文索引与正式 `rebuild-index`/数据导出命令；不在 infohub 内增加向量模型、embedding 服务、RAG 或任何模型调用。
