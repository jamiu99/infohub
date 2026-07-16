# 开发验证、代码地图与接手记录

> 上级：[overview.md](overview.md) · 数据接口：[data-interface.md](data-interface.md)

最后更新：2026-07-17，v0.6.0 阅读性能与设备偏好发布基线。

## 代码地图

| 领域 | 实现 |
|------|------|
| 共享契约 | `src/shared/contract.ts`、`ipc.ts`、`collection.ts`、`maintenance.ts`、`data-library.ts`、`wechat.ts`、`team.ts`、`url.ts` |
| App 入口 | `src/main/index.ts`、`external-navigation.ts` |
| 后端装配/IPC | `src/main/service.ts` |
| 数据资料库 | `src/main/data-guide.ts`、`data-location.ts`、`data-migration.ts`、`data-startup.ts`、`data-library-controller.ts`、`src/core/paths.ts` |
| 微信扫码/凭据 | `src/main/wechat-login.ts`、`secrets.ts`、`team-secrets.ts` |
| 采集编排/账号/限流 | `src/core/collect/collector.ts`、`collection-runner.ts`、`auto-collect-scheduler.ts`、`wechat-request-gate.ts`、`account-pool.ts`、`rate-limit.ts` |
| 非敏感运行设置 | `src/core/settings.ts`、固定私有 `state/settings.json` |
| Adapter | `src/core/ingest/adapter.ts`、`wechat-adapter.ts`、`rss-adapter.ts` |
| 微信/RSS 协议 | `src/core/ingest/wechat.ts`、`rss.ts`、`net.ts` |
| 归一化/正文 | `src/core/process/normalize.ts`、`wechat.ts`、`rss.ts`、`content.ts` |
| 文件/SQLite | `src/core/store/index.ts`、`markdown.ts`、`src/core/paths.ts` |
| 团队同步 | `src/core/team/sync-client.ts`、`sync-storage.ts`、`apply-remote.ts` |
| preload | `src/preload/index.ts` |
| Vue 看板 | `src/renderer/src/stores/app.ts`、`layout.ts`、`preferences.ts`、`wechat-html.ts`、`components/*.vue`、`styles/main.css` |
| 内容呈现 | `src/renderer/src/markdown.ts`、`src/renderer/src/wechat-html.ts`、`src/renderer/index.html` |
| 更新/发布 | `src/main/update-controller.ts`、`src/main/updater.ts`、`electron-builder.yml`、`.github/workflows/release.yml` |

仓库已没有 AI CLI、Skill 安装器或 `core/agent` 目录。

## v0.6.0 阅读性能、偏好与团队周期（2026-07-17）

- 390 篇真实资料库诊断确认：旧 `article:list` 会全盘解析 Markdown、回写索引，再逐篇 hydrate 最多 500 篇；SQLite 查询本身只需数毫秒。现在列表直接返回 SQLite `ArticleListItem`，未读统计与来源切换不再触发文件扫描。
- SQLite 新增来源名和正文 sidecar 路径投影；正常启动复用索引，只有首次建库、投影升级或上次文章写入留下 dirty 标记时重建。批量已读使用一个 dirty 周期和 SQLite 事务。
- `article:get` 只读选中的 Markdown；公众号 HTML 由 `article:getContentHtml` 在进入原始排版时懒加载。快速切换文章用请求序号丢弃过期结果，短时间 `articles-changed` 事件合并刷新。
- “沉浸阅读 / 原始排版”成为跨文章设备习惯；新增白色/暗色双主题。公众号原始排版固定浅色，外链统一使用系统默认浏览器，iframe 子 frame 导航由 main 兜底拦截。
- “来源与抓取”不再把找新文章和修复正文画成步骤；单源/全量维护分别折叠，删除后果明确。
- 团队自动同步支持关闭和 1～1440 分钟周期（推荐 5 分钟），使用单次 timer；关闭后继续排队并允许立即同步。
- 当前 Logo 未修改；等待用户提供裁剪成品后替换，记为低优先级品牌 TODO。

当前验证：`pnpm typecheck` ✅ · `pnpm test:core` 166/166 ✅ · `pnpm build`/bundle ✅ · Electron desktop smoke ✅。

## 米色阅读体验与抓取语义升级（2026-07-15）

- renderer 统一为固定米色纸张色阶与扁平边界；正文默认使用窄行宽、中文衬线字体和更舒展行距。顶部复用已入库透明 Logo，通过 CSS 居中放大裁剪，只展示图形中心且不生成新品牌资产。
- 微信详情默认从原始排版调整为 Markdown“沉浸阅读”，仍可切换 iframe 原始排版；文章级动作明确命名为“重抓本篇”。
- 新增独立“来源与抓取”设置页：每个公众号/RSS 可单独启停、拉取最新、取消关注；历史维护支持单源/全部和离线/联网四种组合，全部联网需要显式确认。
- UI 与契约明确区分“拉取最新”和“处理已入库历史”：微信公众号前者仍只取最新一页，后者只处理已有 Article，均不会发现从未入库的更早文章。
- 新增 `source:setEnabled` 与 `article:markAllRead` IPC；一键已读按当前 source 和 mine/team 范围逐篇写回文件，不受列表 500 条限制。核心测试增至 153 项。

