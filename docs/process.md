# 处理层（process）

> 上级：[overview.md](overview.md) · 输入：[RawItem](contract.md#rawitem--原始采集产物未清洗) · 输出：[Article](contract.md#article--统一结构处理层产物全局通用) · 公众号正文设计：[wechat-content.md](wechat-content.md)

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
  │     wechat：抓 sourceUrl → parse5 树定位 #js_content
  │             ├─ 未改写完整 page HTML
  │             ├─ 可展示 content HTML（保留外层/内联样式）
  │             └─ 轻量 HTML→Markdown 阅读投影
  │     rss：优先 entry.content，退回 summary → HTML→Markdown
  │
  └─ 4. Store 写 Markdown + HTML sidecar/Raw 页面 + SQLite 索引
```

实现位置：

- `src/core/process/normalize.ts`：normalizer 注册表。
- `src/core/process/wechat.ts`：微信字段映射与稳定文章 ID。
- `src/core/process/rss.ts`：RSS 字段映射、正文选择与稳定 ID。
- `src/core/process/content.ts`：公众号完整页面获取、parse5 树提取、展示 HTML 准备和轻量 HTML → Markdown。

## 已实现字段

| 字段 | 微信 | RSS |
|------|------|-----|
| title / sourceUrl / source | ✅ | ✅ |
| publishedAt（UTC ms） | ✅，微信秒转毫秒 | ✅，feed 日期解析 |
| body | ✅，公开原文页补全；失败时保留旧正文或为空 | ✅，content/summary 转换 |
| content | ✅，状态/解析器版本/sidecar 路径/时间/中文错误 | 当前不需要 |
| HTML 产物 | ✅，正文 `.content.html` + 完整 `.page.html` | 当前不生成 |
| ext | fakeid、作者、封面、digest 等 | guid、原 summary |
| read / archived | 初始为 `false` | 初始为 `false` |
| 旧兼容注释 | 不生成、不展示 | 不生成、不展示 |

## 正文生命周期（已实现）

`seen_items` 只阻止重复创建文章，不再等同于“正文完整”。微信条目满足任一条件时，会在后续手动刷新再次出现在列表结果后重试 `enrichContent`：

- 没有 `content` 状态；
- `status` 不是 `complete`；
- `parserVersion` 低于当前 adapter 版本；
- `contentHtmlPath` 缺失或 sidecar 已丢失；
- 微信条目缺少本机 `pageHtmlPath`，或路径指向的 `.page.html` 已丢失。这会让先从团队取得 `contentHtml` 的文章在本机真实采到后补存完整页面，也能修复被外部删除的页面快照。

失败不会删除文章元数据，也不会用空结果覆盖一份已经完整的正文。成功补齐后原地更新 Article/sidecar；正文内容确有改善时计入刷新结果的 `updatedArticles`，仅补存本机完整页面不伪装成一篇新/更新文章。网络超时、HTTP 失败与正文节点缺失会记录清晰中文错误；若服务器已经返回 HTML，即使找不到正文节点也保留完整页面。

## 尚未完成

- **Markdown 转换精度**：原始排版 iframe 已能保留经典 `#js_content` 的样式/未知节点，但 Markdown 阅读版仍只覆盖常见标题、段落、链接、图片、强调、引用和列表；表格、音视频和卡片的语义投影仍有限。
- **页面形态**：新旧 SSR 图片页、风控/验证页和依赖脚本运行的动态组件尚无专用解析器，静态 HTML 可能不完整。
- **批量重放入口**：完整页面已经保留，但尚无正式命令离线重跑所有旧页面；当前重试依赖条目再次出现在手动刷新结果中。
- **质量度量**：正文为空、字段缺失、来源不可达等数据质量指标尚未进入索引和看板。

## 展示边界

官方 `mp.weixin.qq.com` 正文 HTML 按产品决定视为可信内容，并放在 iframe 中隔离 CSS/布局；默认显示原始排版，也可切换到 Markdown 阅读版。静态快照不执行微信页面脚本，因此复杂动态组件仍可能需要“打开原文”。

RSS 与 Markdown 展示仍执行文本/属性转义、绝对 http(s) URL 白名单和 DOMPurify allowlist。Electron 页面继续使用 CSP、sandbox 与 main 外链 scheme 校验；原有 `javascript:`、`data:`、原始 `<script>` 与属性注入回归不删除。

## 新增信源

1. 实现 `SourceAdapter`，输出合法 `RawItem`。
2. 实现 `normalizeXxx(item, source)` 并注册 `source.type`。
3. 在 `Service` 注册 adapter。
4. 为 adapter、normalizer、去重和正文策略补测试，并同步 [ingest.md](ingest.md) 与本文件。
