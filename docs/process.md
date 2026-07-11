# 处理层（process）

> 上级：[overview.md](overview.md) · 输入：[RawItem](contract.md#rawitem--原始采集产物未清洗) · 输出：[Article](contract.md#article--统一结构处理层产物全局通用)

职责是把不同信源的原始条目归一为统一 `Article`，并按信源补全正文。pipeline 只做确定性转换，不调用模型，也不判断内容价值。

## 当前 pipeline

```text
RawItem
  │
  ├─ 1. 按 source.type 找 normalizer（必做）
  │     wechat → normalizeWechat
  │     rss    → normalizeRss
  │
  ├─ 2. 统一 Article 字段与 UTC 毫秒时间
  │
  ├─ 3. 正文补全
  │     wechat：抓 sourceUrl → 提取 #js_content → 轻量 HTML→Markdown
  │     rss：优先 entry.content，退回 summary → HTML→Markdown
  │
  └─ 4. Store 写 Markdown + SQLite 索引
```

实现位置：

- `src/core/process/normalize.ts`：normalizer 注册表。
- `src/core/process/wechat.ts`：微信字段映射与稳定文章 ID。
- `src/core/process/rss.ts`：RSS 字段映射、正文选择与稳定 ID。
- `src/core/process/content.ts`：公众号正文提取和轻量 HTML → Markdown。

## 已实现字段

| 字段 | 微信 | RSS |
|------|------|-----|
| title / sourceUrl / source | ✅ | ✅ |
| publishedAt（UTC ms） | ✅，微信秒转毫秒 | ✅，feed 日期解析 |
| body | ✅，公开原文页补全；失败可为空 | ✅，content/summary 转换 |
| ext | fakeid、作者、封面、digest 等 | guid、原 summary |
| read / archived | 初始为 `false` | 初始为 `false` |
| 旧兼容注释 | 不生成、不展示 | 不生成、不展示 |

## 尚未完成

- **正文转换精度**：当前转换器只覆盖常见标题、段落、链接、图片、强调、引用和列表；表格、嵌套布局、音视频等会丢失。
- **重放入口**：保留了 `raw/`，尚无正式命令对旧数据批量重跑新版 normalizer。
- **质量度量**：正文为空、字段缺失、来源不可达等数据质量指标尚未进入索引和看板。

## 展示安全

存储层保留 Markdown 与外链原貌；renderer 展示时执行文本/属性转义、绝对 http(s) URL 白名单和 DOMPurify allowlist。Electron 页面另有 CSP、sandbox 与 main 外链 scheme 校验。安全回归用例覆盖 `javascript:`、`data:`、原始 `<script>` 与属性注入。

## 新增信源

1. 实现 `SourceAdapter`，输出合法 `RawItem`。
2. 实现 `normalizeXxx(item, source)` 并注册 `source.type`。
3. 在 `Service` 注册 adapter。
4. 为 adapter、normalizer、去重和正文策略补测试，并同步 [ingest.md](ingest.md) 与本文件。
