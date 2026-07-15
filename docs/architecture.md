# 架构与模块边界

> 上级：[overview.md](overview.md) · 数据接口：[data-interface.md](data-interface.md) · 契约：[contract.md](contract.md)

## 运行时分层

```text
┌──────────────────────────────────────────────────────────┐
│ Electron main（本地后端）                                 │
│ Service 装配 / IPC / 扫码窗口 / 采集调度 / 文件 / SQLite  │
└──────────────────────────┬───────────────────────────────┘
                           │ ipcMain / ipcRenderer
┌──────────────────────────▼───────────────────────────────┐
│ preload                                                  │
│ contextBridge 只暴露 InfohubApi 白名单                    │
└──────────────────────────┬───────────────────────────────┘
                           │ window.api
┌──────────────────────────▼───────────────────────────────┐
│ Electron renderer（Vue 3 看板前端）                       │
│ 信源 / 文章 / 我的·团队 / 阅读与设置                       │
└──────────────────────────────────────────────────────────┘
```

renderer 使用 `contextIsolation: true`、`nodeIntegration: false`、`sandbox: true`，不直接访问文件、SQLite、登录凭据或采集网络。preload 必须打包成 sandbox 支持的单文件 CommonJS `index.cjs`，所有操作经 [src/shared/ipc.ts](../src/shared/ipc.ts) 进入 main。

桌面端与远程团队服务保持独立项目和部署边界：本仓库只包含客户端，`infohub-team-server` 是独立 Node.js 服务，通过 HTTPS JSON API 通信。远程服务逻辑不进入 renderer，也不借用 Electron IPC 充当公网 API。

## 核心数据流

```text
Source
  │
  ▼
SourceAdapter.fetch() ──▶ RawItem
                              │
                              ├─▶ raw/.../<content-sha>.json（不可变列表快照）
                              ▼
                         Normalizer
                              │
                    可选 enrichContent()
                              ▼
                           Article
                              │
                 ┌────────────┼──────────────────┐
                 ▼            ▼                  ▼
        articles/...md   articles/*.content.html  raw/.../<content-sha>.page.html
       infohub 规范投影      微信展示正文 sidecar        不可变完整响应
                 │            │                  │
                 └────────────┼───────────┬──────┘
                              ▼           ▼
                         index.sqlite   Vue 看板
                         查询/状态/去重

外部 AI / Agent / 脚本：只读 articles/ ──▶ outputs/<producer>/
                                            （infohub 不读取、不回灌）

本机 Article 成功落盘后，允许共享的 DTO 另行写入文件 outbox。后台同步只负责 HTTPS push/pull，不触发采集：

Article Markdown + 可选 contentHtml ─▶ team/outbox ─HTTPS─▶ infohub-team-server
                 ▲                                      │
                 └──────── cursor pull / Article ───────┘
```

微信经典图文的 `enrichContent()` 用 `parse5` 构建 HTML 树并定位 `#js_content`；图片消息解析器安全读取 `window.cgiDataNew.picture_page_info_list` 或静态 `window.picture_page_info_list`，不会执行页面脚本。完整响应页面不改写，以响应内容 SHA-256 命名；同一文章的不同响应永久并存。展示 sidecar 保留经典正文排版，或为图片消息生成确定性的图片/图注结构；Markdown 是跨信源文本投影。

历史维护有两条明确路径：离线重新解析只读取已有 `.page.html`（完整正文优先用成功页面，尚未成功则优先最近尝试页），不发网络请求；网络重新抓取按原文 URL 获取新响应，先追加不可变快照，再尝试更新 Article 投影。失败只更新最近尝试与错误，不用空内容覆盖既有完整正文。

自动采集只是另一种批次触发方式，不是独立采集管线。它与手动刷新共用批次互斥、Collector 全局串行、账号配额和微信请求门；默认关闭，启用后每轮完成才安排下一轮，休眠或离线期间错过的轮次不追赶。

外部消费者不进入 App 进程，也没有 SDK/插件协议。它们只读普通 Article 文件；如需保存摘要、标签、向量或其他结果，只能写入 `outputs/<producer>/`，见 [data-interface.md](data-interface.md)。

## 公开资料库与私有状态

Electron `userData` 下固定保留一份很小的 bootstrap 和私有状态；用户可选择、迁移的是公开资料库：

```text
Electron userData/
├── state/                         # 固定，不随资料库迁移
│   ├── data-location.json         # 当前资料库绝对路径
│   ├── settings.json
│   ├── migrations/
│   ├── secrets/
│   └── team/
├── Partitions / Session Storage…  # Chromium 登录分区，仍由 Electron 管理
└── data/                           # 默认资料库；也可指向用户选择的位置

用户资料库/
├── infohub-library.json
├── INFOHUB_DATA.md
├── articles/
├── raw/
├── outputs/
├── sources.json
└── index.sqlite
```

启动先读取固定 `state/data-location.json`，再打开资料库。已配置的移动盘或网络盘不可用时必须显式报错，不能在原路径创建一个空资料库。迁移在采集/同步停止并安全重启后、Store 打开前执行：只接受空目标，在目标盘的 staging 目录复制并逐文件校验 SHA-256，提交后切换 bootstrap；失败继续使用原目录，源目录无论成功失败都保留。SQLite、临时文件与旧版混放的 `settings/secrets/team` 不复制，索引在目标启动时重建。

## 目录与职责

