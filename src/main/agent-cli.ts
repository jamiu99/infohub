// Claude Code CLI 驱动（stream-json）。见 docs/agent.md。
// 平台探测：Linux/Mac 直跑 `claude`；Windows 走 `wsl.exe -- claude` + 路径映射。
//
// ⚠️ 状态：探索性实现，本机已跑通（claude -p → stream-json → 解析出结果），
//    但【集成方式待调研确认】：stream-json 事件结构、Agent SDK vs spawn、
//    计费/配额、第三方封禁风险、权限模式，均在调研中，结论落定前【不接入主流程】。
//    见 docs/agent.md 的调研笔记。
import { spawn } from 'node:child_process'
import type { AgentCLI, AgentRunOptions, AgentResult, AgentEvent } from '../core/agent/cli-types'

/** Windows 路径 C:\x → WSL 路径 /mnt/c/x（cwd 传给 wsl 内的 claude 时用） */
export function winToWslPath(p: string): string {
  const m = p.match(/^([A-Za-z]):\\(.*)$/)
  if (!m) return p
  return `/mnt/${m[1].toLowerCase()}/${m[2].replace(/\\/g, '/')}`
}

interface Launcher {
  cmd: string
  baseArgs: string[]
  mapCwd: (p: string) => string
}

/** 按平台决定怎么起 claude */
function resolveLauncher(): Launcher {
  if (process.platform === 'win32') {
    // Windows 上 claude 跑在 WSL 内
    return { cmd: 'wsl.exe', baseArgs: ['--', 'claude'], mapCwd: winToWslPath }
  }
  return { cmd: 'claude', baseArgs: [], mapCwd: (p) => p }
}

export class ClaudeCli implements AgentCLI {
  name = 'claude'
  private launcher = resolveLauncher()

  async available(): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn(this.launcher.cmd, [...this.launcher.baseArgs, '--version'], {
        stdio: 'ignore'
      })
      child.on('error', () => resolve(false))
      child.on('close', (code) => resolve(code === 0))
    })
  }

  runTask(prompt: string, opts: AgentRunOptions): Promise<AgentResult> {
    const args = [
      ...this.launcher.baseArgs,
      '-p',
      prompt,
      '--output-format',
      'stream-json',
      '--verbose'
    ]
    return new Promise((resolve) => {
      const child = spawn(this.launcher.cmd, args, {
        cwd: process.platform === 'win32' ? undefined : opts.cwd,
        env: { ...process.env }
      })

      let buf = ''
      let resultText = ''
      let errText = ''
      const timer = opts.timeoutMs
        ? setTimeout(() => {
            child.kill()
            resolve({ ok: false, text: resultText, error: 'timeout' })
          }, opts.timeoutMs)
        : null

      child.stdout.on('data', (chunk: Buffer) => {
        buf += chunk.toString()
        let nl: number
        while ((nl = buf.indexOf('\n')) !== -1) {
          const line = buf.slice(0, nl).trim()
          buf = buf.slice(nl + 1)
          if (!line) continue
          const ev = parseStreamLine(line)
          if (ev) {
            if (ev.type === 'result' && ev.text) resultText = ev.text
            else if (ev.type === 'assistant' && ev.text) resultText += ev.text
            opts.onEvent?.(ev)
          }
        }
      })
      child.stderr.on('data', (c: Buffer) => (errText += c.toString()))
      child.on('error', (e) => {
        if (timer) clearTimeout(timer)
        resolve({ ok: false, text: '', error: e.message })
      })
      child.on('close', (code) => {
        if (timer) clearTimeout(timer)
        resolve({
          ok: code === 0,
          text: resultText.trim(),
          error: code === 0 ? undefined : errText.trim() || `exit ${code}`
        })
      })
    })
  }
}

/** 解析一行 stream-json 事件 */
export function parseStreamLine(line: string): AgentEvent | null {
  let obj: Record<string, unknown>
  try {
    obj = JSON.parse(line)
  } catch {
    return null
  }
  const type = obj.type as string
  if (type === 'result') {
    return { type: 'result', text: String(obj.result ?? ''), raw: obj }
  }
  if (type === 'assistant') {
    // assistant 消息里 content 是数组，取 text 块
    const msg = obj.message as { content?: Array<{ type: string; text?: string }> } | undefined
    const text = (msg?.content ?? [])
      .filter((c) => c.type === 'text')
      .map((c) => c.text ?? '')
      .join('')
    return { type: 'assistant', text, raw: obj }
  }
  if (type === 'error') return { type: 'error', text: String(obj.error ?? ''), raw: obj }
  return { type: 'partial', raw: obj }
}