## v0.4 数据生命周期与采集维护（2026-07-15）

- 微信 parser v2 在经典 `#js_content` 之外支持 `item_show_type=8` 图片消息，安全读取 `window.cgiDataNew.picture_page_info_list` 和静态 `window.picture_page_info_list`；只取对象直接 `cdn_url/width/height` 与图注，不执行脚本、不把 watermark/分享封面当正文。
- 列表 Raw 改为 `<external-id-sha>/<content-sha>.json`，完整页面改为 `pages/<content-sha>.page.html`；两者只创建不覆盖，不同响应并存。Article 新增 `lastAttemptPageHtmlPath`，失败重抓可保留诊断页而不替换成功正文/页面。
- Store 增加维护专用的全量文章枚举和完整页面读取，不受看板 500 条限制；维护语义拆成已有快照的离线重新解析与原 URL 的网络重新抓取。
- 自动采集设置默认关闭，周期范围 60～10080 分钟、推荐 240 分钟。Scheduler 用单次 timer、每轮结束再排下一轮；休眠/离线不追赶。Runner 统一手动/自动批次互斥、最久未采集优先和 `no_account` 后只跳过剩余微信来源。
- 微信公众号后台的搜索/列表请求跨来源共用请求门：正常至少 10 秒，换号重试至少 15 秒；公开文章正文请求使用独立的 2 秒串行请求门；账号小时配额继续独立生效。
- 数据路径拆成用户可迁移资料库与固定私有状态。bootstrap 在 `userData/state/data-location.json`；迁移要求空目标，在目标盘 staging 复制并做 SHA-256 校验，成功后切换指针，源目录始终保留。设置、凭据、团队队列/cursor 和 Chromium 分区不随资料库迁移。
- v0.4.2 在迁移边界校验前从最近存在的祖先解析真实路径，消除 Windows 8.3 短路径、目录联接或祖先别名，防止私有迁移日志被误纳入资料库。
- 外部 AI/Agent 只读 `articles/`，产物写 `outputs/<producer>/`；`raw/` 与 Article/sidecar 均不允许外部回写。
- 新增核心单测覆盖图片消息静态解析、内容寻址快照、失败尝试保留、维护全量枚举、自动 timer/批次行为、跨来源请求间隔、资料库 bootstrap 与迁移故障路径。Service/IPC 已接通并通过 Electron smoke；Windows 跨盘迁移和真实账号多周期仍待人工验收。

## v0.5.0 发布门禁

| 命令 | 结果 |
|------|------|
| `pnpm typecheck` | ✅ main/preload/core/shared + renderer 通过 |
| `pnpm test:core` | ✅ 153/153，0 fail |
| `pnpm build` / `pnpm verify:bundle` | ✅ 生产构建、CJS preload、项目 logo 契约通过 |
| `pnpm smoke:desktop` | ✅ 真实 Electron 中账号、自动采集、资料库 IPC、`srcdoc` iframe 与更新菜单通过 |
| `git diff --check` | ✅ |

## Windows 品牌图标（2026-07-15）

- 将 `resources/branding/infohub-logo-concept-v1.png` 作为品牌概念源图纳入仓库，并派生紧凑透明的 `resources/branding/infohub-icon-v1.png` 作为 Windows 应用图标。
- 派生图使用内置 imagegen 编辑和本地 chroma-key 去背流程生成；electron-builder 在打包时从 1254×1254 RGBA PNG 生成 ICO，同一图标用于应用 EXE、桌面/开始菜单快捷方式，以及 NSIS 安装和卸载界面。
- `pnpm verify:bundle` 会检查图标存在、为至少 512×512 的方形 RGBA PNG，且 Windows 打包配置明确引用它，防止后续版本退回 Electron 默认图标。

## 微信公众号 HTML 正文 v1（2026-07-14）

