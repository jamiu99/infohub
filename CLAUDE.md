# infohub — CC 入口约定

本地 Electron App：采集微信公众号/RSS 等信源 → 二次处理成统一结构 → 文件为源 + SQLite 索引 → 接入 AI CLI 产出简报/知识库。

## 铁律：文档与代码同步

**每次改代码，必须同步更新文档；每次做决策，必须记进 [docs/decisions.md](docs/decisions.md)。** 进度主文件是 [docs/overview.md](docs/overview.md)，改任何模块回来更新对应进度行。禁止代码与文档版本分离。

## 核心原则

- **模块彻底解耦**：ingest / process / store / agent 之间只经[数据契约](docs/contract.md)传递，任一可独立替换测试。
- **文件为源**：数据真相在 `data/` 的 markdown 文件，SQLite 只做索引，可重建。通用 agent 在数据目录下天然可工作。
- **前后端分离**：Electron main = 后端、renderer = 前端，IPC 通信，renderer 无 Node 权限。
- **SQLite 用 Node 内置 `node:sqlite`**，禁止三方库。JS 包管理用 pnpm。
- **不自造 agent loop**：驱动外部 CLI（Claude Code / Codex）。

## 去哪找

一切从 [docs/overview.md](docs/overview.md)（进度与索引主文件）进。文档地图见其「5. 文档地图」。

## 命令

- 不在 CC 会话起长驻进程（Electron dev / server）。需要时用 `./start.sh`（tmux）或提示手动起。
- 公众号采集参考只读：`../../refs/get_wechat_list`（代码烂，只取核心接口逻辑）。
