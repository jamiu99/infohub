# 存储层（store）

> 上级：[overview.md](overview.md) · 契约见 [contract.md](contract.md)

**核心原则：文件为源，SQLite 只做索引。** 数据的"真相"在文件里，SQLite 可随时从文件重建。这样通用 agent（Claude Code / Codex）在数据目录下 `ls`/`grep`/读 md 就能直接工作，不依赖我们的应用。

## 文件布局（`data/`，gitignore）

```
data/
├── articles/                     # 文章正文与元数据（真相源）
│   └── <sourceType>/<sourceId>/
│       └── <articleId>.md        # frontmatter(YAML 元数据) + markdown 正文
├── raw/                          # 原始采集载荷（溯源/重放用）
│   └── <sourceType>/<sourceId>/<externalId>.json
├── index.sqlite                  # 索引库（可从 articles/ 重建）
├── sources.json                  # 信源清单（Source[]）
└── secrets/                      # 加密敏感数据（safeStorage）
    └── wx-accounts.enc           # 公众号账号池（cookie/token 加密）
```

### 文章文件格式（`<articleId>.md`）

```markdown
---
id: wechat-Mzk0-2247511129
title: 蓝湖悄咪咪在海外做了个 AI 设计产品
publishedAt: 1750925178000        # UTC ms
sourceUrl: http://mp.weixin.qq.com/s?...
source: { id: gh_8e5fb, type: wechat, name: 特工宇宙 }
summary: null
score: null
tags: []
ext: { fakeid: Mzk0..., author_name: 特工少女, cover: https://... }
---

（正文 markdown，处理层填充）
```

`Article` 结构见 [contract.md](contract.md#article--统一结构处理层产物全局通用)。frontmatter 即 Article 的元数据，正文即 `body`。

## SQLite 索引 schema

用 **Node 内置 `node:sqlite`**（遵全局规范，禁止三方 sqlite 库）。只存可查询的索引字段，不当真相源。

```sql
CREATE TABLE articles (
  id          TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  published_at INTEGER,           -- UTC ms
  source_id   TEXT,
  source_type TEXT,
  source_url  TEXT,
  summary     TEXT,
  score       INTEGER,
  staleness   TEXT,
  tags        TEXT,               -- json array
  file_path   TEXT,               -- 指回 data/articles/... 真相源
  created_at  INTEGER,
  updated_at  INTEGER
);
CREATE INDEX idx_articles_published ON articles(published_at);
CREATE INDEX idx_articles_source    ON articles(source_id);

-- 去重：外部 id 唯一
CREATE TABLE seen_items (
  source_id   TEXT,
  external_id TEXT,               -- wechat: link；rss: guid
  article_id  TEXT,
  PRIMARY KEY (source_id, external_id)
);

-- P3 全文检索
CREATE VIRTUAL TABLE articles_fts USING fts5(title, body, content=''); 
```

## 去重

采集到 `RawItem` 后，先查 `seen_items(source_id, external_id)`：已存在则跳过，否则处理入库并登记。公众号用 `link`、RSS 用 `guid` 作 `external_id`。

## 重建索引

`index.sqlite` 删了也不怕：扫描 `data/articles/**/*.md`，解析 frontmatter 重灌 `articles` + `seen_items`。这条命令是"文件为源"落到实处的保证，实现时提供 `store rebuild-index`。
