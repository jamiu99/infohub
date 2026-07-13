# infohub — 工作区索引

## 最终定位

infohub 是 **数据采集 + 文件归档 + SQLite 索引 + 快速看板**。外部工具可读取数据，但项目不直接集成 AI、模型、CLI、Skill 或 Agent 工作流。

当前为 `v0.2.1` 团队共享 MVP 与阅读界面整理阶段。桌面 preload/IPC 桥、数据一致性、内容渲染、传统二维码登录、用户确认式更新、可配置小时上限、限流观测、文件型团队同步、独立设置弹窗和可调三栏已完成首轮实现；默认团队 HTTPS 健康入口已经可用，接下来聚焦多设备/Windows 验收、服务备份监控、桌面采集任务分配入口和凭据告警。唯一进度入口是 [docs/overview.md](docs/overview.md)。

## 目录速览

```text
infohub/
├── src/main/               # Electron main：本地后端、IPC、登录、更新
├── src/preload/            # contextBridge 白名单
├── src/renderer/           # Vue 3 看板前端
├── src/core/
│   ├── collect/            # 采集编排、账号池、限流
│   ├── settings.ts         # 非敏感运行设置
│   ├── team/               # outbox、HTTPS 同步与远端文章合并
│   ├── ingest/             # 微信/RSS Adapter 与网络
│   ├── process/            # 归一化和正文转换
│   └── store/              # 文件与 SQLite
├── src/shared/             # 数据、IPC、URL 契约
├── test/                   # node:test 自动化测试
├── scripts/                # 真机探测脚本（部分待修）
├── docs/                   # 项目文档
├── start.sh                # tmux 启动/停止入口
└── verify.sh               # 本地与 CI 共用验证入口
```

## 阅读顺序

1. [overview.md](docs/overview.md)：状态、完成度、风险和优先级。
2. [data-interface.md](docs/data-interface.md)：外部消费者真正依赖的文件/索引接口。
3. [architecture.md](docs/architecture.md)：前后端进程边界与数据流。
4. [dev-log.md](docs/dev-log.md)：代码地图、验证命令、已知问题。
5. [team-sharing.md](docs/team-sharing.md)：团队同步、可信入组和采集分配。
6. 按需阅读 `contract / ingest / process / storage`。

## 工程约束

- Electron main 与 renderer 通过类型化 IPC 通信；renderer 不直接访问文件、SQLite、凭据或采集接口。
- SQLite 只用 Node 内置 `node:sqlite`，JavaScript 包管理只用 pnpm。
- 文章文件是真相源，SQLite 是可重建加速层。
- 团队同步必须在本地落盘后进入 outbox；网络失败不得回滚或阻塞采集。
- 默认不自动采集；所有公众号请求全局串行并使用保守限流。
- 不加入任何模型依赖、AI CLI 驱动、Skill 安装或 Agent 调度。
- 所有提交与 Release 共享 `verify.sh` 基线；Windows Release 额外校验 tag 与包版本一致。
- 不在自动化会话启动常驻 Electron；从 harness 根目录用 `projects/infohub/start.sh`。
- 改代码时同步更新 `overview.md` 和模块文档；新增或推翻决策写入 `decisions.md`。
