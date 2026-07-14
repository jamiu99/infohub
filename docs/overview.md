# infohub — 总览与进度

> 本文件是唯一进度入口。模块文档解释实现，这里只维护产品边界、可验证状态、风险和下一步。

最后更新：**2026-07-15** · 阶段：**v0.3.0 发布准备：微信公众号经典图文三份归档已实现，团队协议破坏性升级**

## 1. 最终产品决定

infohub 是一个**本地数据获取与索引工具**，也是一个快速看板。

它负责：

- 从微信公众号、RSS/Atom 等信源获取数据。
- 保留 Raw 原始载荷，归一化为稳定 Article 文件。
- 用 SQLite 建立可重建的查询、状态与去重索引。
- 让用户快速浏览、筛选、标记和归档。
- 通过明确的文件系统契约，让任何外部工具直接读取数据。

它不负责：

- 调用模型 API 或本地模型。
- 启动 Claude Code、Codex 或其他 AI CLI。
- 安装 Skill、插件或 Agent 工作流。
- 生成摘要、简报、embedding、知识库或 RAG。
- 在 App 内判断“信息价值”。

AI 可以是数据消费者，但与普通脚本、搜索程序没有产品层区别。唯一集成面是 [data-interface.md](data-interface.md) 定义的文件和索引，不是模型协议。

## 2. 当前基线

| 项目 | 当前事实 |
|------|----------|
| 仓库 | `jamiu99/infohub`，GitHub Public，默认分支 `main` |
| 当前源码版本 | `v0.3.0`（待发布） |
| 上个正式版本 | `v0.2.1`（2026-07-13）；`v0.1.2` 已撤回 |
| 自动检查 | `pnpm typecheck` ✅ · `pnpm test:core` ✅（80/80）· `pnpm build` ✅ |
| 桌面桥接 | bundle contract ✅ · Electron preload/IPC 与 CSP `srcdoc` iframe smoke test ✅ |
| 依赖审计 | `pnpm audit --prod` ✅，未发现已知生产依赖漏洞 |
| CI | `main`/PR 运行 `verify.sh`；tag Release 在 Windows 重跑完整门禁并校验版本 |
| 团队后端 | 独立 `infohub-team-server` MVP ✅；默认公网 HTTPS 健康入口已上线 |
| 默认团队入口 | `https://home.agent-wiki.cn:18038/healthz` 于 2026-07-13 验证返回健康状态与实例 ID |

当前定位：**个人采集链路、经典微信图文 HTML 归档/原始排版、团队共享 MVP 和默认 HTTPS 健康入口均已进入可运行基线；SSR/动态微信内容、服务运维、多设备同步和真实 Windows 产品验收尚未闭环。**

## 3. 数据流

```text
微信公众号 / RSS
        │
        ▼
SourceAdapter.fetch() ──▶ RawItem JSON（列表原始载荷）
        │
        ▼
Normalizer + enrichContent
        │
        ├──▶ Article Markdown（稳定文本）
        ├──▶ .content.html（微信原始排版）
        └──▶ raw/*.page.html（未改写完整页面）
        │
        ├──────────────▶ index.sqlite（派生索引）
        │
        ├──────────────▶ Vue 看板（快速浏览）
        ├─ outbox（含正文 HTML）─HTTPS─▶ 团队服务 ─cursor─▶ 其他成员 Article/HTML 文件
        │
        └──────────────▶ 外部只读消费者（脚本 / 搜索工具 / AI）
```

App 每次启动会在数据根目录生成 `INFOHUB_DATA.md`，让消费者不依赖项目源码也能理解目录和稳定字段。

## 4. 已实现

### 获取与处理

- ✅ 微信公众号官方页面扫码登录，每个账号独立 `persist:` 分区。
- ✅ 自动切换到传统二维码；不要求账号密码，登录窗口权限和导航已收口。
- ✅ 多账号池、可持久化的小时配额、冷却/失效状态和重新登录。
- ✅ `searchbiz` 搜号、`appmsg` 拉文章；默认 20 请求/账号/小时，可在设置中配置，一次 1 页。
- ✅ 测试期逐账号展示本小时/累计请求，并记录最近一次 `200013` 的请求序号和时间。
- ✅ 全局串行锁、无自动轮询，只允许用户主动刷新。
- ✅ RSS/Atom URL 试探、解析、超时重试和归一化。
- ✅ Adapter + normalizer 注册表，新信源边界清晰。
- ✅ 微信经典图文用 `parse5` 树定位 `#js_content`，不再用正则决定嵌套正文边界。
- ✅ 同时保存 Article Markdown、同名 `.content.html` 正文 sidecar 和 SHA-256 命名的未改写完整 `.page.html`。
- ✅ Article 持久化正文状态/解析器版本/路径/尝试与成功时间/中文错误；失败、正文 sidecar/本机完整页面路径或文件缺失、以及旧版本在后续手动刷新中重试。
- ✅ `article:list` 保持轻量，`article:get` 才按需读取正文 HTML。
- ✅ 完成 NewsCrawler 公众号实现的只读调研，明确经典 DOM/新旧 SSR 页面、内容类型、独立实现和资源策略；详见 [wechat-content.md](wechat-content.md)。

