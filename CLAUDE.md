# infohub — 开发入口约定

本地 Electron 数据工具：微信公众号/RSS 采集 → 统一 Article → Markdown/JSON 文件 → SQLite 派生索引 → Vue 快速看板。

## 最终产品边界

infohub 只负责**获取、归一化、索引和展示数据**。

- 不调用模型 API。
- 不 spawn Claude Code、Codex 或其他 AI CLI。
- 不安装或分发 Skill/插件。
- 不生成摘要、简报、embedding、知识库或 RAG。
- AI/脚本只是下游消费者，通过 [docs/data-interface.md](docs/data-interface.md) 读取文件和索引。

## 文档与代码同步

每次改代码必须同步相应文档；每次做决策写入 [docs/decisions.md](docs/decisions.md)。唯一进度入口是 [docs/overview.md](docs/overview.md)。

## 核心原则

- **模块解耦**：collect / ingest / process / store 只经共享契约传递数据。
- **文件为源**：Article Markdown 是真相源；SQLite 是可完整重建的派生索引。
- **前后端分离**：Electron main 是本地后端，renderer 是前端，只经 preload IPC 通信。
- **SQLite**：只用 Node 内置 `node:sqlite`，禁止第三方 SQLite 包。
- **外部内容不可信**：保留 URL 白名单、DOMPurify、CSP 与 renderer sandbox。
- **账号安全优先**：默认手动、全局串行、保守限流。

## 命令

- 一次性基线：`pnpm typecheck && pnpm test:core && pnpm build`。
- 不在开发会话启动长驻 Electron。
- 从 harness 根目录运行时使用 `projects/infohub/start.sh`。
- 公众号采集参考只读：`../../refs/get_wechat_list`。
