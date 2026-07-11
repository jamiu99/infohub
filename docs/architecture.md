# 架构与模块边界

> 上级：[overview.md](overview.md) · 数据接口：[data-interface.md](data-interface.md) · 契约：[contract.md](contract.md)

## 运行时分层

```text
┌──────────────────────────────────────────────────────────┐
│ Electron main（本地后端）                                 │
│ Service 装配 / IPC / 扫码窗口 / 文件 / SQLite / 自动更新  │
└──────────────────────────┬───────────────────────────────┘
                           │ ipcMain / ipcRenderer
┌──────────────────────────▼───────────────────────────────┐
│ preload                                                  │
│ contextBridge 只暴露 InfohubApi 白名单                    │
└──────────────────────────┬───────────────────────────────┘
                           │ window.api
┌──────────────────────────▼───────────────────────────────┐
│ Electron renderer（Vue 3 看板前端）                       │
│ 信源 / 文章 / 账号配额 / 采集进度 / 更新提示              │
└──────────────────────────────────────────────────────────┘
```

renderer 使用 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`，不直接访问文件、SQLite、登录凭据或采集网络。所有操作经 [src/shared/ipc.ts](../src/shared/ipc.ts) 进入 main。

当前是一个桌面仓库和发布物，但运行时前后端边界明确。如果未来增加远程服务，必须建立独立后端项目和 API，不能把服务逻辑塞进 renderer。

## 核心数据流

```text
Source
  │
  ▼
SourceAdapter.fetch() ──▶ RawItem
                              │
                              ├─▶ raw/...json
                              ▼
                         Normalizer
                              │
                     可选 enrichBody()
                              ▼
                           Article
                              │
                 ┌────────────┴────────────┐
                 ▼                         ▼
        articles/...md               index.sqlite
        内容与元数据源                 查询/状态/去重
                 │
         ┌───────┴────────┐
         ▼                ▼
      Vue 看板       外部只读消费者
```

外部消费者不进入 App 进程，也没有 SDK/插件协议。它们只依赖普通文件和 SQLite，见 [data-interface.md](data-interface.md)。

## 目录与职责

```text
src/
├── main/
│   ├── index.ts             # App/主窗口入口
│   ├── service.ts           # 依赖装配与 IPC handler
│   ├── data-guide.ts        # 生成 INFOHUB_DATA.md
│   ├── wechat-login.ts      # 扫码 BrowserWindow
│   ├── secrets.ts           # safeStorage 凭据持久化
│   └── updater.ts           # electron-updater
├── preload/index.ts         # contextBridge 实现
├── renderer/                # Vue 3 看板
├── shared/
│   ├── contract.ts          # Source / RawItem / Article
│   ├── ipc.ts               # InfohubApi 与事件
│   ├── wechat.ts            # 微信账号/返回类型
│   └── url.ts               # http(s) URL 白名单
└── core/
    ├── collect/             # Collector、账号池、限流
    ├── ingest/              # Adapter、微信、RSS、网络容错
    ├── process/             # normalizer、正文提取/转换
    ├── store/               # Markdown 与 SQLite
    └── paths.ts             # data/ 路径契约
```

## 模块约束

| 边界 | 允许 | 禁止 |
|------|------|------|
| renderer | 调 `window.api`、管理视图状态 | Node API、SQLite、凭据、直接采集 |
| main | 装配 core、IPC、Electron 能力 | 业务算法堆进 handler、模型调用 |
| collect | 串行任务、账号选择、限流 | 理解 UI、写正文格式 |
| ingest | 获取原始数据、保留载荷 | 写正式 Article、判断内容价值 |
| process | `RawItem → Article`、正文补全 | 账号调度、存储路径、模型增强 |
| store | 文件/索引持久化与查询 | 发网络请求、理解具体信源协议 |
| 外部消费者 | 只读公开数据接口 | 读取 `secrets/`、依赖 App 内部代码 |

## 外部内容安全

公众号/RSS 正文是不可信输入：

- HTML 转 Markdown 时先剥离未支持标签。
- renderer 只生成有限标签，只接受绝对 http(s) URL。
- DOMPurify allowlist 二次净化。
- CSP 只允许本地脚本，禁止 object/frame/form/worker。
- main 只把 http(s) 外链交给系统浏览器。

## 技术栈

- Electron 43、electron-vite 2、Vite 5、TypeScript 5.7
- Vue 3.5、DOMPurify 3
- Node 内置 `node:sqlite`
- pnpm 10
- Node `node:test` + `tsx`
- electron-builder、electron-updater、GitHub Actions

## 当前架构债务

- Service 后台任务缺统一错误事件、取消和重试。
- `scripts/` 未纳入 TypeScript 工程，已有接口漂移。
- 数据同步仍是同步目录扫描；规模扩大后需 mtime/manifest 增量方案。
- FTS5、正式 rebuild/export 命令尚未实现。
- renderer sandbox/CSP 仍需真实桌面点击验收。
