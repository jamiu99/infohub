# 决策日志（ADR）

> 上级：[overview.md](overview.md) · 只记录已经做出的选择与代价；设想和待办放进进度文档。

## ADR-001 桌面框架使用 Electron

- **日期**：2026-07-06
- **决策**：Electron + TypeScript，不使用 Tauri。
- **理由**：需要 BrowserWindow 官方扫码登录、Node 网络/文件/子进程能力；统一 TS 的实现摩擦较小。
- **代价**：安装包和内存占用较高。

## ADR-002 采集层使用 Node/TypeScript

- **日期**：2026-07-06
- **决策**：用 TS 实现公众号/RSS 采集，不运行 Python sidecar。
- **理由**：采集协议较小，避免跨语言进程与部署；main、core、renderer 共享类型。
- **代价**：无法直接复用 Python 爬虫生态，已有参考逻辑需重写。

## ADR-003 文章文件为内容源，SQLite 为派生索引

- **日期**：2026-07-06
- **决策**：文章正文和元数据写 Markdown，SQLite 用于列表、筛选、去重和状态。
- **理由**：普通文件便于人工查看、迁移和任意外部消费者读取；SQLite 补足查询性能。
- **约束**：只用 Node 内置 `node:sqlite`，禁止第三方 SQLite 包。
- **落地补充**：2026-07-11 用 schema v2 兑现状态双写、外部文件同步与 `seen_items` 重建，见 ADR-009。

## ADR-004 公众号登录使用官方 BrowserWindow 扫码

- **日期**：2026-07-06
- **决策**：加载官方公众号后台，由用户扫码；每个微信号使用独立 `persist:wx-<id>` 分区，再从 session/URL 获取 cookie 与 token。
- **理由**：不处理账密、验证码或模拟登录协议；独立分区能隔离多个真实账号。
- **弃选**：共享分区切换账号、直接模拟登录接口。
- **2026-07-13 补充**：微信页面优先展示账号/快捷登录后，App 自动触发官方页面事件切到传统二维码；明确禁止用户输入账号密码，Session 权限默认拒绝，并限制顶层导航和弹窗。

## ADR-005 不自造 Agent loop

- **日期**：2026-07-06
- **决策**：复用外部 Agent，不在项目中实现模型循环。
- **原方案**：由 App 通过 stream-json/node-pty 驱动 Claude Code/Codex。
- **状态**：**已被 ADR-011 彻底终止**。实验 CLI、类型和测试已从仓库删除。

## ADR-006 升级 Electron 以支持内置 `node:sqlite`

- **日期**：2026-07-06
- **决策**：Electron 33 升到 43。
- **理由**：Electron 33 的 Node 20 不支持 `node:sqlite`；Electron 43 内置 Node 24，满足 ADR-003 和项目约束。
- **教训**：系统 Node 测试通过不代表 Electron 内置 Node 也支持，必须验证实际运行时。

## ADR-007 默认手动采集、全局串行、极保守频率

- **日期**：2026-07-06
- **决策**：不启用自动轮询；Collector 全局互斥；微信默认 20 请求/账号/小时、10 秒同账号间隔、15 秒换号间隔、一次 1 页。
- **理由**：真实公众号账号安全高于采集速度，先消除后台定时与并发风险。
- **回滚条件**：只有在任务、配额、取消、错误反馈和真实账号验收完成后，才考虑由用户显式开启自动采集；默认仍应关闭。
- **2026-07-13 补充**：20 保留为默认值，用户可显式修改所有账号共用的小时保护上限；配置写入非敏感 `settings.json`，当前窗口计数不因改值而清零。看板被动记录本小时/累计请求数及最近一次 `200013` 的触发序号，不提供自动压测或并发撞限流。

## ADR-008 AI 主路径使用数据目录 Skill

