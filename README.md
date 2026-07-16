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

- 微信公众号独立分区扫码登录、多账号池、可配置小时上限、限流观测，以及手动/定时串行采集。
- RSS/Atom URL 解析、超时重试、采集与统一入库。
- 白色/暗色双主题三栏看板：信源、文章流、沉浸正文、一键已读和归档。
- Article Markdown、微信公众号正文 HTML/完整页面 HTML、Raw JSON、`sources.json` 与 Node 内置 `node:sqlite` 索引。
- 微信经典图文页用 HTML 树提取 `#js_content`；图片消息（“贴图号”）读取正文图片数组；详情默认显示 Markdown 沉浸阅读，也可切换到公众号原始排版。
- 单篇、当前信源或全部本机文章可联网重新抓取，也可从不可变页面快照离线重新解析。
- 自动采集默认关闭，可由用户设置为每 1 小时至 7 天运行一次；睡眠和退出期间不追赶错过轮次。
- 内容资料库可选择并安全迁移；Raw、Article 投影与外部 `outputs/` 分层，登录凭据和团队状态固定留在本机私有目录。
- schema v3 旧数据迁移、文件/索引同步、去重表完整重建。
- 可选的自托管团队共享：HTTPS 入组、可靠 outbox、增量同步和“我的 / 团队”视图。
- Markdown/RSS 内容继续使用 URL 白名单、DOMPurify、CSP 与 Electron renderer sandbox；官方 `mp.weixin.qq.com` 正文 HTML 按可信来源直接在隔离 iframe 中呈现。
- Windows NSIS Release 与用户确认式自动更新。

当前源码版本是 `v0.6.0`。本版将文章列表与信源切换改为 SQLite 轻量查询，公众号原始 HTML 按需加载，并新增白色/暗色主题、跨文章阅读习惯、系统浏览器外链和可配置团队同步周期。升级首次启动会自动重建一次本地索引；Article/Raw 文件与团队 `/api/v2` 均未改变，自托管团队服务端无需升级。微信公众号未入库旧文章回溯、复杂动态组件、跨版本自动更新和多设备同步仍需人工验收，详见 [docs/overview.md](docs/overview.md) 与 [v0.6.0 发布说明](docs/releases/v0.6.0.md)。

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

内容资料库默认位于 Electron 的 `app.getPath('userData')/data`，也可在“设置 → 数据资料库”迁移到用户选择的空目录：

- `infohub-library.json`：资料库身份和格式标识。
- `INFOHUB_DATA.md`：自动生成的数据接口说明。
- `articles/`：infohub 管理的 Article Markdown 与正文 HTML 投影；具体 sidecar 路径以 Article 的 `content.contentHtmlPath` 为准。
- `raw/`：采集原始 JSON；微信完整页面另按 SHA-256 命名为 `.page.html`，用于溯源与后续重放。
- `outputs/<producer>/`：AI、脚本等外部消费者唯一允许写入的派生结果目录；infohub 不回灌这些结果。
- `sources.json`：关注信源。
- `index.sqlite`：可从 Article 文件完整重建的查询、状态与去重索引。

以下本机状态固定在 `app.getPath('userData')/state`，不会随资料库迁移，也不属于外部数据接口：

- `settings.json`：采集、团队等非敏感运行设置。
- `team/`：可靠上传队列和增量同步游标。
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
