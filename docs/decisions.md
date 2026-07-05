# 决策日志（ADR）

> 上级：[overview.md](overview.md) · 记录"为什么这么选"，避免后来反复纠结。新决策往下追加。

## ADR-001 桌面框架用 Electron（非 Tauri）
- **日期**：2026-07-06
- **决策**：Electron + TypeScript。
- **理由**：要跑爬虫脚本、动态加载 AI 生成代码、内嵌 BrowserWindow 抓公众号 cookie/token——Electron JS/TS 生态与 Node 子进程摩擦最小；BrowserWindow + `persist:` 分区是扫码登录方案的地基。Tauri 体积小但后端 Rust，这些场景摩擦更大。
- **代价**：安装包大（80-150MB）、内存高。可接受。

## ADR-002 采集层用 Node/TS（非 Python sidecar）
- **日期**：2026-07-06
- **决策**：采集层用 TS 重写，不跑 Python sidecar。
- **理由**：全栈统一 TS，无跨语言进程通信；公众号核心逻辑就两个 GET 请求（`refs/get_wechat_list`），重写成本极低。
- **代价**：Python 爬虫/解析生态用不上；已有 Python 脚本需重写（量很小）。

## ADR-003 存储：文件为源 + SQLite 索引
- **日期**：2026-07-06
- **决策**：文章正文/元数据存 markdown 文件为真相源，SQLite 只做索引，可从文件重建。
- **理由**：用户核心诉求——"数据最终都是文件，通用 agent 在目录下天然能工作"。文件为源满足 agent 友好；SQLite 补上检索/去重/状态。纯文件方案检索弱，纯 SQLite 违背 agent 友好，取中。
- **约束**：SQLite 用 Node 内置 `node:sqlite`，禁止三方库（遵全局规范）。

## ADR-004 扫码登录用内嵌 BrowserWindow（非模拟登录接口）
- **日期**：2026-07-06
- **决策**：开 BrowserWindow 加载官方登录页，用户扫码，App 从 session 抓 cookie + 从跳转 URL 抓 token。
- **理由**：不碰账密/验证码/风控，稳且合规风险低；`persist:` 分区天然隔离多账号 cookie，是多账号方案地基。
- **备选（弃）**：模拟登录 API——脆弱、易触风控、违规风险高。

## ADR-005 AI 底座：驱动外部 CLI（不自造 agent loop）
- **日期**：2026-07-06
- **决策**：接入 Claude Code / Codex 等 CLI，通过 stream-json / node-pty 驱动。
- **理由**：复用成熟 agent 能力；文件为源的数据目录任何通用 agent 都能直接работать。
- **注意**：WSL/Windows 需 `wsl.exe -- claude` + 路径映射；`claude -p` 走独立配额池。