- **日期**：2026-07-06；2026-07-10 接手审计确认现状
- **决策**：App 只安装 `summarize`、`briefing` 到 `data/.claude/skills/`；用户在数据目录主动运行 Claude Code。App 不自动 spawn CLI，也不新增 Agent SDK/API 依赖。
- **理由**：文章本来就是普通 Markdown；外置执行权限面小，避免把认证、费用和跨平台进程管理提前耦合进桌面 App。
- **代价**：无 App 内进度/错误/取消或同步提示；当前只对 Claude Code 自动发现友好。
- **历史重开条件（现失效）**：曾计划在“一键生成”成为明确需求时重开技术选择。
- **状态**：**已被 ADR-011 推翻**。内置 Skills、安装逻辑、资源和文档已删除，不再重开。

## ADR-009 存储 schema v2 以文件为最终恢复源

- **日期**：2026-07-11
- **决策**：Article 文件持久化 `externalId/read/archived`；状态修改先原子写文件再 upsert SQLite；启动时从文件完整重建 `articles/seen_items`，运行中节流同步外部文件变化。
- **迁移**：首次升级先把 v0.1.0 SQLite 中的阅读/归档状态回填旧文件，再标记 schema v2 和重建索引；旧 `externalId` 按微信 URL / RSS guid 推导。
- **理由**：让“文件为源”成为可验证事实；SQLite 丢失后仍能恢复查询、状态和去重，合法的外部文件变化也不会与 App 永久分叉。
- **代价**：启动与同步需要扫描 Markdown；当前同步是同步 I/O，规模扩大后需增量 mtime/manifest；运行中外部删除文件要到完整 rebuild 才清理旧索引。

## ADR-010 外部正文按不可信内容处理

- **日期**：2026-07-11
- **决策**：Markdown renderer 只生成有限标签、只接受绝对 http(s) URL，并用 DOMPurify allowlist 二次清洗；renderer 配 CSP 和 Chromium sandbox；main 只允许 http(s) 交给 `shell.openExternal`。
- **理由**：公众号/RSS 正文可包含攻击者控制的文本和链接，renderer 又暴露了业务 IPC，必须采用分层防御而非依赖自写转义。
- **代价**：相对链接、`data:` 图片和非 http(s) scheme 会被丢弃；CSP/sandbox 可能影响少数图片或 preload 行为，发布前需桌面人工验收。
- **2026-07-13 补充**：sandboxed preload 不支持 ESM import，因此强制输出单文件 CJS，并用真实 Electron smoke test 验证 `window.api` 和 IPC；`v0.1.2` 因违反该约束而撤回。

## ADR-011 永久取消一切 AI 直接集成

- **日期**：2026-07-11
- **决策**：infohub 最终定位为数据获取、文件归档、SQLite 索引和快速看板。项目不调用模型、不启动 AI CLI、不安装 Skill/插件、不管理 Agent 任务，也不提供摘要、简报、embedding、知识库或 RAG。
- **唯一边界**：AI 与脚本一样，只能作为外部消费者读取 [data-interface.md](data-interface.md) 定义的普通文件和 SQLite。
- **理由**：把项目保持为可靠、透明、可替换的数据地基；避免认证、费用、模型选择、权限、平台进程和内容判断污染采集工具。
- **代码处理**：删除实验 Claude CLI、Agent 类型/测试、内置 summarize/briefing Skills、启动安装逻辑和打包资源；采集模块从 `core/agent` 迁至 `core/collect`。
- **兼容策略**：不主动删除用户数据目录里的旧 `.claude/skills/` 或 `briefings/`，但 App 完全忽略它们。旧 Article 的非空注释字段继续可读，新文章不再写空占位。
- **不可回滚**：未来若需要 AI 功能，应作为独立项目消费 infohub 数据，不重新塞回 infohub。

## ADR-012 更新恢复通道放在 Electron main

- **日期**：2026-07-13
- **决策**：更新采用“检查 → 原生确认下载 → 下载进度 → 原生确认重启”流程；启动自动检查、帮助菜单和左栏手动检查共用同一状态机。
- **理由**：更新是桌面应用的恢复通道，不能只依赖 renderer/preload。main 原生菜单与对话框在前端桥接故障时仍可工作。
- **约束**：`autoDownload=false`，未经用户确认不下载；确认下载后允许退出时安装；状态仍广播给 renderer 展示进度。
- **验证**：纯逻辑测试覆盖无新版、拒绝下载、确认下载、稍后安装和错误反馈；真实跨版本安装仍需 Windows 人工验收。
