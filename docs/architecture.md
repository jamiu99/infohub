# 架构与模块边界

> 上级：[overview.md](overview.md) · 数据接口：[data-interface.md](data-interface.md) · 契约：[contract.md](contract.md)

## 运行时分层

```text
┌──────────────────────────────────────────────────────────┐
│ Electron main（本地后端）                                 │
│ Service 装配 / IPC / 扫码窗口 / 文件 / SQLite / 团队同步  │
└──────────────────────────┬───────────────────────────────┘
                           │ ipcMain / ipcRenderer
┌──────────────────────────▼───────────────────────────────┐
│ preload                                                  │
│ contextBridge 只暴露 InfohubApi 白名单                    │
└──────────────────────────┬───────────────────────────────┘
                           │ window.api
┌──────────────────────────▼───────────────────────────────┐
│ Electron renderer（Vue 3 看板前端）                       │
│ 信源 / 文章 / 账号配额 / 我的·团队 / 更新提示             │
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
                              ├─▶ raw/...json（列表原始载荷）
                              ▼
                         Normalizer
                              │
                    可选 enrichContent()
                              ▼
                           Article
                              │
                 ┌────────────┼──────────────────┐
                 ▼            ▼                  ▼
        articles/...md   articles/*.content.html  raw/*.page.html
         Markdown 正文      微信展示正文 sidecar     微信完整原页
                 │            │                  │
                 └────────────┼───────────┬──────┘
                              ▼           ▼
                         index.sqlite   Vue 看板 / 外部只读消费者
                         查询/状态/去重

本机 Article 成功落盘后，允许共享的 DTO 另行写入文件 outbox。后台同步只负责 HTTPS push/pull，不触发采集：

Article Markdown + 可选 contentHtml ─▶ team/outbox ─HTTPS─▶ infohub-team-server
                 ▲                                      │
                 └──────── cursor pull / Article ───────┘
```

微信经典图文的 `enrichContent()` 用 `parse5` 构建 HTML 树并定位 `#js_content`。完整响应页面不改写，按 URL/外部 ID 的 SHA-256 存入 `raw/`；展示 sidecar 保留正文根节点和内联样式，只把懒加载资源属性提升为可展示属性，并把相对 URL 补成绝对地址。Markdown 是确定性阅读投影，不再承担还原原始排版的唯一职责。

外部消费者不进入 App 进程，也没有 SDK/插件协议。它们只依赖普通文件和 SQLite，见 [data-interface.md](data-interface.md)。

## 目录与职责

```text
src/
├── main/
│   ├── index.ts             # App/主窗口入口
│   ├── service.ts           # 运行设置、依赖装配与 IPC handler
│   ├── data-guide.ts        # 生成 INFOHUB_DATA.md
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
│   ├── wechat.ts            # 微信账号/返回类型
│   ├── team.ts              # 团队 HTTPS DTO 与地址校验
│   └── url.ts               # http(s) URL 白名单
└── core/
    ├── collect/             # Collector、账号池、限流
    ├── settings.ts          # 非敏感运行设置与原子持久化
    ├── team/                # 文件 outbox、同步客户端、远端文章合并
    ├── ingest/              # Adapter、微信、RSS、网络容错
    ├── process/             # normalizer、正文提取/转换
    ├── store/               # Markdown/HTML 文件与 SQLite
    └── paths.ts             # data/ 路径契约
```

## 模块约束

| 边界 | 允许 | 禁止 |
|------|------|------|
| renderer | 调 `window.api`、管理视图状态 | Node API、SQLite、凭据、直接采集 |
| main | 装配 core、IPC、Electron 能力 | 业务算法堆进 handler、模型调用 |
| collect | 串行任务、账号选择、限流 | 理解 UI、写正文格式 |
| ingest | 获取原始数据、保留载荷 | 写正式 Article、判断内容价值 |
| process | `RawItem → Article`、正文补全、微信正文 HTML 提取 | 账号调度、存储路径、模型增强 |
| store | Markdown/HTML 文件、状态与索引持久化及查询 | 发网络请求、理解具体信源协议 |
| team | allowlist DTO、正文 HTML 直传、可靠队列、HTTPS 增量同步 | 上传 Raw/完整页面 HTML/登录态、触发采集、覆盖本机阅读状态 |
| 外部消费者 | 只读公开数据接口 | 读取 `secrets/`、依赖 App 内部代码 |

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

产品将官方 `mp.weixin.qq.com` 文章正文视为可信来源：微信详情读取 `article:get` 返回的 `contentHtml`，放进独立 iframe 以隔离公众号样式对 App 的影响，并默认展示原始排版。iframe 是 CSS/布局边界，不是宣称对微信正文做完整安全净化；静态快照不会主动执行页面脚本，因此依赖运行时脚本的动态组件仍可能不完整，用户可“打开原文”。

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
- 微信新旧 SSR 图片页、依赖脚本的复杂动态组件和尚未覆盖的媒体类型仍需专用解析路径。
- renderer sandbox/CSP、iframe 原始排版和外链仍需真实桌面点击验收。
