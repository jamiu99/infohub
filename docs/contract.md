# 数据契约

> 上级：[overview.md](overview.md) · 这是所有模块的"接头暗号"，改字段必须回来改这里并通知下游。

契约是模块解耦的关键：ingest 只需产出 `RawItem`，process 只认 `RawItem` 产出 `Article`，谁都不关心对方内部怎么实现。**字段稳定 = 下游高度灵活。**

## Source — 信源定义

```ts
interface Source {
  id: string;             // 稳定唯一 id
  type: 'wechat' | 'rss' | string;  // 可拓展：未来 adapter 自定义 type
  name: string;           // 展示名，如 "特工宇宙"
  enabled: boolean;
  config: Record<string, unknown>;  // 各 adapter 自定义（wechat: fakeid；rss: feedUrl）
  lastFetchedAt?: number; // UTC 毫秒时间戳
}
```

当前实现把信源清单存于 `data/sources.json`。`wechat.config = { fakeid, alias?, signature? }`，`rss.config = { feedUrl }`。

## DiscoverResult — 添加信源候选

adapter 的 `discover()` 输出，也是 main 通过 IPC 传给 renderer 的结构：

```ts
interface DiscoverResult {
  config: Record<string, unknown>; // 建 Source 所需配置
  name: string;
  meta?: Record<string, unknown>;  // 头像、签名、feed 条目数等展示信息
}
```

## RawItem — 原始采集产物（未清洗）

ingest 层的唯一输出。保留信源原样载荷，**不做任何加工**，方便溯源和 process 层重放。

```ts
interface RawItem {
  sourceId: string;
  sourceType: string;
  fetchedAt: number;       // 采集时刻 UTC 毫秒
  externalId: string;      // 信源内唯一 id（wechat: aid/link；rss: guid）→ 用于去重
  raw: Record<string, unknown>;  // 原始字段整包（如公众号 app_msg_list 的一项）
}
```

## Article — 统一结构（处理层产物，全局通用）

这是整个系统的核心数据结构。所有信源处理后都归一到它，下游的文件存储、索引、看板与外部消费者只认这份稳定契约。

```ts
type ArticleContentStatus = 'complete' | 'partial' | 'failed'

interface ArticleContentState {
  status: ArticleContentStatus;
  parserVersion: number;
  contentHtmlPath?: string; // 相对 articles/ 的正文 HTML sidecar
  pageHtmlPath?: string;    // 相对 raw/ 的完整页面 HTML
  lastAttemptAt: number;
  lastSuccessAt?: number;
  error?: {
    code: string;
    message: string;
  };
}

interface Article {
  id: string;              // 全局唯一（sourceId + externalId 派生）
  externalId: string;      // 信源内去重键；写入文件，供 seen_items 重建
  title: string;           // 标题
  body: string;            // 正文（markdown）
  publishedAt: number;     // 发布时间 UTC 毫秒（存 UTC，展示本地时区）
  sourceUrl: string;       // 原始来源 URL（溯源用）
  source: { id: string; type: string; name: string };

  // —— 旧文件/外部工具的兼容注释；infohub 不生成、不展示 ——
  summary?: string;
  score?: number;
  staleness?: 'fresh' | 'aging' | 'stale';  // 老化判断
  provenance?: {           // 溯源校验结果
    verified: boolean;
    note?: string;
  };
  tags?: string[];

  // —— 可拓展字段：不同信源的特色元数据有处安放 ——
  ext: Record<string, unknown>;  // wechat: {fakeid, cover, author_name}; rss: {guid, summary}

  // —— 可选正文生命周期；当前主要用于微信 ——
  content?: ArticleContentState;

  // —— 可选团队来源；旧文件无此字段时视为本机历史贡献 ——
  team?: {
    remoteId?: string;
    contributedByMe: boolean;
    contributors?: Array<{
      deviceId: string;
      memberName: string;
      deviceName: string;
      collectedAt: number;
    }>;
    sourceConfig?: Record<string, unknown>;
    detachedFromLocalSource?: boolean; // 已取消本地订阅，pull 不恢复为“我的”
  };

  // —— 存储/状态元信息 ——
  filePath?: string;       // 落地文件相对路径（store 填充）
  read?: boolean;          // 阅读状态
  archived?: boolean;      // 归档状态
  createdAt: number;
  updatedAt: number;
}

interface ArticleDetail extends Article {
  contentHtml?: string;     // article:get 按需读取；article:list 不携带大段 HTML
}
```