### 文件、索引与看板

- ✅ Raw JSON、Article Markdown、`sources.json` 和 SQLite 索引。
- ✅ schema v2：`externalId` 入文件、旧状态迁移、原子写、路径防逃逸。
- ✅ 启动时完整重建 `articles/seen_items`，运行中同步外部文件变化。
- ✅ 三栏 Vue 看板：信源、文章流、正文、筛选和添加公众号/RSS。
- ✅ 微信详情默认 iframe 原始排版，可切换 Markdown 阅读版；长文和媒体在详情栏内滚动/收缩。
- ✅ 三栏可拖动调宽、独立隐藏并持久化；全局工具栏保证栏目隐藏后仍可恢复。
- ✅ 账号/配额、团队、阅读界面和更新集中到独立设置弹窗，主阅读界面不再堆叠管理面板。
- ✅ 用户可见异常统一转换为清晰中文；超时、断网、拒绝连接、DNS、证书和常见 HTTP 状态提供对应处理建议。
- ✅ 未读、归档、按源清理和最多 500 条倒序列表。
- ✅ 自动生成 `INFOHUB_DATA.md` 数据说明。

### 团队共享

- ✅ 独立、自托管 `infohub-team-server`：单实例单团队，默认端口 `18038`。
- ✅ 共享 `TEAM_TOKEN` 只用于首次入组；设备 token 由服务端生成并由客户端安全保存。
- ✅ 本地成功落盘后进入可靠文件 outbox；断网保留并自动重试，首次加入补传既有本机文章。
- ✅ 确定性事件 + ack 标记让历史补传可在崩溃/重启后恢复，不会每次重复上传。
- ✅ 本地预检并隔离超限/非法事件；push 按实际 UTF-8 JSON 控制在 12 MiB，服务端永久拒绝时二分定位坏项，其余队列继续同步。
- ✅ Source/Article 服务端 canonical 去重、设备 contribution 和 cursor 增量同步。
- ✅ 团队文章仍落成普通 Markdown；Article 有正文 HTML 时直接同步并在接收端写入 sidecar。
- ✅ `v0.3.0` 硬切 `/api/v2`，不做能力协商或 v1 fallback；先 status 再 push，旧服务 404 时保留 outbox；部署顺序固定为先服务端、后全部桌面端。
- ✅ 完整页面 HTML、Raw 和凭据不上传；正文 HTML/Markdown 不做应用层压缩、不使用 Base64。
- ✅ 阅读/归档是本机状态，修改不推进内容 `updatedAt`、pull 不覆盖；本机已有完整正文/排版优先保留。
- ✅ 取消本地订阅只删除纯本地文章，已同步团队副本和本机阅读/归档状态保留。
- ✅ 看板支持“我的 / 团队”，纯团队文章后来被本机采到时会补记本机贡献。
- ✅ 服务端提供设备、来源分配、轮询均分和短租约 API。
- ✅ 上传 DTO 与服务端双重 allowlist；Raw、Cookie、token、fingerprint、partition/session 不上传。
- ✅ 私有 RSS URL 的内嵌账号密码和疑似凭据查询参数不会进入团队 outbox；设备 token 无安全存储时拒绝落明文。

### 展示边界与发布

- ✅ 官方 `mp.weixin.qq.com` 正文 HTML 按产品决定视为可信，在 iframe 中做 CSS/布局隔离；动态组件可打开原文。
- ✅ RSS 与 Markdown 阅读版继续使用文本转义、绝对 http(s) URL 白名单、DOMPurify allowlist 和 CSP。
- ✅ renderer sandbox + contextIsolation + preload IPC 白名单。
- ✅ preload 输出为 sandbox 兼容的单文件 CJS；真实 Electron smoke test 验证 `window.api` 与 IPC。
- ✅ Windows NSIS Release 与 `electron-updater`。
- ✅ 原生“检查更新 → 确认下载 → 进度 → 确认重启”流程，菜单和设置弹窗均可手动检查。
- ✅ 项目 `verify.sh`、`main`/PR CI 与 Windows Release 完整门禁。

## 5. 已移除并禁止回归

- ✅ 删除内置 `summarize` / `briefing` Skills 和打包资源。
- ✅ 删除实验性 Claude CLI 驱动、Agent 类型和对应测试。
- ✅ 删除 App 启动时的 Skill 安装逻辑。
- ✅ 采集调度从 `src/core/agent/` 迁到 `src/core/collect/`。
- ✅ 新采集 Article 不再写 `summary/score/tags` 等空占位；旧值只做兼容保留。

升级前用户目录里已有的 `.claude/skills/`、`briefings/` 或旧 README 不会被自动删除，以避免破坏用户文件；infohub 已完全忽略它们。

