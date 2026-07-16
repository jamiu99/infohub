# infohub — 总览与进度

> 本文件是唯一进度入口。模块文档解释实现，这里只维护产品边界、可验证状态、风险和下一步。

最后更新：**2026-07-17** · 阶段：**v0.6.0 阅读性能与设备偏好发布基线**

## 1. 最终产品决定

infohub 是一个**本地数据获取与索引工具**，也是一个快速看板。

它负责：

- 从微信公众号、RSS/Atom 等信源获取数据。
- 按内容寻址保留不可变 Raw 抓取快照，归一化为 infohub 管理的 Article 投影。
- 用 SQLite 建立可重建的查询、状态与去重索引。
- 让用户快速浏览、筛选、标记和归档。
- 通过明确的文件系统契约，让任何外部工具直接读取数据。

它不负责：

- 调用模型 API 或本地模型。
- 启动 Claude Code、Codex 或其他 AI CLI。
- 安装 Skill、插件或 Agent 工作流。
- 生成摘要、简报、embedding、知识库或 RAG。
- 在 App 内判断“信息价值”。

AI 可以是数据消费者，但与普通脚本、搜索程序没有产品层区别。它只读 infohub 管理的 `articles/`，派生结果写入 `outputs/<producer>/`；不得修改 `articles/` 或不可变 `raw/`。唯一集成面是 [data-interface.md](data-interface.md) 定义的文件，不是模型协议。

## 2. 当前基线

| 项目 | 当前事实 |
|------|----------|
| 仓库 | `jamiu99/infohub`，GitHub Public，默认分支 `main` |
| 当前源码版本 | `v0.6.0` |
| 上个正式版本 | `v0.5.0`（2026-07-15）；`v0.1.2` 已撤回 |
| 当前开发门禁 | `pnpm typecheck` ✅ · `pnpm test:core` ✅（166/166）· `pnpm build`/bundle contract ✅ · desktop smoke ✅ |
| 桌面桥接 | Electron preload/账号/自动采集/资料库 IPC、CSP `srcdoc` iframe 与更新菜单 smoke test ✅ |
| 依赖审计 | npm registry 审计端点于 2026-07-15 返回 410；仓库 Dependabot 未启用，本次不作“无已知漏洞”结论 |
| CI | `main`/PR 运行 `verify.sh`；tag Release 在 Windows 重跑完整门禁并校验版本 |
| 团队后端 | 独立 `infohub-team-server` MVP ✅；默认公网 HTTPS 健康入口已上线 |
| 默认团队入口 | `https://home.agent-wiki.cn:18038/healthz` 于 2026-07-13 验证返回健康状态与实例 ID |

当前定位：**v0.6.0 完成阅读列表热路径优化、白色/暗色主题、跨文章阅读习惯、来源设置简化、系统浏览器外链和可配置团队同步周期。未入库历史回溯、旧 SSR、服务运维、多设备同步和真实 Windows 产品验收尚未闭环。**

## 3. 数据流

```text
微信公众号 / RSS
        │
        ▼
SourceAdapter.fetch() ──▶ RawItem JSON（内容寻址、不可变）
        │
        ▼
Normalizer + enrichContent
        │
        ├──▶ Article Markdown（稳定文本）
        ├──▶ .content.html（微信原始排版）
        └──▶ raw/*/<content-sha>.page.html（未改写、不可变）
        │
        ├──────────────▶ index.sqlite（派生索引）
        │
        ├──────────────▶ Vue 看板（快速浏览）
        ├─ outbox（含正文 HTML）─HTTPS─▶ 团队服务 ─cursor─▶ 其他成员 Article/HTML 文件
        │
        └──────────────▶ 外部只读消费者（脚本 / 搜索工具 / AI）
                                  └──▶ outputs/<producer>/（外部拥有）
```

App 每次启动会在数据根目录生成 `INFOHUB_DATA.md`，让消费者不依赖项目源码也能理解目录和稳定字段。

## 4. 已实现

### 获取与处理