- 只读审阅 `refs/NewsCrawler` 的公众号抓取、普通 DOM/SSR 解析、内容模型、图片下载和 Markdown 输出；未修改参考仓库。
- 决定只借鉴分层、双解析路径、有序内容块和图片下载防护，不复制 GPLv3 源码、不引入 Python sidecar。
- 经典图文改用 `parse5` 树定位 `#js_content`，同时保存 Markdown、内容寻址且由 Article 指向的正文 HTML sidecar，以及 SHA-256 命名的未改写 `.page.html`。
- 展示 sidecar 提升 `data-src/data-original/data-backsrc`、补绝对 URL；原始页面不改写。正文 HTML/Markdown 不压缩、不使用 Base64。
- Article frontmatter 增加内容状态、解析器版本、sidecar 路径、尝试/成功时间和错误；`seen_items` 命中后仍会为失败、正文 HTML/本机完整页面路径或文件缺失、或旧版本产物重试，失败不覆盖已有完整正文。
- IPC 改成列表不载 HTML、详情按需读取；该版本最初默认 iframe 原始排版，2026-07-15 阅读体验升级后改为默认 Markdown 沉浸阅读，仍可切换原始排版。
- 团队同步在 Article 有内容时直接携带 `contentHtml`；只同步 Markdown、正文 HTML 和 URL，不上传完整页面/Raw/凭据。
- 测试期团队协议硬切 `/api/v2`，不维护 v1 fallback 或能力协商；同步先 status 后 push，push 按 12 MiB 实际 JSON 字节预算分批，pull 每页 50 条。v0.3.0 必须先升级服务端，再升级全部桌面端，混合版本不受支持。
- 阅读/归档写回 Article 文件但不推进内容 `updatedAt`，避免状态操作改变团队 payload 或确定性 eventId。
- 该版本当时尚未覆盖图片消息；2026-07-15 的 parser v2 已补 `picture_page_info_list`，旧 `__QMTPL_SSR_DATA__`、风控/验证页、语义内容块与依赖脚本的动态组件仍属于后续。
- 详细实施依据见 [wechat-content.md](wechat-content.md)。

## v0.3.1 发布自动化基线

以下是已发布旧版本的门禁快照，不代表 v0.5.0 当前测试总数：

| 命令 | 结果 |
|------|------|
| `pnpm typecheck` | ✅ main/preload/core/shared + renderer 通过 |
| `pnpm test:core` | ✅ 80/80，0 fail |
| `pnpm build` | ✅ main/preload/renderer 生产构建通过 |
| `pnpm verify:bundle` | ✅ sandbox preload 为单文件 CJS，主窗口路径一致 |
| `pnpm smoke:desktop` | ✅ 真实 Electron 中账号列表、设置读写 IPC、更新菜单，以及 CSP 下 `srcdoc` iframe/微信官方 base URL 通过 |
| `pnpm audit --prod` | ✅ 未发现已知生产依赖漏洞 |
| Markdown 链接 / `git diff --check` | ✅ |
| GitHub Release workflow | ✅，Windows 打包前校验版本并重跑完整门禁 |
| `./verify.sh` | ✅，本地与 `main`/PR CI 共用 |

当时的核心测试主要分布：

- 账号池、可配置配额与限流观测：12。
- 设置文件加载、原子保存与边界校验：3。
- Collector 串行锁、未知 adapter 与失败正文重试：3。
- 公众号页面抓取、树提取、展示 sidecar、超时中文化与 HTML → Markdown：10。
- renderer Markdown 与微信 iframe `srcdoc`：7。
- RSS/Atom、adapter、normalizer 与网络容错：8。
- Store 往返、HTML sidecar/完整页面、列表/详情、状态、重建、外部文件同步、迁移和路径：9。
- 运行时数据目录说明：1。
- 微信登录 URL 白名单与传统二维码切换：2。
- 用户确认式更新状态机：5。
- 团队 HTTPS、outbox/ack/隔离、入组/同步、正文 HTML 直传、范围重建、RSS 来源映射、取消订阅和贡献翻转：11。
- 用户可见异常中文转换与三栏布局归一化/拖动边界：5。

## 桌面阅读界面整理（2026-07-13）

- 主界面顶部增加轻量全局工具栏；信源、文章、正文三栏可独立隐藏并从工具栏恢复。
- 相邻栏分隔线支持指针拖动、方向键微调和双击恢复，显隐与宽度保存到 renderer `localStorage`；不涉及业务数据或凭据。
- 左栏只保留信源和“添加信源”，账号配额、团队连接、界面恢复和软件更新迁入独立设置弹窗。
- 文章栏 header 固定为不可收缩区域，长信源名省略显示，“我的 / 团队”切换不会再被文章列表覆盖。
- `shared/errors.ts` 统一把超时、网络、DNS、证书和常见 HTTP 异常转换为中文；main 更新流程、团队同步及 renderer 操作共用。

## 团队共享实现（2026-07-13）