### 设计要点

1. **`ext` 隔离信源差异**：新信源特有字段放进 `ext`，核心结构不动，下游不受影响。
2. **时间统一 UTC 毫秒**：存 UTC，展示按本地时区（遵 harness taste 约定）。
3. **`sourceUrl` + `provenance` 支撑溯源**：处理层可标记"这条溯源有问题"。
4. **兼容注释不是核心契约**：旧 `summary/score/tags/staleness/provenance` 会保留，但 infohub 不生成、不展示，也不要求消费者依赖。
5. **`externalId` 必须持久化**：否则删掉 SQLite 后无法重建去重表。v0.1.0 旧文件的推导与状态迁移见 [storage.md](storage.md#schema-v2-一致性与迁移)。
6. **团队字段也是文件数据**：`team.contributedByMe` 用于重建“我的”索引，`contributors` 仅是服务端公开贡献信息；这里不允许出现 Cookie、token、fingerprint 或浏览器 session。
7. **`content` 描述正文生命周期，不内联 HTML**：frontmatter 只写状态、解析器版本、相对 sidecar 路径、尝试/成功时间与中文错误；正文 HTML 保存在同名 `.content.html`，完整页面保存在 `raw/*.page.html`。
8. **列表与详情分离**：`article:list` 返回轻量 `Article[]`，只有 `article:get` 返回 `ArticleDetail` 并按需读取 `contentHtml`，避免列表 IPC 搬运大段 HTML。

## 团队传输 DTO

团队上传不是对 `Source` / `Article` 做任意 JSON 序列化，而是使用 [team-sharing.md](team-sharing.md) 中的显式 allowlist：

- Source 只传 `type/name`，微信公众号配置只传 `fakeid`，RSS 只传 `feedUrl`。
- Article 基础契约只传 `externalId/title/body/publishedAt/sourceUrl/createdAt/updatedAt` 和按信源筛选后的 `ext`。
- Article 有正文 HTML 时直接额外发送 `contentHtml`；RSS 或正文获取失败时可以省略。`join/status` 不做能力协商。
- `read/archived/filePath/team`、Raw 原始载荷和所有登录凭据不上传。

`read` / `archived` 改变时会写回 Article 文件，但不会改变内容版本 `updatedAt`；因此团队 payload 和确定性 eventId 保持不变。只有正文或公开元数据真正变化时才推进内容版本。

团队正文 HTML 是 `.content.html` 的文本内容，不是完整 `.page.html`，不压缩、不 Base64。完整页面、Raw、`content` 内部路径/错误状态以及凭据均不上传。

`v0.3.0` 团队 Article DTO 和路由是破坏性 API v2：所有端点使用 `/api/v2`，不请求或回退 `/api/v1`。升级必须先部署配套 `infohub-team-server`，再升级团队内全部桌面端；桌面自动更新不会升级自托管服务端。具体顺序见 [team-sharing.md](team-sharing.md#v030-破坏性升级)。

RSS `feedUrl` 额外拒绝 URL userinfo 和疑似凭据查询参数。它仍可保留普通查询参数，因为部分公开 Feed 依赖查询来选择格式或栏目。

## 新增信源

新增信源需要写一个 adapter 产出 `RawItem`，再在 process 层把该信源的 `raw` 映射成 `Article`（含 `ext`），并补契约测试。见 [ingest.md](ingest.md) 与 [process.md](process.md)。
