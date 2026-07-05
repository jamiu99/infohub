# infohub — 工作区索引

## 目录速览

```
infohub/
├── README.md / WORKSPACE.md / CLAUDE.md   # 三个入口文档
├── start.sh / .tmux.conf                  # 一键启动（tmux）
├── docs/                                   # 全部文档，从 overview.md 进
│   ├── overview.md      # ★ 进度与索引主文件
│   ├── architecture.md  # 架构、进程模型、模块边界
│   ├── contract.md      # 数据契约 RawItem/Article/Source
│   ├── ingest.md        # 采集层 + 公众号接口 + RSS
│   ├── wechat-monitor.md # ★ 公众号监控：产品形态 / 三栏 UI / 调度
│   ├── wechat-login.md  # ★ 扫码登录 / cookie / 多账号 / 限流
│   ├── process.md       # 处理层 pipeline
│   ├── storage.md       # 文件布局 + SQLite schema
│   ├── agent.md         # AI CLI 集成 + 自我修改
│   └── decisions.md     # 决策日志 ADR
├── src/
│   ├── main/            # Electron 主进程（后端）
│   ├── renderer/        # 前端 UI
│   └── core/            # 纯 TS 业务逻辑
│       ├── contract/  ingest/  process/  store/  agent/
└── data/                # 运行时数据（gitignore）
```

## 当前状态

阶段 P0 起步：项目骨架 + 完整文档体系已建。代码尚未开始，详见 [docs/overview.md](docs/overview.md) 进度看板。

## 远程

github jamiu99（私有），本项目由我（jamiu）开发。尚未 `gh repo create`（骨架先行，等确认后建远程）。
