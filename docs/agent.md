# AI 基建（agent）

> 上级：[overview.md](overview.md) · 相关背景见交接简报「四、技术背景」

职责：接入外部 Agent CLI（Claude Code / Codex / …），让 AI 在**数据目录**上工作，产出简报/知识库，并（受控地）自我升级。

## 核心思路：不自造 agent loop

复用成熟 CLI 的 agent 能力，我们只做"驱动 + 喂数据 + 收结果"。因为 [storage](storage.md) 是**文件为源**，`data/articles/` 就是普通 markdown 目录——任何通用 agent 在这个目录下 `cd` 进去就能 `grep`/读/写，天然可用。这是模块彻底解耦带来的红利。

## ✅ 实测定稿（2026-07-06，以此为准）

> 两轮调研有互相矛盾处，且部分被本机实测推翻。**最终以实测为准**：
>
> **决定：主接入走 spawn `claude -p --output-format json`，不走 SDK / 不配 API key。**
>
> 实测事实（在本机 `claude` 2.1.201、**未设 ANTHROPIC_API_KEY**）：
> - `claude -p "读当前目录 .md 生成简报" --output-format json`（cwd=数据目录）**直接跑通**，
>   自主 Read 文件、产出简报，`.result` 即最终文本，`stop_reason: end_turn`。
> - **复用本机 CLI 登录态（订阅版），用户零配置、无需 API key** —— 这是选 spawn 而非 SDK 的决定性理由。
> - 返回 JSON 含 `total_cost_usd` / `usage`，成本可读。用的是 `claude-opus-4-8`。
>
> 为何不用 `@anthropic-ai/claude-agent-sdk`：SDK 走 `ANTHROPIC_API_KEY` 按 token 计费，
> 要用户单独配 key、数据/计费走 API 通道；而 spawn CLI 复用现成登录态，对本地个人工具最省心。
> SDK 作为未来可选（若要同进程/类型安全再切）。
>
> stream-json 解析那套（NDJSON/text_delta 累积）仅在需要**流式 UI**时才用；简报是一次性产物，
> 用 `--output-format json` 取 `.result` 最简单，**无需累积 delta**。

## 📋 调研结论（官方文档，部分已被上方实测修正）

上网调研（官方文档）后的关键结论，**修正了初版探索代码的多处错误假设**：

1. **优先用 Agent SDK，不要 spawn CLI 解析 stdout**。官方有 `@anthropic-ai/claude-agent-sdk`（Node/TS），可直接在 Electron main 进程 `import { query }` 使用：同进程、类型安全、无 IPC/解析开销、权限可编程。spawn `claude -p` 仅适合简单一次性任务。
   → **决定：主接入走 Agent SDK；`src/main/agent-cli.ts`（spawn 版）降级为备用/降级路径。**
2. **stream-json 解析：初版假设错了**。不是 `result.result` 直接给最终文本。实际是 NDJSON，外层 `{type:"stream_event", event:{...}}` 包 Claude API 原始事件；文本要累积 `content_block_delta` 里 `delta.type==="text_delta"` 的 `delta.text`。若只要最终结果，用 `--output-format json`（非 stream）取 `.result` 更简单。
3. **权限（无人值守关键）**：用 `allowedTools` 白名单 + `permissionMode: "acceptEdits"`，或 `PreToolUse` hook 细粒度拦截（如只允许读 `.md`）。**避免** `--dangerously-skip-permissions`。
4. **合规**：spawn CLI 和用官方 SDK 都是官方支持用途，不算"第三方包装器"。红线：不伪装成 Claude Code、不改 system prompt 隐藏代理身份、UI 标注 "Powered by Claude" 即可。
5. **计费（待用户验证）**：调研未在官方定价文档找到"独立 Agent SDK 月度额度"的明确说法。设 `ANTHROPIC_API_KEY` 走标准 API 按 token 计费。→ **需在 console.anthropic.com/usage 实测确认**。
6. **cwd**：SDK `options.cwd` 或 spawn `cwd` 指向数据目录即可，Claude 自动获该目录读权限；多目录用 `additionalDirectories`。

**接入计划**：装 `@anthropic-ai/claude-agent-sdk` → 实现 SDK 版 `AgentCLI.runTask`（`cwd`=data/、`allowedTools` 白名单、`acceptEdits`）→ 简报（P2）作为首个消费者。当前**尚未接入主流程**，`agent-cli.ts` 是探索性备用实现。

## 集成方式（按调研结论，SDK 优先）

| 方式 | 用途 | 技术 |
|------|------|------|
| **Agent SDK**（首选） | 结构化任务（简报、批量摘要），Electron main 内直接调 | `@anthropic-ai/claude-agent-sdk` 的 `query({prompt, options:{cwd, allowedTools, permissionMode}})` |
| **spawn CLI**（备用） | 简单一次性、或 SDK 不可用时降级 | `claude -p ... --output-format json`（取 `.result`）；见 `src/main/agent-cli.ts` |
| **node-pty + xterm.js** | 交互式终端（开发者模式、自由对话） | `node-pty` 起 CLI 进程，前端 `xterm.js` |

### WSL / Windows 现实（重要）

- Windows 上没有原生 claude CLI，本质是 **WSL 里跑 CLI**。
- App 跑 Windows 侧，通过 PTY 起 `wsl.exe -- claude ...` 子进程。
- 注意 Windows 路径 `\\wsl.localhost\...` ↔ WSL 路径 `/home/...` 双向映射。
- Linux/Mac 直接起 `claude` 即可。启动器需探测平台选择命令。

### 计费注意

- 2026-06-15 起 `claude -p` / Agent SDK 走**独立 Agent SDK 月度配额**，与交互式订阅额度分开。
- 设 `ANTHROPIC_API_KEY` 会触发 API 计费；Anthropic 会用 system prompt 匹配封第三方包装器——集成时勿伪装、遵守条款。

## AgentCLI 抽象

```ts
interface AgentCLI {
  name: string;                          // 'claude' | 'codex'
  runTask(prompt: string, opts: {
    cwd: string;                         // 通常指向 data/ 或某子目录
    stream?: boolean;
    onEvent?: (e: AgentEvent) => void;   // stream-json 事件回调
  }): Promise<AgentResult>;
}
```

Provider 抽象层是否支持本地模型 = 未决项（见 [overview.md](overview.md#6-未决待定项)）。

## AI 自我修改（受控，Beta / P4）

允许 AI 改**特定模块**代码实现自我升级——典型场景：让 AI 写新信源的 `SourceAdapter`（见 [ingest.md](ingest.md#未来信源ai-写-adapter)）。约束：

1. **不影响全局稳定性**：只允许改白名单模块（如 `src/core/ingest/adapters/`），核心契约/存储不可动。
2. **沙盒隔离**：在隔离环境生成 + 测试 adapter，通过契约校验（能产出合法 `RawItem`）才纳入。
3. **仅极客玩家**：藏在 Beta 实验功能 / 开发者工具里，普通用户走 GitHub Issue 反馈，不碰这个。
4. **可回滚**：改动走 git，能 diff、能撤。
