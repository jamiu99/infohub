# infohub — 本地信息采集与索引看板

infohub 是一个 Electron 桌面数据工具：采集微信公众号与 RSS/Atom，归一化为清晰的 Markdown/JSON/HTML 文件，用 SQLite 建立索引，并提供快速浏览看板。

## 产品边界

infohub 只做四件事：

1. 获取数据。
2. 归一化并落成普通文件。
3. 建立可重建索引。
4. 提供快速看板。

它**不调用任何模型 API、不启动 AI CLI、不安装 Skill、不生成摘要或简报，也不管理 Agent 工作流**。AI 或其他分析程序通过文件系统和 SQLite 直接消费数据，接口见 [docs/data-interface.md](docs/data-interface.md)。

## 当前能力

- 微信公众号独立分区扫码登录、多账号池、可配置小时上限、限流观测和手动串行采集。
- RSS/Atom URL 解析、超时重试、采集与统一入库。
- 三栏看板：信源、文章流、正文详情、未读和归档。
- Article Markdown、微信公众号正文 HTML/完整页面 HTML、Raw JSON、`sources.json` 与 Node 内置 `node:sqlite` 索引。
- 微信经典图文页用 HTML 树提取 `#js_content`；详情默认显示原始排版，也可切换到 Markdown 阅读版。
- schema v3 旧数据迁移、文件/索引同步、去重表完整重建。
- 可选的自托管团队共享：HTTPS 入组、可靠 outbox、增量同步和“我的 / 团队”视图。
- Markdown/RSS 内容继续使用 URL 白名单、DOMPurify、CSP 与 Electron renderer sandbox；官方 `mp.weixin.qq.com` 正文 HTML 按可信来源直接在隔离 iframe 中呈现。
- Windows NSIS Release 与用户确认式自动更新。

当前源码版本是 `v0.3.1`。Windows 应用、安装器、卸载器与快捷方式已统一使用项目 logo；桌面 preload/IPC 桥、核心数据链路、传统“检查—确认—下载—重启”更新流程、公众号二维码登录、可配置采集配额、团队共享 MVP，以及微信经典图文的 Markdown、正文 HTML、完整页面 HTML 三份归档已就绪。`v0.3.0` 起团队正文 HTML 同步硬切 `/api/v2`，不提供 v1 fallback，也不支持旧桌面端或旧服务端混用；自托管团队必须先升级服务端，再升级全部桌面端。SSR/复杂动态微信内容、桌面全流程和多设备同步仍需继续验收，详见 [docs/overview.md](docs/overview.md) 与 [v0.3.1 发布说明](docs/releases/v0.3.1.md)。

## 开发与验证

要求 Node.js 22+、pnpm 10+：

```bash
pnpm install --frozen-lockfile
./verify.sh
```

`./verify.sh quick` 只运行类型检查和核心测试；脚本不会安装依赖或启动常驻服务。
`pnpm smoke:desktop` 会一次性启动隐藏 Electron 窗口验证 preload/IPC，完成后自动退出。

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
- `articles/`：归一化 Article Markdown；微信文章旁保存同名 `.content.html` 正文 sidecar。
- `raw/`：采集原始 JSON；微信完整页面另按 SHA-256 命名为 `.page.html`，用于溯源与后续重放。
- `sources.json`：关注信源。
- `settings.json`：非敏感本地运行设置。
- `index.sqlite`：可从 Article 文件完整重建的查询、状态与去重索引。
- `team/`：可靠上传队列和增量同步游标，不属于内容接口。
- `secrets/`：公众号与团队设备凭据，禁止外部消费者读取。

## 文档入口

- [当前进度与下一步](docs/overview.md)
- [文件系统与 SQLite 数据接口](docs/data-interface.md)
- [架构与模块边界](docs/architecture.md)
- [存储、迁移与重建](docs/storage.md)
- [团队共享与自托管服务](docs/team-sharing.md)
- [微信公众号 HTML 正文与后续类型](docs/wechat-content.md)
- [开发验证与已知问题](docs/dev-log.md)
- [发布与自动更新](docs/release.md)
- [决策日志](docs/decisions.md)
