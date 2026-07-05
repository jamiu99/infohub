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
pnpm test:core        # 核心逻辑单测（tsx + node:test），12 项
./start.sh            # tmux 里跑 electron-vite dev（不在 CC 会话起）
```

## 已验证（自动化）

- `pnpm typecheck` 通过；`pnpm build` 三包（main/preload/renderer）通过。
- `pnpm test:core` 12 项通过：
  - 账号池：负载均衡挑号 / 超配额不选 / 200013→cooldown→恢复 / 失效→expired / 窗口滚动清零 / 重登复活 / earliestRecovery。
  - 存储：归一化+落地+索引 / 时间转 UTC ms / 去重 / 未读计数 / 重建索引。

## 待真机联调（需人工扫码，CC 无法自动完成）

1. `pnpm dev` 起 App → 点扫码登录 → 手机扫码 → 确认能抓到 cookie+token 存入账号池。
2. 加公众号（searchbiz 真实返回）→ 自动采集 → 文章流出现文章。
3. 观察配额条随请求增长、限流时 cooldown 显示。

> 扫码/真实接口依赖登录态与网络，无法在无人值守下验证；代码路径已就绪，联调是下一步。

## 已知待补（非阻塞）

- **fingerprint**：登录时未强制提取，缺失时接口多数仍可用；如遇校验失败再从后台页面 JS 上下文补抓。
- **正文转换精度**：`content.ts` 是极简 HTML→md，覆盖公众号常见标签；复杂排版（表格/嵌套）可能丢失，按需增强。
- **AI 增强/简报（P2）**、**RSS adapter**、**Agent CLI 接入（agent.md）** 尚未实现。
