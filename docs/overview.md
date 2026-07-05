# infohub — 总览与进度主文件

> 本文件是 infohub 的**唯一进度入口**。所有子文档从这里派生，改任何模块都要回来更新对应状态行。
> 铁律：**代码和文档同步更新，禁止版本分离**。每完成一个可验证的点，就在这里勾掉并链到细节。

最后更新：2026-07-06 · 阶段：**P1 公众号监控核心链路已实现**（typecheck/build/12 项测试通过，待真机扫码联调）

---

## 1. 一句话定位

本地 Electron App，采集微信公众号/RSS 等信源到本地 → 二次处理成统一结构 → 文件为源 + SQLite 索引归档 → 接入 AI CLI 产出简报/知识库。

## 2. 关键技术决策（已锁定）

| 决策 | 选型 | 理由 | 细节 |
|------|------|------|------|
| 桌面框架 | **Electron** | JS/TS 生态、Node 子进程、BrowserWindow 内嵌官方登录页抓 cookie 最顺 | [architecture.md](architecture.md) |
| 采集层语言 | **Node/TS** | 全栈统一 TS，无跨语言进程通信 | [ingest.md](ingest.md) |
| 存储 | **文件为源 + SQLite 索引** | 数据即文件，通用 agent 可直接读目录；SQLite 只做索引/检索/去重/状态 | [storage.md](storage.md) |
| 公众号登录 | **内嵌 BrowserWindow 扫码** | 不模拟登录接口、不碰验证码风控；扫完从 session 抓 cookie+token | [wechat-login.md](wechat-login.md) |
| AI 底座 | **接入外部 Agent CLI**（Claude Code / Codex） | 不自造 agent loop；通过 PTY/stream-json 驱动，数据即文件天然可被 agent 操作 | [agent.md](agent.md) |

## 3. 模块拆分（彻底解耦，各自独立）

数据在模块间只通过**统一契约 + 文件**流动，任一模块可单独替换/测试。

```
信源 ──▶ [ingest 采集]  原始抓取（公众号爬虫 / RSS / 未来 adapter）
              │  产出 RawItem（原始载荷，未清洗）
              ▼
        [process 处理]  清洗 / AI 二次转写 / 打分 / 溯源 / 老化判断
              │  产出 Article（统一结构：标题/正文/时间/来源URL/…/可拓展字段）
              ▼
        [store 存储]    文件为源（md+json）+ SQLite 索引
              │
              ▼
        [agent AI 基建]  Claude Code / Codex CLI 在数据目录上工作 → 简报/知识库
```

各模块契约见 [contract.md](contract.md)。

## 4. 进度看板

图例：⬜ 未开始 · 🟡 进行中 · ✅ 完成 · ⏸ 暂缓

### P0 — Agent 框架 + 信源契约
- ✅ 项目骨架 + 文档体系（electron-vite + Vue3 + TS，typecheck/build 通过）
- ✅ 数据契约锁定（RawItem / Article / Source）→ `src/shared/contract.ts` · [contract.md](contract.md)
- ✅ ingest 接口 + wechat adapter → `src/core/ingest/` · [ingest.md](ingest.md)
- ✅ store 落地（文件布局 + SQLite schema，往返测试通过） → `src/core/store/` · [storage.md](storage.md)
- 🟡 Agent CLI 接入：探索性实现已本机跑通（`src/main/agent-cli.ts`），但**集成方式调研中，未接入主流程** → [agent.md](agent.md)
- ⬜ RSS adapter（P0 原定链路，公众号优先，暂缓）

### P1 — 公众号监控（★ 当前主线，几十个号量级）
产品形态/UI/UX/调度见 [wechat-monitor.md](wechat-monitor.md)。**核心链路已实现并通过 12 项测试。**
- ✅ 扫码登录 BrowserWindow + cookie/token 抓取 → `src/main/wechat-login.ts` · [wechat-login.md](wechat-login.md)
- ✅ 采集核心：searchbiz + appmsg，复用 refs 接口 → `src/core/ingest/wechat.ts` · [ingest.md](ingest.md#微信公众号)
- ✅ 多账号池 + 配额/限流调度器（200013，轮换/冷却/窗口滚动） → `src/core/agent/account-pool.ts`
- ✅ 关注列表 + 手动刷新（**已关闭自动轮询**，见下安全约束） → `src/main/service.ts`
- ✅ 三栏监控 UI（源列表/文章流/详情） → `src/renderer/src/components/`
- ✅ 配额可视化 + 登录失效引导 UX → `QuotaPanel.vue`
- ✅ cookie 失效状态机 + 扫码引导 → account-pool + relogin IPC
- ✅ 正文抓取（抓 link 页面 → #js_content → markdown） → `src/core/process/content.ts`
- ✅ **安全加固**：关自动轮询（纯手动）+ 采集全局串行锁 + 频率压到极保守（20/时·10s 间隔·单次1页）
- 🟡 真机联调：已扫 1 个账号（成功落盘）；搜号/采集待验证。**联调期禁止并发、禁止拿真号压测**
- ⬜ **多账号切换 bug**：用户反馈"有些账号要先登进去点切换才能换号"——调研中，见 [wechat-login.md](wechat-login.md)

### 安全约束（应 jamiu 要求，硬性）
- **默认不自动采集**：无定时轮询，只在用户手动点刷新时发请求。
- **全局串行**：`Collector` 有互斥锁，任何时刻只有一个 wechat 请求链，UI 连点也排队。
- **极保守频率**：联调期 `rate-limit.ts` 压到远低于实测上限，保护真实账号。

### P2 — 简报
- ⬜ 入库 pipeline（清洗/摘要/打分） → [process.md](process.md)
- ⬜ 每日简报生成 + 系统通知

### P3 — 知识库 / Wiki
- ⬜ 全文检索（SQLite FTS5）+ 向量检索
- ⬜ 实体抽取 / 关联 / 对话式查询

### P4 — 开发者模式 / AI 自我修改（Beta）
- ⬜ 沙盒 + AI 生成 SourceAdapter 流程 → [agent.md](agent.md#ai-自我修改受控)

## 5. 文档地图

| 文档 | 讲什么 |
|------|--------|
| [architecture.md](architecture.md) | 整体架构、进程模型、目录布局、模块边界 |
| [contract.md](contract.md) | 数据契约：RawItem / Article / Source 字段定义 |
| [ingest.md](ingest.md) | 采集层：adapter 接口、公众号接口、RSS |
| [wechat-monitor.md](wechat-monitor.md) | ★ 公众号监控：产品形态、三栏 UI/UX、轮询调度 |
| [wechat-login.md](wechat-login.md) | 扫码登录、cookie/token 抓取、多账号、限流 |
| [process.md](process.md) | 处理层：清洗、AI 转写、打分、溯源、老化 |
| [storage.md](storage.md) | 存储：文件布局 + SQLite 索引 schema |
| [agent.md](agent.md) | AI 基建：CLI 集成、stream-json、自我修改约束 |
| [decisions.md](decisions.md) | 决策日志（ADR）：为什么这么选 |
| [dev-log.md](dev-log.md) | 开发日志 & 代码地图（文档↔实现映射、如何运行/测试） |

## 6. 未决待定项

- AI Provider 抽象层：云端 Claude 为主，是否支持本地模型？
- 多设备同步：是否做（影响存储方案）
- 是否开源（影响公众号采集合规策略）
- 简报推送渠道：应用内 / 邮件 / Telegram / 系统通知
