# 采集层（ingest）

> 上级：[overview.md](overview.md) · 契约见 [contract.md](contract.md) · 公众号登录见 [wechat-login.md](wechat-login.md) · 公众号正文见 [wechat-content.md](wechat-content.md)

职责：从各信源拿到**原始数据**，产出 `RawItem[]`。**只负责取，不清洗、不入正式库**。

## adapter 接口（已实现 `src/core/ingest/adapter.ts`）

每种信源 = 一个 adapter，实现同一接口。**加新信源 = 加一个 adapter + 一个 normalizer，collector/store 都不动。**

```ts
interface SourceAdapter {
  readonly type: string                      // 'wechat' | 'rss' | ...
  discover?(query: string): Promise<DiscoverResult[]>       // 搜索/试探信源
  fetch(source: Source, opts?: { maxPages?: number }): Promise<FetchOutcome>  // 拉原始条目
  readiness?(): { ready: boolean; reason?: string }         // 采集前就绪检查（如 wechat 无账号）
  contentParserVersion?: number
  parseContentPage?(pageHtml: string, sourceUrl: string): EnrichedArticleContent
  enrichContent?(sourceUrl: string): Promise<{
    body: string                    // Markdown 阅读投影
    contentHtml?: string            // 可直接展示的正文 HTML
    pageHtml?: string               // 未改写的完整页面
    status: 'complete' | 'partial' | 'failed'
    parserVersion: number
    error?: { code: string; message: string }
  }>
}
```

**关键设计**：信源专属复杂度**封装在各自 adapter 内**——
- `WechatAdapter` 内部持有账号池 + 限流 + 换号重试（`src/core/ingest/wechat-adapter.ts`）；
- `RssAdapter` 公开抓取、无鉴权（`src/core/ingest/rss-adapter.ts`）。

`Collector`（`src/core/collect/collector.ts`）只面向此接口：`AdapterRegistry.get(type)` 取 adapter →
`fetch` → 条目去重 → `getNormalizer(type)` 归一化 → `enrichContent` 补正文/页面产物 → 存库。全局串行锁保护。正文补全只有结构化 `enrichContent` 一条路径，不保留旧 adapter 分支。

归一化按 type 注册（`src/core/process/normalize.ts`）：`normalizeWechat` / `normalizeRss` 各自 `registerNormalizer`。

新信源接入清单：① 写 `XxxAdapter implements SourceAdapter` ② 写 `normalizeXxx` 并 `registerNormalizer('xxx', …)` ③ service 里 `registry.register(new XxxAdapter())`。三步，其余不动。

## 微信公众号

复用 `refs/get_wechat_list` 的**核心接口逻辑**（那仓代码烂，只取这两个 GET）。鉴权三要素来自账号池，见 [wechat-login.md](wechat-login.md)。

### 接口 1：搜公众号 → fakeid（`discover`）

```
GET https://mp.weixin.qq.com/cgi-bin/searchbiz
query: action=search_biz & query=<名称> & begin=0 & count=5
       & token=<token> & fingerprint=<fp> & lang=zh_CN & f=json & ajax=1
cookie: <账号 cookie>
→ list[].{ fakeid, nickname, alias, signature }
```

### 接口 2：拉文章列表（`fetch`）

```
GET https://mp.weixin.qq.com/cgi-bin/appmsg
query: action=list_ex & fakeid=<fakeid> & begin=<n> & count=10 & type=9
       & need_author_name=1 & token=<token> & fingerprint=<fp> & f=json & ajax=1
cookie: <账号 cookie>
→ app_msg_cnt, app_msg_list[].{ aid, title, digest, link, cover,
                                author_name, create_time, update_time, ... }
```

映射到 `RawItem`：`externalId` 优先使用稳定 `aid`，否则由文章 URL 的 `__biz + mid + idx` 生成 canonical key；不把易变化的 `chksm/scene` 等完整查询串当去重身份。`raw = app_msg_list` 项整包。
分页：`begin += count` 循环，命中错误码 `200013` 即限流（见 [wechat-login.md](wechat-login.md#四多账号与限流)）。
每次请求间隔 sleep，翻页受 `maxPages` 限制。

### wechat adapter config

`Source.config` 里存：`{ fakeid: string, alias?: string, signature?: string }`（由 discover 得到）。账号不绑定到 Source；`WechatAdapter` 持有共享 `AccountPool` 引用并在每次请求前选择账号。

当前默认只拉 1 页 × 10 条。手动和用户显式开启的定时采集都经过批次互斥与 Collector 全局串行锁；不同信源的认证请求还共用 10 秒全局请求门，换号重试至少等待 15 秒。实际保护参数见 [wechat-login.md](wechat-login.md#四多账号与限流)。

文章列表接口只提供摘要和原文链接；详情页正文属于 `enrichContent` 阶段。当前经典图文页已用 `parse5` 构建 HTML 树并定位 `#js_content`，同时返回：

- Markdown `body`；
- 保留外层正文节点/内联样式、提升 `data-src` 并补全相对 URL 的 `contentHtml`；
- 未改写的完整 `pageHtml`；
- `status/parserVersion/error` 生命周期信息。

`parseContentPage` 使用本机页面快照做同一套纯解析，不执行脚本也不发网络请求。联网正文请求不携带公众号后台 Cookie，并经过 2 秒全局公开页面请求门。当前已支持 `picture_page_info_list` 图片消息；旧 SSR 和依赖页面脚本的动态内容仍需降级，页面形态和后续顺序记录在 [wechat-content.md](wechat-content.md)。

## RSS（已实现）

标准 RSS/Atom：给定 `feedUrl`，拉取解析每个 entry → `RawItem`（`externalId = guid || link`，`raw = entry`）。
- 解析：`src/core/ingest/rss.ts`（无三方依赖，正则解析 RSS `<item>` 与 Atom `<entry>`，含 CDATA/实体解码）。
- adapter：`src/core/ingest/rss-adapter.ts`。`discover(url)` = 试探一个 feed URL 返回站点作候选（不接受非 URL）。
- 归一化：`normalizeRss` 用 entry 的 `content:encoded`/`content`/`summary` 作正文（HTML→markdown），无需 `enrichContent`。
- 无鉴权、无限流。`Source.config = { feedUrl }`。
- **已用真实 feed（Hacker News）端到端验证**：discover→fetch 20 条→归一化出标题/正文/时间。
- RSS 与微信目前共用 Collector 全局串行锁；这是安全优先的简单实现，不代表 RSS 本身有配额限制。

## 新增信源

接入新信源的固定步骤：实现 `SourceAdapter`、实现并注册 normalizer、在 Service 注册 adapter、补 discover/fetch/normalize/去重测试。生成代码使用什么开发工具不属于 infohub 产品能力；运行时绝不加载或执行外部生成代码。
