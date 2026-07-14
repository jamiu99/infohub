# 微信公众号 HTML 正文、内容类型与后续解析

> 上级：[overview.md](overview.md) · 采集层：[ingest.md](ingest.md) · 处理层：[process.md](process.md) · 数据接口：[data-interface.md](data-interface.md)

最后更新：2026-07-15。本文同时记录当前实现和后续页面类型；每节会明确标注，不能把 SSR/动态组件规划当成已完成能力。

## 1. 当前结论

infohub 不再要求 Markdown 独自还原微信公众号排版。经典 `#js_content` 图文页目前同时保存三份互补产物：

| 产物 | 位置 | 作用 | 是否团队同步 |
|---|---|---|---|
| Article Markdown | `articles/.../<articleId>.md` | 跨信源稳定文本、检索和阅读版 | 是 |
| 正文 HTML | `articles/.../<articleId>.content.html` | 保留 `#js_content` 外层、节点顺序和内联样式，直接展示原始排版 | 有内容时直接同步 |
| 完整页面 HTML | `raw/.../<sha256>.page.html` | 未改写的原页面，用于诊断和未来离线重解析 | 否 |

原文 URL 继续用于溯源和打开动态页面，但不能替代已经抓到的正文。所有 HTML/Markdown 都按 UTF-8 明文落盘，不做应用层压缩，不把 HTML 或图片转成 Base64。

看板在微信文章存在 `contentHtml` 时默认显示“原始排版”，也可切换到 Markdown“阅读版”。原始排版放进 iframe 是为了隔离公众号 CSS 和 App 布局；产品明确把官方 `mp.weixin.qq.com` 正文视为可信来源，不以 iframe 宣称额外恶意内容防线。静态快照不会主动运行微信页面脚本，因此依赖脚本的动态组件仍可能需要“打开原文”。

## 2. 已实现：经典图文页

### 2.1 获取与解析

`src/core/process/content.ts` 当前流程：

1. 用公开 `sourceUrl` 请求文章详情，不携带公众号后台 Cookie。
2. 保存 HTTP 200 返回的完整 HTML，不对它做任何改写。
3. 用 `parse5` 构建 HTML 树，按节点属性定位 `id="js_content"`，不再用正则寻找嵌套 `div` 终点。
4. 把正文根节点连同外层 `#js_content`、内联样式和未知微信元素序列化为展示 sidecar。
5. 只在展示 sidecar 中把 `data-src/data-original/data-backsrc` 提升为 `src`，处理 `data-srcset`，并把 `src/href/poster` 的相对地址补成绝对 URL。完整 `.page.html` 保持原样。
6. 从正文 HTML 生成轻量 Markdown 阅读投影。

树解析已经解决经典页面正文截断问题，但当前 HTML → Markdown 投影仍是轻量实现。原始 iframe 能保留未被 Markdown 支持的经典 DOM/样式；这不等于表格、音视频和微信自定义卡片已经被语义化。

### 2.2 正文状态与重试

Article frontmatter 新增：

```ts
interface ArticleContentState {
  status: 'complete' | 'partial' | 'failed'
  parserVersion: number
  contentHtmlPath?: string // 相对 articles/
  pageHtmlPath?: string    // 相对 raw/
  lastAttemptAt: number
  lastSuccessAt?: number
  error?: { code: string; message: string }
}
```

`seen_items` 只代表列表条目已经发现，不再代表正文完整。既有文章在以下任一情况会于后续手动刷新、且该条目再次出现在列表结果时重试：

- 没有 `content` 状态；
- 状态为 `failed/partial`；
- `parserVersion` 低于当前版本；
- `.content.html` 路径缺失或文件丢失；
- 微信条目的本机 `pageHtmlPath` 缺失或对应 `.page.html` 文件已丢失，包括先从团队取得正文 HTML、后来才由本机真实采集的文章。

新抓取失败不会用空值覆盖已有完整正文。请求已经返回页面但找不到正文节点时，仍保留完整 `.page.html` 和中文错误；网络超时、HTTP 失败与正文缺失也会记录可理解的错误描述。当前没有“一次性离线重跑所有历史页面”的独立命令。

### 2.3 读取与界面

- `article:list` 只返回轻量 Article/frontmatter，不在文章列表 IPC 中携带大段 HTML。
- `article:get` 返回 `ArticleDetail`，按 `contentHtmlPath` 从 `articles/` 根目录内读取 `contentHtml`。
- 微信详情有 HTML 时默认 iframe 原始排版，用户可切换 Markdown 阅读版。
- iframe 可滚动且限制正文宽度；图片、表格和代码区域在窄窗口可收缩/横向滚动。
- 动态微信组件、需要完整页面运行时的交互或鉴权媒体若不能从静态正文恢复，保留“打开原文”作为完整体验入口。