```text
src/
├── main/
│   ├── index.ts             # App/主窗口入口
│   ├── service.ts           # 运行设置、依赖装配与 IPC handler
│   ├── data-guide.ts        # 生成 INFOHUB_DATA.md
│   ├── data-location.ts     # 固定 bootstrap 与资料库定位
│   ├── data-migration.ts    # 停机复制、校验与迁移日志
│   ├── wechat-login.ts      # 扫码 BrowserWindow
│   ├── secrets.ts           # safeStorage 凭据持久化
│   ├── team-secrets.ts      # 团队设备 token 持久化
│   ├── update-controller.ts # 可测试的更新状态机
│   └── updater.ts           # electron-updater + 原生对话框
├── preload/index.ts         # contextBridge 实现
├── renderer/                # Vue 3 看板
├── shared/
│   ├── contract.ts          # Source / RawItem / Article
│   ├── ipc.ts               # InfohubApi 与事件
│   ├── collection.ts        # 自动采集设置与状态契约
│   ├── wechat.ts            # 微信账号/返回类型
│   ├── team.ts              # 团队 HTTPS DTO 与地址校验
│   └── url.ts               # http(s) URL 白名单
└── core/
    ├── collect/             # Collector、批次 Runner、定时器、账号池、请求门
    ├── settings.ts          # 非敏感运行设置与原子持久化
    ├── team/                # 文件 outbox、同步客户端、远端文章合并
    ├── ingest/              # Adapter、微信、RSS、网络容错
    ├── process/             # normalizer、正文提取/转换
    ├── store/               # Markdown/HTML 文件与 SQLite
    └── paths.ts             # 可迁移资料库 / 固定私有状态双路径契约
```

## 模块约束

| 边界 | 允许 | 禁止 |
|------|------|------|
| renderer | 调 `window.api`、管理视图状态 | Node API、SQLite、凭据、直接采集 |
| main | 装配 core、IPC、Electron 能力 | 业务算法堆进 handler、模型调用 |
| collect | 手动/自动批次互斥、串行任务、账号选择、限流 | 理解 UI、写正文格式、追赶错过的定时轮次 |
| ingest | 获取原始数据、保留载荷 | 写正式 Article、判断内容价值 |
| process | `RawItem → Article`、正文补全、微信正文 HTML 提取 | 账号调度、存储路径、模型增强 |
| store | 不可变 Raw、infohub 管理的 Markdown/HTML 投影、状态与索引 | 发网络请求、理解具体信源协议、读取外部 `outputs/` |
| team | allowlist DTO、正文 HTML 直传、可靠队列、HTTPS 增量同步 | 上传 Raw/完整页面 HTML/登录态、触发采集、覆盖本机阅读状态 |
| 外部消费者 | 只读 `articles/`，把派生结果写入自己的 `outputs/<producer>/` | 改写 `articles/`/`raw/`、读取私有 state、依赖 App 内部代码 |

## 团队同步故障边界

- 本地 `saveArticle()` 成功后才尝试写 outbox；网络不在采集事务内。
- outbox 是一事件一文件，服务端用 `(deviceId,eventId)` 幂等处理；HTTP 整批成功后客户端才删除。
- eventId 由设备与完整公开 payload 确定性派生；2xx 后先写 ack 标记再删 outbox，启动重扫因此可恢复所有崩溃窗口。
- 本地协议预检和永久 4xx 二分隔离 poison item，单篇坏数据不会堵住整个队列。
- pull 每页成功写入 Article 文件和可选正文 HTML sidecar 后才推进本地 cursor；团队正文不会覆盖本机已有的更完整正文/排版。
- 服务器实例变化、设备 token 失效或 HTTPS 请求失败会保留 outbox，并在看板显示同步错误。
- TEAM_TOKEN 只存在于一次 IPC/HTTPS 入组调用；后续只使用服务端签发的设备 token。
- RSS URL 内嵌凭据/敏感查询参数不上传；设备 token 无 `safeStorage` 时拒绝持久化。

## 外部内容呈现边界

产品将官方 `mp.weixin.qq.com` 文章正文视为可信来源：微信详情默认展示 Markdown 沉浸阅读；用户切换原始排版时，renderer 读取 `article:get` 返回的 `contentHtml` 并放进独立 iframe，以隔离公众号样式对 App 的影响。iframe 是 CSS/布局边界，不是宣称对微信正文做完整安全净化；静态快照不会主动执行页面脚本，因此依赖运行时脚本的动态组件仍可能不完整，用户可“查看原文”。

这项信任决定只适用于已采集的官方微信正文，不改变原有 Markdown/RSS 链路：

- Markdown renderer 仍只生成有限标签、只接受绝对 http(s) URL。
- DOMPurify allowlist 仍对 Markdown/RSS 展示做二次净化。
- main 仍只把 http(s) 外链交给系统浏览器。
- renderer 继续使用 context isolation、sandbox 和本地脚本 CSP。

## 技术栈

- Electron 43、electron-vite 2、Vite 5、TypeScript 5.7
- Vue 3.5、DOMPurify 3、parse5 8
- Node 内置 `node:sqlite`
- pnpm 10
- Node `node:test` + `tsx`
- electron-builder、electron-updater、GitHub Actions

## 当前架构债务

- Service 后台任务缺统一错误事件、取消和重试。
- `scripts/` 未纳入 TypeScript 工程，已有接口漂移。
- 数据同步仍是同步目录扫描；规模扩大后需 mtime/manifest 增量方案。
- FTS5、正式 rebuild/export 命令尚未实现。
- 图片消息静态数据已有专用解析；旧 `__QMTPL_SSR_DATA__`、依赖脚本的复杂动态组件和尚未覆盖的媒体类型仍需专用路径。
- 自定义资料库、迁移、历史重跑与自动采集需要完成 Service/IPC/Windows 端到端验收和故障恢复演练。
- renderer sandbox/CSP、iframe 原始排版和外链仍需真实桌面点击验收。
