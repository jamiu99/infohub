# 开发日志 & 代码地图

> 上级：[overview.md](overview.md) · 作用：文档↔代码映射，防版本分离。每次改代码同步这里。

## 代码地图（文档 → 实现文件）

| 文档 | 实现文件 |
|------|----------|
| [contract.md](contract.md) | `src/shared/contract.ts`（Source/RawItem/Article）、`src/shared/wechat.ts`（账号/搜索）、`src/shared/ipc.ts`（IPC 契约） |
| [ingest.md](ingest.md) | `src/core/ingest/wechat.ts`（searchbiz + appmsg + toRawItem） |
| [process.md](process.md) | `src/core/process/wechat.ts`（归一化阶段1）、`process/content.ts`（阶段2 正文抓取 HTML→md） |
| [storage.md](storage.md) | `src/core/store/index.ts`（Store）、`store/markdown.ts`（frontmatter 序列化）、`core/paths.ts` |
| [wechat-login.md](wechat-login.md) | `src/main/wechat-login.ts`（BrowserWindow 扫码）、`src/core/agent/account-pool.ts`（池+调度）、`agent/rate-limit.ts`、`src/main/secrets.ts`（safeStorage 加密） |
| [wechat-monitor.md](wechat-monitor.md) | `src/core/agent/collector.ts`（编排）、`agent/poller.ts`（轮询）、`src/main/service.ts`（装配+IPC+定时）、`src/renderer/src/`（三栏 UI） |

## 进程/分层落地

- **main（后端）**：`src/main/index.ts` 入口 → `service.ts` 装配 store/pool/collector/poller，注册 IPC，定时轮询（默认 3h）。
- **preload**：`src/preload/index.ts` 用 contextBridge 暴露 `window.api`（白名单 IPC）。
- **renderer（前端）**：`src/renderer/src/` Vue3 三栏，`stores/app.ts` 集中状态 + 订阅 main 推送事件。
- **core（纯 TS）**：不依赖 Electron，可独立测试（见下）。

## 如何运行

```bash
pnpm install          # 装依赖（含 electron 二进制）
pnpm typecheck        # 类型检查 main + renderer
pnpm build            # 构建（out/）
pnpm test:core        # 核心逻辑单测（tsx + node:test），17 项
./start.sh            # tmux 里跑 electron-vite dev（不在 CC 会话起）
```

### WSL 前置：Electron GUI 系统库

WSL/纯 Linux 首次跑 Electron 需补 GUI 依赖库（否则报 `libnss3.so: cannot open shared object file`）：

```bash
sudo apt-get install -y libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libgbm1 libgtk-3-0 libasound2t64
```

WSLg（Win11）自带显示；老 WSL 需装 X server 或用 WSLg。装完 `pnpm dev` 即可出窗口。

## 已验证（自动化）

- `pnpm typecheck` 通过；`pnpm build` 三包（main/preload/renderer）通过。
- `pnpm test:core` 12 项通过：
  - 账号池：负载均衡挑号 / 超配额不选 / 200013→cooldown→恢复 / 失效→expired / 窗口滚动清零 / 重登复活 / earliestRecovery。
  - 存储：归一化+落地+索引 / 时间转 UTC ms / 去重 / 未读计数 / 重建索引。

## 真机联调（2026-07-06，已完成关键验证 ✅）

- ✅ 扫码登录：独立分区，用户扫码登录一个号 → 关窗抓 token+cookie 入池。已登两个号（不同微信号）。
- ✅ **采集链路端到端跑通**（`scripts/probe-collect.mts` 真实验证）：
  - searchbiz 搜"特工宇宙"→ 返回 5 候选 + 正确 fakeid。
  - appmsg 拉"特工宇宙"→ 共 523 篇，第 1 页真实标题正常。
  - 账号未触发 200013，鉴权三要素有效。
- ⬜ UI 上手动搜号/加号/刷新的全流程点击验证（core 链路已证，IPC 层待点）。

## ⚠️ 待修问题（联调发现）

- **账号池明文存储**：本 WSL 环境 `safeStorage.isEncryptionAvailable()` 为 false（无 OS keychain），
  `secrets.ts` 走了明文兜底 → `wx-accounts.enc` 实为明文 JSON，含 cookie/token。
  联调期可接受（data/ 已 gitignore、本地文件），但**上线前必须修**：
  接入 keychain / DPAPI，或用用户口令派生密钥加密。已在 storage/wechat-login 安全约束中标记。

## 已知待补（非阻塞）

- **fingerprint**：登录时未强制提取，缺失时接口多数仍可用；如遇校验失败再从后台页面 JS 上下文补抓。
- **正文转换精度**：`content.ts` 是极简 HTML→md，覆盖公众号常见标签；复杂排版（表格/嵌套）可能丢失，按需增强。
- **AI 增强/简报（P2）**、**RSS adapter**、**Agent CLI 接入（agent.md）** 尚未实现。
