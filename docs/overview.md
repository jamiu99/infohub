# infohub — 总览与进度

> 本文件是唯一进度入口。模块文档解释实现，这里只维护产品边界、可验证状态、风险和下一步。

最后更新：**2026-07-13** · 阶段：**v0.1.5 采集配额观测与稳定化**

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
| 当前源码版本 | `v0.1.5` |
| 上个正式版本 | `v0.1.4`（提交 `c1f18e9`，2026-07-13）；`v0.1.2` 已撤回 |
| 自动检查 | `pnpm typecheck` ✅ · `pnpm test:core` ✅（49/49）· `pnpm build` ✅ |
| 桌面桥接 | bundle contract ✅ · Electron preload/IPC smoke test ✅ |
| 依赖审计 | `pnpm audit --prod` ✅，未发现已知生产依赖漏洞 |
| CI | `main`/PR 运行 `verify.sh`；tag Release 在 Windows 重跑完整门禁并校验版本 |

当前定位：**核心链路可运行、可构建、已有 Windows Release，但仍是个人试用级 MVP，尚未完成桌面产品验收。**

## 3. 数据流

```text
微信公众号 / RSS
        │
        ▼
SourceAdapter.fetch() ──▶ RawItem JSON（原始载荷）
        │
        ▼
Normalizer + 正文补全 ──▶ Article Markdown（真相源）
        │
        ├──────────────▶ index.sqlite（派生索引）
        │
        ├──────────────▶ Vue 看板（快速浏览）
        │
        └──────────────▶ 外部只读消费者（脚本 / 搜索工具 / AI）
```

App 每次启动会在数据根目录生成 `INFOHUB_DATA.md`，让消费者不依赖项目源码也能理解目录和稳定字段。

## 4. 已实现

### 获取与处理

- ✅ 微信公众号官方页面扫码登录，每个账号独立 `persist:` 分区。
- ✅ 自动切换到传统二维码；不要求账号密码，登录窗口权限和导航已收口。
- ✅ 多账号池、可持久化的小时配额、冷却/失效状态和重新登录。
- ✅ `searchbiz` 搜号、`appmsg` 拉文章；默认 20 请求/账号/小时，可在看板配置，一次 1 页。
- ✅ 测试期逐账号展示本小时/累计请求，并记录最近一次 `200013` 的请求序号和时间。
- ✅ 全局串行锁、无自动轮询，只允许用户主动刷新。
- ✅ RSS/Atom URL 试探、解析、超时重试和归一化。
- ✅ Adapter + normalizer 注册表，新信源边界清晰。
- ✅ 公众号正文抓取和轻量 HTML → Markdown。

### 文件、索引与看板

- ✅ Raw JSON、Article Markdown、`sources.json` 和 SQLite 索引。
- ✅ schema v2：`externalId` 入文件、旧状态迁移、原子写、路径防逃逸。
- ✅ 启动时完整重建 `articles/seen_items`，运行中同步外部文件变化。
- ✅ 三栏 Vue 看板：信源、文章流、正文、筛选、配额、添加公众号/RSS。
- ✅ 未读、归档、按源清理和最多 500 条倒序列表。
- ✅ 自动生成 `INFOHUB_DATA.md` 数据说明。

### 安全与发布

- ✅ 文本转义、绝对 http(s) URL 白名单、DOMPurify allowlist、CSP。
- ✅ renderer sandbox + contextIsolation + preload IPC 白名单。
- ✅ preload 输出为 sandbox 兼容的单文件 CJS；真实 Electron smoke test 验证 `window.api` 与 IPC。
- ✅ Windows NSIS Release 与 `electron-updater`。
- ✅ 原生“检查更新 → 确认下载 → 进度 → 确认重启”流程，菜单和左栏均可手动检查。
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
- ⬜ 后台采集错误缺少明确 UI 反馈；quota waiting 状态只有占位。
- ⬜ 修复 `probe-add.mts` / `probe-pipeline.mts` 并纳入 typecheck。
- ⬜ 在 Windows 人工安装 `v0.1.5`，验收二维码、配额修改、限流观测、RSS、阅读、归档、图片和外链。
- ⬜ 从已安装的 `v0.1.4` 按确认式流程更新到 `v0.1.5`，确认重启安装、设置和账号数据保留。

### P2 — 数据工具能力

- ⬜ SQLite FTS5 全文索引与搜索 UI。
- ⬜ 正式 `rebuild-index`、数据导出和数据目录打开入口。
- ⬜ 来源/日期/状态组合筛选和采集结果统计。
- ⬜ 复杂公众号排版、表格、音视频等正文转换。
- ⬜ 更多 SourceAdapter；不加入模型、embedding 或向量服务。

## 7. 推荐顺序

1. 若仍在 preload 损坏的 `v0.1.1`，先手动安装 `v0.1.4` 恢复更新通道，再按提示升级 `v0.1.5`。
2. 修 probe 脚本、错误反馈与凭据告警。
3. 用后续补丁版本再次复验自动更新。
4. 实现 FTS5、搜索与正式数据维护命令。
5. 再扩展更多纯数据 SourceAdapter。

## 8. 文档地图

| 文档 | 内容 |
|------|------|
| [data-interface.md](data-interface.md) | 文件、SQLite、稳定字段和消费者约定 |
| [architecture.md](architecture.md) | 进程模型、模块边界、数据流 |
| [contract.md](contract.md) | Source / RawItem / Article / DiscoverResult |
| [ingest.md](ingest.md) | Adapter、公众号接口、RSS |
| [process.md](process.md) | 归一化与正文处理 |
| [storage.md](storage.md) | 文件布局、schema v2、迁移和重建 |
| [wechat-monitor.md](wechat-monitor.md) | 看板产品形态和手动采集 |
| [wechat-login.md](wechat-login.md) | 扫码、账号池和限流 |
| [release.md](release.md) | Windows 发布与自动更新 |
| [dev-log.md](dev-log.md) | 代码地图、验证与问题清单 |
| [decisions.md](decisions.md) | ADR 决策日志 |

## 9. 不可妥协约束

- 文件是真相源，SQLite 是派生索引。
- SQLite 只用 Node 内置 `node:sqlite`；JavaScript 只用 pnpm。
- renderer 不直接访问文件、SQLite、凭据或采集网络。
- 默认手动采集、全局串行、保守限流。
- 不直接集成任何 AI 能力；外部消费者只依赖数据接口。
