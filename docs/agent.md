# AI 基建（agent）

> 上级：[overview.md](overview.md) · 相关背景见交接简报「四、技术背景」

职责：接入外部 Agent CLI（Claude Code / Codex / …），让 AI 在**数据目录**上工作，产出简报/知识库，并（受控地）自我升级。

## 核心思路：不自造 agent loop

复用成熟 CLI 的 agent 能力，我们只做"驱动 + 喂数据 + 收结果"。因为 [storage](storage.md) 是**文件为源**，`data/articles/` 就是普通 markdown 目录——任何通用 agent 在这个目录下 `cd` 进去就能 `grep`/读/写，天然可用。这是模块彻底解耦带来的红利。

## 集成方式（两种，组合用）

参考社区主流（见交接简报）：

| 方式 | 用途 | 技术 |
|------|------|------|
| **stream-json** | 结构化任务（简报生成、批量摘要），UI 渲染卡片 | `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages` |
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
