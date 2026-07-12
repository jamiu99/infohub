# infohub — 本地信息采集与索引看板

infohub 是一个 Electron 桌面数据工具：采集微信公众号与 RSS/Atom，归一化为清晰的 Markdown/JSON 文件，用 SQLite 建立索引，并提供快速浏览看板。

## 产品边界

infohub 只做四件事：

1. 获取数据。
2. 归一化并落成普通文件。
3. 建立可重建索引。
4. 提供快速看板。

它**不调用任何模型 API、不启动 AI CLI、不安装 Skill、不生成摘要或简报，也不管理 Agent 工作流**。AI 或其他分析程序通过文件系统和 SQLite 直接消费数据，接口见 [docs/data-interface.md](docs/data-interface.md)。

## 当前能力

- 微信公众号独立分区扫码登录、多账号池、保守限流和手动串行采集。
- RSS/Atom URL 解析、超时重试、采集与统一入库。
- 三栏看板：信源、文章流、正文详情、未读和归档。
- Article Markdown、Raw JSON、`sources.json` 与 Node 内置 `node:sqlite` 索引。
- schema v2 旧数据迁移、文件/索引同步、去重表完整重建。
- 外部内容 URL 白名单、DOMPurify、CSP 与 Electron renderer sandbox。
- Windows NSIS Release 与自动更新。

当前版本是 `v0.1.2`。核心数据链路、发布门禁、自动更新和公众号传统二维码登录已就绪；桌面全流程、凭据兜底、错误反馈与探测脚本仍需稳定化，详见 [docs/overview.md](docs/overview.md)。

## 开发与验证

要求 Node.js 22+、pnpm 10+：

```bash
pnpm install --frozen-lockfile
./verify.sh
```

`./verify.sh quick` 只运行类型检查和核心测试；脚本不会安装依赖或启动常驻服务。

从 `harness` 根目录启动：

```bash
cd projects/infohub
./start.sh
```

或直接执行：

```bash
projects/infohub/start.sh
```

`start.sh` 只负责 tmux 中的开发进程，不安装依赖。使用 `./start.sh attach` 查看日志，`./start.sh stop` 停止。

## 数据入口

运行时数据位于 Electron 的 `app.getPath('userData')/data`：

- `INFOHUB_DATA.md`：自动生成的数据接口说明。
- `articles/`：归一化 Article Markdown，数据真相源。
- `raw/`：采集原始 JSON，用于溯源与重放。
- `sources.json`：关注信源。
- `index.sqlite`：可从 Article 文件完整重建的查询、状态与去重索引。
- `secrets/`：公众号凭据，禁止外部消费者读取。

## 文档入口

- [当前进度与下一步](docs/overview.md)
- [文件系统与 SQLite 数据接口](docs/data-interface.md)
- [架构与模块边界](docs/architecture.md)
- [存储、迁移与重建](docs/storage.md)
- [开发验证与已知问题](docs/dev-log.md)
- [发布与自动更新](docs/release.md)
- [决策日志](docs/decisions.md)