## 3. 页面形态：当前与后续

解析器至少要区分以下结果，不能只判断 HTTP 200：

| 页面形态 | 主要信号 | 当前行为 | 后续方向 |
|---|---|---|---|
| 经典图文页 | 存在 `#js_content` | **已实现**树定位、三份产物、原始排版/阅读版 | 扩展 Markdown 语义与 fixture |
| 新版 SSR 图片页 | `window.cgiDataNew`、`picture_page_info_list` 等 | 保存完整页面；无法形成完整正文 HTML | 安全读取已知结构化字段，生成统一内容 |
| 旧版 SSR 图片页 | `window.__QMTPL_SSR_DATA__`、旧图片列表 | 同上 | 兼容旧字段，输出同一内容模型 |
| 空正文或结构变化 | 无 `#js_content`、无已知 SSR 数据 | 标记 failed、保存完整返回页并允许重试 | 增加 variant/诊断和离线重放 |
| 风控、验证或异常页 | 访问异常、验证或频率限制提示 | 当前可因无正文进入 failed | 建 fixture 和专用中文分类，避免误判成功 |

SSR 数据位于页面 JavaScript 对象中。未来实现不得在 main 进程使用 `eval`、`Function` 或直接执行页面脚本；应只读取已知赋值，采用括号平衡扫描或安全 AST/数据解析，并对未知表达式失败关闭。

## 4. 内容类型清单

当前经典正文 HTML sidecar 会尽量原样保留这些节点；下表的“Markdown/结构化投影”大多仍是后续工作，不能据此宣称已完成专用支持。

| 内容类型 | 常见 HTML/数据表现 | 当前原始排版 | Markdown/结构化后续 |
|---|---|---|---|
| 段落/标题 | `p`、`section/div`、`h1`～`h6` | 保留 | 已覆盖常见形式，继续补嵌套语义 |
| 强调/链接/换行 | `strong/em/a/br` | 保留 | 已有轻量投影 |
| 引用/列表 | `blockquote/ul/ol/li` | 保留 | 引用/无序列表已有基础，有序/嵌套待完善 |
| 图片/图注 | `img data-src/src`、`figure` | 提升懒加载 URL 后保留 | 图片已有基础，alt/图注待完善 |
| 表格 | `table/thead/tbody/tr/th/td` | HTML 样式可保留，窄窗允许滚动 | GFM 表格或可读文本退化待实现 |
| 代码 | `pre/code` 或等价容器 | 保留 | 围栏代码与语言信息待实现 |
| 视频 | `video/iframe`、微信自定义元素 | 静态节点/封面尽量保留，播放不保证 | 标题、封面、播放/原文链接待归一化 |
| 音频/音乐 | `mpvoice/qqmusic` 等 | 静态节点尽量保留 | 标题、作者、时长、链接待归一化 |
| 视频号/小程序/文章卡片 | 微信自定义卡片 | DOM/样式尽量保留，交互不保证 | 统一 card 类型与可见占位待实现 |
| SVG/Canvas/互动排版 | 依赖脚本或运行时数据 | 静态快照可能不完整 | 保留可见文字/图片并提示打开原文 |
| 未知组件 | 未识别的 `mp-*` 或新节点 | 经典正文中不主动删除 | 未来输出明确 `unsupported` 诊断，不静默丢弃 |

图片 URL 继续优先 `data-src`，再看 `data-original/data-backsrc`，最后回退 `src`；查询参数可能决定尺寸或格式，不应随意删除。正文块不能仅凭相同 URL/文本做全文去重，以免删掉作者有意重复的内容。

## 5. 后续中间内容模型

为了让 SSR、Markdown 和质量诊断共享同一语义，后续可在解析阶段引入有序中间模型；它不是当前稳定文件契约：

```ts
interface WechatDocument {
  variant: 'classic' | 'ssr-new' | 'ssr-legacy' | 'unknown'
  parserVersion: number
  status: 'complete' | 'partial' | 'failed'
  blocks: WechatBlock[]
  diagnostics: { unsupportedCount: number; warnings: string[] }
}

type WechatBlock =
  | { kind: 'paragraph'; text: string }
  | { kind: 'heading'; level: 1 | 2 | 3 | 4 | 5 | 6; text: string }
  | { kind: 'blockquote'; blocks: WechatBlock[] }
  | { kind: 'list'; ordered: boolean; items: WechatBlock[][] }
  | { kind: 'image'; sourceUrl: string; alt?: string; caption?: string }
  | { kind: 'table'; rows: string[][] }
  | { kind: 'code'; text: string; language?: string }
  | { kind: 'video' | 'audio' | 'card'; title?: string; sourceUrl?: string }
  | { kind: 'unsupported'; sourceTag: string; text?: string; sourceUrl?: string }
```

