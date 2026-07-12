# 开发验证、代码地图与接手记录

> 上级：[overview.md](overview.md) · 数据接口：[data-interface.md](data-interface.md)

最后更新：2026-07-11，基于提交 `99ed81f` 的未提交接手改动。

## 代码地图

| 领域 | 实现 |
|------|------|
| 共享契约 | `src/shared/contract.ts`、`ipc.ts`、`wechat.ts`、`url.ts` |
| App 入口 | `src/main/index.ts` |
| 后端装配/IPC | `src/main/service.ts` |
| 数据目录说明 | `src/main/data-guide.ts` |
| 微信扫码/凭据 | `src/main/wechat-login.ts`、`secrets.ts` |
| 采集编排/账号/限流 | `src/core/collect/collector.ts`、`account-pool.ts`、`rate-limit.ts` |
| Adapter | `src/core/ingest/adapter.ts`、`wechat-adapter.ts`、`rss-adapter.ts` |
| 微信/RSS 协议 | `src/core/ingest/wechat.ts`、`rss.ts`、`net.ts` |
| 归一化/正文 | `src/core/process/normalize.ts`、`wechat.ts`、`rss.ts`、`content.ts` |
| 文件/SQLite | `src/core/store/index.ts`、`markdown.ts`、`src/core/paths.ts` |
| preload | `src/preload/index.ts` |
| Vue 看板 | `src/renderer/src/stores/app.ts`、`components/*.vue`、`styles/main.css` |
| 内容安全 | `src/renderer/src/markdown.ts`、`src/renderer/index.html` |
| 更新/发布 | `src/main/updater.ts`、`electron-builder.yml`、`.github/workflows/release.yml` |

仓库已没有 AI CLI、Skill 安装器或 `core/agent` 目录。

## 2026-07-11 自动化基线

| 命令 | 结果 |
|------|------|
| `pnpm typecheck` | ✅ main/preload/core/shared + renderer 通过 |
| `pnpm test:core` | ✅ 37/37，0 fail |
| `pnpm build` | ✅ main/preload/renderer 生产构建通过 |
| `pnpm audit --prod` | ✅ 未发现已知生产依赖漏洞 |
| Markdown 链接 / `git diff --check` | ✅ |
| GitHub Release workflow | ✅，Windows 打包前校验版本并重跑完整门禁 |
| `./verify.sh` | ✅，本地与 `main`/PR CI 共用 |

35 项测试分布：

- 账号池与配额：8。
- Collector 串行锁与未知 adapter：2。
- 公众号正文提取与 HTML → Markdown：5。
- renderer Markdown 与危险 URL/HTML：4。
- RSS/Atom、adapter、normalizer 与网络容错：8。
- Store 往返、状态、重建、外部文件同步、迁移和路径：7。
- 运行时数据目录说明：1。

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
2. safeStorage 不可用时静默明文，缺格式版本、告警与迁移。
3. 普通 push/PR 与 Release 已有门禁，但 GitHub 分支保护规则尚未核验。
4. sandbox preload、CSP 图片、`v0.1.2` 传统二维码和系统外链未做真实 Windows 点击验收。
5. 两个 probe 脚本失效，尚未纳入 `verify.sh`。

## 仍需补的测试

- Store 故障注入、损坏文件隔离、大数据量同步性能和 Windows 原子替换。
- WechatAdapter 换号、分页、错误状态和请求间隔（fake fetch，不碰真实账号）。
- Service IPC 参数校验、后台任务错误事件和 source 删除。
- renderer 组件交互/E2E。
- CSP/sandbox 的真实 Electron 运行验收。
- Windows 安装和双版本自动更新。
