// Agent CLI 抽象类型。见 docs/agent.md。core 只定义契约，具体进程驱动在 main（需 child_process）。

/** stream-json 协议里 CLI 吐出的事件（简化，够 UI 渲染卡片用） */
export interface AgentEvent {
  type: 'assistant' | 'tool_use' | 'result' | 'error' | 'partial'
  text?: string
  raw?: unknown
}

export interface AgentRunOptions {
  cwd: string // 通常指向 data/ 或某子目录 —— 数据即文件，agent 直接读目录
  stream?: boolean
  onEvent?: (e: AgentEvent) => void
  timeoutMs?: number
}

export interface AgentResult {
  ok: boolean
  text: string // 最终结果文本（result 事件汇总）
  error?: string
}

export interface AgentCLI {
  name: string // 'claude' | 'codex'
  /** 探测该 CLI 是否可用 */
  available(): Promise<boolean>
  runTask(prompt: string, opts: AgentRunOptions): Promise<AgentResult>
}