- ✅ 微信公众号官方页面扫码登录，每个账号独立 `persist:` 分区。
- ✅ 自动切换到传统二维码；不要求账号密码，登录窗口权限和导航已收口。
- ✅ 多账号池、可持久化的小时配额、冷却/失效状态和重新登录。
- ✅ `searchbiz` 搜号、`appmsg` 拉文章；默认 20 请求/账号/小时，可在设置中配置，一次 1 页。
- ✅ 测试期逐账号展示本小时/累计请求，并记录最近一次 `200013` 的请求序号和时间。
- ✅ Collector 全局串行锁、跨来源微信后台请求门与账号小时配额。
- ✅ 自动采集默认关闭、周期 1 小时～7 天（推荐 4 小时）；Service/设置已接通，错过轮次不追赶，休眠恢复后重新等待完整周期。
- ✅ RSS/Atom URL 试探、解析、超时重试和归一化。
- ✅ Adapter + normalizer 注册表，新信源边界清晰。
- ✅ 微信经典图文用 `parse5` 树定位 `#js_content`，不再用正则决定嵌套正文边界。
- ✅ parser v2 支持 `item_show_type=8` 图片消息：安全读取 `window.cgiDataNew.picture_page_info_list` / 静态 `window.picture_page_info_list` 的正文图片和图注，不执行脚本、不误收 watermark/分享封面。
- ✅ 同时保存 Article Markdown、内容寻址的版本化正文 sidecar 和按响应内容 SHA-256 命名的未改写 `.page.html`；不同页面响应永久并存。
- ✅ Article 持久化正文状态/解析器版本/成功页面、最近尝试页面、尝试与成功时间和中文错误；失败不覆盖已有完整正文。
- ✅ 离线重新解析与网络重新抓取明确分离：前者只读已有快照，后者追加新响应；支持单篇、当前来源和全部本机历史文章。
- ✅ “拉取最新”与“处理已入库历史”在产品语义上完全分开：前者只读来源当前列表且公众号默认一页，后者不发现从未入库的旧文章。
- ✅ `article:list` 只从 SQLite 返回标题/来源/时间/状态摘要；`article:get` 读取单篇 Markdown，公众号 HTML 由独立 IPC 在切换原始排版时才读取。
- ✅ 完成 NewsCrawler 公众号实现的只读调研，明确经典 DOM/新旧 SSR 页面、内容类型、独立实现和资源策略；详见 [wechat-content.md](wechat-content.md)。

### 文件、索引与看板

- ✅ Raw JSON 与页面按内容寻址、只创建不覆盖；Article 是 infohub 管理的规范化投影，SQLite 是可重建索引。
- ✅ 数据资料库可在设置中选择空目录迁移；应用安全重启后在目标盘 staging 复制并做 SHA-256 校验，全部通过才切换，原目录始终保留。
- ✅ 内容资料库与固定私有状态分离；旧 `settings.json`、`secrets/`、`team/` 首次升级只复制不删除，账号/团队凭据和 Chromium 分区不随资料库迁移。
- ✅ 外部 AI/Agent 的写入边界固定为 `outputs/<producer>/`，不得修改 `articles/`/`raw/`；infohub 不回灌外部处理结果。
- ✅ schema v2：`externalId` 入文件、旧状态迁移、原子写、路径防逃逸。
- ✅ SQLite 正常读路径不再扫描 Markdown；首次建库、索引投影升级或检测到上次写入中断时才从 Article 文件重建 `articles/seen_items`，并保留显式重建能力。
- ✅ 白色/暗色双主题、扁平化三栏 Vue 看板：信源、文章流、正文、筛选和添加公众号/RSS。
- ✅ 微信详情支持 Markdown 沉浸阅读和 iframe 原始排版；选择会作为本机全局习惯跨文章保留，无 HTML 的文章只临时回退。
- ✅ 三栏可拖动调宽、独立隐藏并持久化；全局工具栏保证栏目隐藏后仍可恢复。
- ✅ 独立“来源与抓取”设置页将“检查新文章”和“修复已保存文章”作为两个独立动作；单源与全量维护分别折叠，删除影响明确展示。
- ✅ 账号/配额、自动采集、数据资料库、团队、阅读界面和更新集中到设置，主阅读界面不堆叠低频管理面板。
- ✅ 用户可见异常统一转换为清晰中文；超时、断网、拒绝连接、DNS、证书和常见 HTTP 状态提供对应处理建议。
- ✅ 未读、归档、按源清理和最多 500 条倒序列表；当前来源/阅读范围支持一键全部已读，后台不受列表 500 条上限影响。
- ✅ 自动生成 `INFOHUB_DATA.md` 数据说明。