- 新增独立 `infohub-team-server`，使用 Node 内置 SQLite 和普通 Markdown 保存团队数据。
- 桌面加入团队后，服务端生成设备 token；共享 `TEAM_TOKEN` 不写磁盘。
- 既有本机贡献会在后台完整排队，新文章在本地落盘后进入 outbox；网络故障不回滚采集。
- eventId 由设备与公开 payload 确定性派生，2xx 先写 ack 标记再删队列；启动重扫可恢复任意中断点。
- 超限/非法事件和服务端永久 4xx 会单独隔离，不再阻塞其余文章；侧栏显示隔离数量。
- pull 合并保留本机阅读/归档、较完整正文与兼容注释，团队来源信息写回 Article 文件。
- 取消订阅保留已有团队副本；私有 RSS 凭据参数不上传，纯团队正文可接收服务端后续更新。
- 设置弹窗提供团队状态、立即同步和退出；主文章栏保留“我的 / 团队”阅读范围。
- assignment/rebalance/lease 已在服务端实现；桌面任务分配 UI 和租约采集尚未接入。

## 产品边界清理（2026-07-11）

- 删除 `src/main/agent-cli.ts`、Agent CLI 类型和 4 项实验测试。
- 删除 `src/main/skills.ts`、`resources/skills/` 和打包 `extraResources`。
- 删除 summarize/briefing 项目文档。
- 把采集模块从 `src/core/agent/` 迁到 `src/core/collect/`。
- App 启动改为生成中立的 `INFOHUB_DATA.md`。
- 新 Article 不再写摘要/分数/标签空占位；旧非空注释只做兼容。
- 新增 [data-interface.md](data-interface.md)，将文件与 SQLite 固化为唯一外部接口。

## 历史真机验证（2026-07-06）

这是前任记录，本次接手没有再次请求真实公众号接口：

- 两个微信号分别用独立 `persist:` 分区扫码入池。
- `searchbiz` 能返回公众号候选与 fakeid。
- `appmsg` 能读取目标号文章总数与第一页，记录为 523 篇总量。
- 公众号正文、Markdown 入库和 SQLite 查询曾走通。
- RSS 曾用 Hacker News feed 验证 discover → fetch → normalize。

登录态和上游接口都可能变化，发布前需重新验收。

## 本地运行

从 harness 根目录：

```bash
cd projects/infohub
./start.sh
```

管理命令：

```bash
./start.sh status
./start.sh attach
./start.sh stop
```

`start.sh` 只在 tmux 启动 `pnpm dev`，不安装依赖。不要在自动化会话直接启动长驻进程。
`status` 会区分真正运行的进程与只剩 shell 的 stale session；再次执行 `start` 会自动清理旧会话。

WSL/纯 Linux 若缺 Electron GUI 库，可能需要管理员安装：

```bash
sudo apt-get install -y libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libgbm1 libgtk-3-0 libasound2t64
```

## 探测脚本状态

| 脚本 | 状态 |
|------|------|
| `scripts/probe-collect.mts` | 只适用于账号池明文的特定开发环境 |
| `scripts/probe-add.mts` | ❌ 仍使用重构前 Collector API |
| `scripts/probe-pipeline.mts` | ❌ 仍使用重构前 Collector API |

它们未包含在 `tsconfig.node.json`，是下一步必须修复的工程漂移。

## 高优先级待办

1. 后台采集错误和 quota waiting 缺明确前端反馈。
2. 微信账号池在 safeStorage 不可用时仍静默明文，缺格式版本、告警与迁移；团队设备 token 已改为拒绝明文保存。
3. 普通 push/PR 与 Release 已有门禁，但 GitHub 分支保护规则尚未核验。
4. sandbox preload 已做 Linux Electron smoke test；CSP 图片、当前版本二维码、配额/团队界面、三栏拖动、原生更新对话框和系统外链仍需真实 Windows 点击验收。
5. 两个 probe 脚本失效，尚未纳入 `verify.sh`。
6. 默认团队 HTTPS `/healthz` 已验证可用，但进程守护/备份/外部监控和两设备历史补传、断网恢复、contribution 合并仍需真实环境验证。
7. 图片消息静态列表已进入 v0.4.0；旧 `__QMTPL_SSR_DATA__`、风控/验证页和动态组件仍未覆盖。
8. 自定义资料库、离线/网络维护和自动采集已完成 Service/IPC、设置 UI 与安全重启；仍需 Windows 跨盘和多周期真实账号验收。

## 仍需补的测试

- Store 故障注入、损坏文件隔离、大数据量同步性能和 Windows 原子替换。
- 自动采集多个真实周期、系统休眠恢复和退出时在途任务收口。
- 自定义资料库真实跨盘迁移、断电恢复、缺盘启动和旧 v0.3.x 私有状态导入。
- Service 维护 IPC 参数校验、批量错误摘要、迁移排他与 source 删除。
- renderer 组件交互/E2E。
- CSP/sandbox 的真实 Electron 运行验收。
- 真实微信经典图文/图片消息 iframe、懒加载媒体、长文、阅读版切换，以及旧 SSR/异常页 fixture。
- Windows 安装和双版本自动更新。
- 已隔离事件的修复/重试 UI、cursor 故障、两设备并发上传和 assignment/lease 桌面集成。
