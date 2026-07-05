# 架构

> 上级：[overview.md](overview.md) · 相关：[contract.md](contract.md)

## 进程模型（Electron）

```
┌─────────────────────────────────────────────┐
│ Electron main（Node，后端）                   │
│  - 调度采集/处理/存储 core 模块                 │
│  - 起 AgentCLI 子进程（PTY / stream-json）      │
│  - 管理登录用 BrowserWindow（抓 cookie/token）  │
│  - 唯一能碰文件系统 & SQLite 的层               │
└───────────────┬───────────────────────────────┘
                │ IPC（contextBridge 暴露白名单 API）
┌───────────────▼───────────────────────────────┐
│ Electron renderer（前端 UI）                    │
│  - 信源管理 / 文章列表 / 简报 / 扫码引导         │
│  - 只发意图，不直接碰 fs/network                │
└─────────────────────────────────────────────┘
```

**前后端分离**：main 是后端、renderer 是前端，通过 IPC 通信，renderer 无 Node 权限（`contextIsolation: true`）。符合"前后端分离"约束——两层职责独立，未来 renderer 可换 Web 前端。

## core 模块边界（`src/core/`）

core 是纯 TS 逻辑，**不依赖 Electron API**，可脱离 App 单独跑（方便测试 / 未来给通用 agent 当库调）。

| 模块 | 职责 | 输入 → 输出 | 禁止 |
|------|------|-------------|------|
| `contract/` | 契约与类型 | — | 任何逻辑 |
| `ingest/` | 原始采集 | Source 配置 → `RawItem[]` | 清洗、写正式库 |
| `process/` | 二次处理 | `RawItem` → `Article` | 采集、决定存哪 |
| `store/` | 落地与检索 | `Article` → 文件+索引 | 采集、处理 |
| `agent/` | 驱动 AI CLI | 任务 → CLI 子进程 | 直接改核心逻辑（除 Beta 沙盒） |

模块间**只经契约传递**，禁止跨模块直接读对方内部实现。这样任一模块可独立替换。

## 目录布局

```
infohub/
├── README.md / start.sh / .tmux.conf
├── docs/                  # 全部文档（本目录）
├── src/
│   ├── main/              # Electron 主进程（后端入口、IPC、窗口）
│   ├── renderer/          # 前端 UI
│   └── core/              # 纯 TS 业务逻辑（可独立测试）
│       ├── contract/      # 数据契约
│       ├── ingest/        # 采集层
│       ├── process/       # 处理层
│       ├── store/         # 存储层
│       └── agent/         # AI CLI 集成
└── data/                  # 运行时数据（gitignore），见 storage.md
```

## 技术栈

- Electron + TypeScript
- 前端框架：Vue3（待定，与团队其余项目一致）
- 存储：Node 内置 `node:sqlite`（**禁止三方 sqlite 库**，遵全局规范）+ 文件系统
- 包管理：pnpm
- AI CLI：Claude Code (`claude -p` / stream-json)、Codex 等，见 [agent.md](agent.md)