先用真实最小 fixture 验证字段，再决定是否落盘。不要把微信临时 DOM 属性直接固化成长期 Article 字段。

## 6. NewsCrawler 调研与复用边界

2026-07-14 只读审阅了 `refs/NewsCrawler`（当时 HEAD：`7495d2f`）：

- `news_crawler/wechat_news/wechat_news.py`：公众号页面获取、普通 DOM 与 SSR 页面解析。
- `news_crawler/core/models.py`：有序 `text/image/video` 内容模型。
- `news_extractor_core/services/image_service.py`：图片下载、类型识别和大小限制。
- `news_extractor_core/services/formatter.py`：结构化内容到 Markdown。
- `news_extractor_backend/api/proxy.py`：微信图片代理。

可借鉴的是获取/解析/格式化/资源分层、普通 DOM + SSR 双路径、有序内容和图片请求的超时/MIME/大小处理。infohub 已按自己的 TypeScript 架构独立实现经典 DOM 树解析，不运行 Python sidecar，也没有复制参考源码。

`refs/NewsCrawler/LICENSE` 是 GPLv3，README 另有“禁止商业用途”表述。工程边界因此是：不复制、翻译或机械改写源码，不作为运行时库分发，只把页面形态、输入输出行为和失败模式作为研究信息；fixture 自行构造或最小化。这是工程上的许可证隔离，不替代法律意见。

参考实现中的硬编码 Cookie、任意 URL 图片代理、宽泛字符串替换后解析脚本对象、`src` 优先于 `data-src`、全文全局去重和静默忽略未知节点均不复用。

## 7. 团队同步与资源策略

团队同步不能退化为只发 URL。当前协议同步 Markdown + 正文 HTML + 原文 URL：

- Article 有正文 HTML 时直接发送 `contentHtml`；RSS 或正文获取失败的 Article 可以没有该字段。
- 客户端 pull 到 HTML 后写入本机 `.content.html`，列表仍不内联大段内容。
- 完整 `.page.html`、Raw、Cookie、后台 token、fingerprint、浏览器 session 和本地路径/诊断不上传。

`v0.3.0` 不做能力协商或旧协议降级，旧桌面端、旧服务端和混合版本均不受支持。自托管团队应暂停旧客户端同步，先升级服务端，再升级全部桌面端，最后恢复同步。桌面自动更新不能替代服务端升级。

当前不下载和团队同步图片二进制。若以后做本地资源归档，应按 SHA-256 内容寻址、用 manifest 记录原 URL/MIME/大小，并独立设计团队资源去重；二进制不要塞进 Article JSON/Markdown，也不要转 Base64。HTTP 层可透明使用 gzip/Brotli，但不改变明文本地文件契约。

## 8. 展示与信任边界

- 官方 `mp.weixin.qq.com` 正文 HTML 按产品决定直接呈现；iframe 主要隔离 CSS、尺寸与滚动。
- 完整页面 HTML 是本机 Raw 资料，不直接作为 App 顶层页面加载；详情使用提取后的 `#js_content` sidecar。
- 页面脚本不作为静态正文的一部分主动执行，所以复杂交互不保证恢复。
- RSS 和 Markdown 原有的文本转义、HTTP(S) URL 白名单、DOMPurify、CSP、sandbox 与 main 外链 scheme 校验继续保留，不因微信信任决定删除。
- 公众号后台 Cookie 只用于搜索/文章列表；公开详情页不携带它。

## 9. 后续顺序与验收

1. 为经典嵌套图文、正文缺失、超时和 lazy image 固化 fixture；持续保证完整页面不改写。
2. 建新旧 SSR 图片页与风控/验证页 fixture，增加安全的 SSR 结构读取和明确 variant。
3. 引入并验证有序内容模型，扩展表格、代码、音视频、卡片和 `unsupported` 的 Markdown 投影。
4. 提供“从已有 `.page.html` 批量重新解析”的正式入口，不依赖上游列表再次返回旧文章。
5. 再评估本地媒体归档/manifest；最后才讨论团队二进制资源同步。

验收至少覆盖：

- 深层嵌套 `#js_content` 不截断，外层 ID/内联样式保留。
- `data-src` 图片能在 iframe 展示，相对 URL 已补全，完整页面字节内容未被展示改写污染。
- `article:list` 不带 HTML，`article:get` 才读取 sidecar。
- 失败、旧 parserVersion、正文 sidecar 丢失或本机完整页面缺失会重试，且失败不覆盖已有完整正文。
- 默认原始排版与阅读版切换正常，长文可滚动。
- 配套团队服务端先升级后，两台 v0.3.0 桌面端可互相取得正文 HTML；完整页面与凭据不进入同步。
- SSR/动态组件不能恢复时明确降级，并保留“打开原文”。