### 团队共享

- ✅ 独立、自托管 `infohub-team-server`：单实例单团队，默认端口 `18038`。
- ✅ 共享 `TEAM_TOKEN` 只用于首次入组；设备 token 由服务端生成并由客户端安全保存。
- ✅ 本地成功落盘后进入可靠文件 outbox；断网保留并自动重试，首次加入补传既有本机文章。
- ✅ 团队自动同步可独立关闭或设置 1～1440 分钟周期（推荐 5 分钟）；关闭只暂停定时网络请求，outbox 与“立即同步”继续工作。
- ✅ 确定性事件 + ack 标记让历史补传可在崩溃/重启后恢复，不会每次重复上传。
- ✅ 本地预检并隔离超限/非法事件；push 按实际 UTF-8 JSON 控制在 12 MiB，服务端永久拒绝时二分定位坏项，其余队列继续同步。
- ✅ Source/Article 服务端 canonical 去重、设备 contribution 和 cursor 增量同步。
- ✅ 团队文章仍落成普通 Markdown；Article 有正文 HTML 时直接同步并在接收端写入 sidecar。
- ✅ `v0.3.0` 硬切 `/api/v2`，不做能力协商或 v1 fallback；先 status 再 push，旧服务 404 时保留 outbox；部署顺序固定为先服务端、后全部桌面端。
- ✅ `v0.3.1` 将仓库内项目 logo 接入 electron-builder，统一 Windows EXE、快捷方式和 NSIS 安装/卸载图标，并加入构建门禁防止退回 Electron 默认图标。
- ✅ 完整页面 HTML、Raw 和凭据不上传；正文 HTML/Markdown 不做应用层压缩、不使用 Base64。
- ✅ 阅读/归档是本机状态，修改不推进内容 `updatedAt`、pull 不覆盖；本机已有完整正文/排版优先保留。
- ✅ 取消本地订阅只删除纯本地文章，已同步团队副本和本机阅读/归档状态保留。
- ✅ 看板支持“我的 / 团队”，纯团队文章后来被本机采到时会补记本机贡献。
- ✅ 服务端提供设备、来源分配、轮询均分和短租约 API。
- ✅ 上传 DTO 与服务端双重 allowlist；Raw、Cookie、token、fingerprint、partition/session 不上传。
- ✅ 私有 RSS URL 的内嵌账号密码和疑似凭据查询参数不会进入团队 outbox；设备 token 无安全存储时拒绝落明文。

### 展示边界与发布

- ✅ 官方 `mp.weixin.qq.com` 正文 HTML 按产品决定视为可信，在 iframe 中做 CSS/布局隔离；动态组件可打开原文。
- ✅ 公众号原始排版固定浅色，不强制改写发布者内联颜色；所有正文外链统一交给系统默认浏览器，子 frame 导航也不会留在内置页面。
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