## 6. 尚未闭环

### P0 — 凭据安全

- ⬜ 无 OS keychain 时账号池仍静默明文落盘；公开分发前需告警、格式版本和迁移/恢复策略。

### P1 — 稳定性与验收

- ⬜ 人工验收扫码、公众号/RSS 添加、刷新、阅读、归档、重登。
- ⬜ 验证 sandbox preload、CSP 下公众号图片和系统外链。
- ⬜ 用真实经典图文验收默认原始排版、阅读版切换、长文滚动、懒加载图片和样式隔离。
- ⬜ 后台采集错误缺少明确 UI 反馈；quota waiting 状态只有占位。
- ⬜ 修复 `probe-add.mts` / `probe-pipeline.mts` 并纳入 typecheck。
- ⬜ 在 Windows 人工安装 `v0.3.0`，验收二维码、配额、RSS、原始排版/阅读版、归档、三栏布局、团队加入和“我的 / 团队”。
- ⬜ 在团队服务端先升级后，从已安装的 `v0.2.1` 按确认式流程更新到 `v0.3.0`，确认重启安装、设置、布局、账号数据和 HTML sidecar 保留。
- ⬜ 用两台真实设备验证首次历史补传、断网重试、重复文章 contribution 和退出/重加入。

### P2A — 数据工具能力

- ⬜ SQLite FTS5 全文索引与搜索 UI。
- ⬜ 正式 `rebuild-index`、数据导出和数据目录打开入口。
- ⬜ 来源/日期/状态组合筛选和采集结果统计。
- ⬜ 按 [wechat-content.md](wechat-content.md) 实现新旧 SSR 图片页、风控/验证页、表格/音视频/卡片语义投影和有序内容模型。
- ⬜ 增加从已有 `.page.html` 批量离线重解析的正式入口；当前重试需条目再次出现在手动刷新结果中。
- ⬜ 更多 SourceAdapter；不加入模型、embedding 或向量服务。

### P2B — 团队共享后续

- ⬜ 为默认 `https://home.agent-wiki.cn:18038` 补齐进程守护、数据目录备份和外部健康监控；HTTPS `/healthz` 已可用。
- ⬜ 在桌面端展示团队 Source、负责人和设备，并提供“刷新我的任务”入口。
- ⬜ 桌面采集前接入短租约，完成后回报结果；当前 assignment/lease 只在服务端 API 可用。
- ⬜ 增加已隔离事件的详情、删除/修复后重试界面，以及设备撤销入口。

### P3 — 极低优先级安全增强

- ⬜ 在可信成员假设不再成立时，再评估细粒度权限、限时邀请、审计、复杂撤销和端到端加密。

## 7. 推荐顺序

1. 为已上线的默认团队服务补进程守护、备份和外部健康监控。
2. 先升级配套团队服务端，再用两台 Windows 设备完成 v0.2.1 → v0.3.0 更新与团队 HTML 同步验收。
3. 接入桌面采集任务分配/租约，再修 probe、错误反馈与凭据告警。
4. 为微信 SSR/异常页建立 fixture 和专用解析，补离线批量重放入口。
5. 实现 FTS5、搜索与正式数据维护命令，再扩展更多纯数据 SourceAdapter。

## 8. 文档地图

| 文档 | 内容 |
|------|------|
| [data-interface.md](data-interface.md) | 文件、SQLite、稳定字段和消费者约定 |
| [architecture.md](architecture.md) | 进程模型、模块边界、数据流 |
| [contract.md](contract.md) | Source / RawItem / Article / DiscoverResult |
| [ingest.md](ingest.md) | Adapter、公众号接口、RSS |
| [process.md](process.md) | 归一化与正文处理 |
| [wechat-content.md](wechat-content.md) | 微信 HTML 已实现基线、SSR/动态内容、NewsCrawler 调研与资源策略 |
| [storage.md](storage.md) | 文件布局、schema v3、迁移和重建 |
| [wechat-monitor.md](wechat-monitor.md) | 看板产品形态和手动采集 |
| [wechat-login.md](wechat-login.md) | 扫码、账号池和限流 |
| [team-sharing.md](team-sharing.md) | 自托管团队同步、去重、入组与采集分配 |
| [release.md](release.md) | Windows 发布与自动更新 |
| [dev-log.md](dev-log.md) | 代码地图、验证与问题清单 |
| [decisions.md](decisions.md) | ADR 决策日志 |

## 9. 不可妥协约束

- Article Markdown 与其声明的内容 sidecar 是真相源，SQLite 是派生索引。
- SQLite 只用 Node 内置 `node:sqlite`；JavaScript 只用 pnpm。
- renderer 不直接访问文件、SQLite、凭据或采集网络。
- 默认手动采集、全局串行、保守限流。
- 团队网络不可用不得阻塞或回滚本地落盘；只允许 HTTPS 和 allowlist DTO。
- 不直接集成任何 AI 能力；外部消费者只依赖数据接口。