- ⬜ 人工验收扫码、公众号/RSS 添加、拉取最新、阅读、一键已读、归档和重登。
- ⬜ 验证 sandbox preload、CSP 下公众号图片和系统外链。
- ⬜ 用真实经典图文验收跨文章阅读习惯、原始排版懒加载、白色/暗色主题、长文滚动、图片和系统浏览器外链。
- ⬜ 后台采集错误缺少明确 UI 反馈；quota waiting 状态只有占位。
- ⬜ 修复 `probe-add.mts` / `probe-pipeline.mts` 并纳入 typecheck。
- ⬜ 在 Windows 人工安装下一测试版，验收白/暗阅读界面、二维码、RSS、快速来源切换、历史维护、一键已读、系统外链和团队同步频率。
- ⬜ 从已安装的 `v0.5.0` 按确认式流程更新到 `v0.6.0`，确认设置、凭据、内容数据、阅读状态、HTML sidecar 和一次性索引重建均正常。
- ⬜ 用两台真实设备验证首次历史补传、断网重试、重复文章 contribution 和退出/重加入。
- ⬜ 在 Windows 验收自定义资料库选择/迁移、源目录保留、目标缺盘明确报错，以及迁移期间采集/同步停机。
- ⬜ 用真实账号运行自动采集多个周期，确认默认关闭、1h～7d 校验、无追赶、批次互斥和微信全局限速。
- ⬜ 验收“重抓本篇”、单源/全部历史的离线重新解析与网络重新抓取，确认失败页只追加快照、不覆盖成功正文。

### P2A — 数据工具能力

- ⬜ SQLite FTS5 全文索引与搜索 UI。
- ⬜ 正式数据导出（资料库打开入口已完成）。
- ⬜ 来源/日期/状态组合筛选和采集结果统计。
- ⬜ 在当前图片消息支持上继续覆盖旧 `__QMTPL_SSR_DATA__`、风控/验证页、表格/音视频/卡片语义投影和有序内容模型。
- ⬜ 为不可变 Raw 增加可解释的容量统计与用户确认式保留/清理策略；禁止用覆盖快照实现清理。
- ⬜ 更多 SourceAdapter；不加入模型、embedding 或向量服务。

### P2B — 团队共享后续

- ⬜ 为默认 `https://home.agent-wiki.cn:18038` 补齐进程守护、数据目录备份和外部健康监控；HTTPS `/healthz` 已可用。
- ⬜ 在桌面端展示团队 Source、负责人和设备，并提供“刷新我的任务”入口。
- ⬜ 桌面采集前接入短租约，完成后回报结果；当前 assignment/lease 只在服务端 API 可用。
- ⬜ 增加已隔离事件的详情、删除/修复后重试界面，以及设备撤销入口。

### P3 — 极低优先级事项

- ⬜ 在可信成员假设不再成立时，再评估细粒度权限、限时邀请、审计、复杂撤销和端到端加密。
- ⬜ 等用户提供裁剪完成的 Logo 后替换当前品牌资源；同时保持资源入口集中，便于以后再次换 Logo。本轮不继续放大、裁剪或重绘现有图。

## 7. 推荐顺序

1. 在真实 Windows 安装 `v0.6.0`，重点验收信源切换速度、文章打开、跨文章阅读偏好、白/暗主题、系统外链、来源设置和团队同步周期。
2. 用验证页与旧 SSR fixture 继续验收不可变快照、失败保护和明确降级。
3. 为已上线的默认团队服务补进程守护、备份和外部健康监控，并做两台 Windows 团队同步验收。
4. 接入桌面采集任务分配/租约，再修 probe、错误反馈与凭据告警。
5. 实现 FTS5、搜索与正式数据导出，再扩展旧 SSR 和更多纯数据 SourceAdapter。

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

- Raw 抓取快照不可变；Article/sidecar 是 infohub 管理的当前产品投影；SQLite 是派生索引。
- SQLite 只用 Node 内置 `node:sqlite`；JavaScript 只用 pnpm。
- renderer 不直接访问文件、SQLite、凭据或采集网络。
- 自动采集默认关闭；只有用户显式开启，且与手动采集共用全局互斥、账号配额和保守限流。
- 团队网络不可用不得阻塞或回滚本地落盘；只允许 HTTPS 和 allowlist DTO。
- 不直接集成任何 AI 能力；外部消费者只读 `articles/`，输出只写 `outputs/<producer>/`。
- 用户资料库可以迁移；凭据、设置、团队队列和 Chromium 分区固定留在私有状态目录。
