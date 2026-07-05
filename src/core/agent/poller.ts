// 轮询调度：定时对全部关注号做增量采集，账号间留间隔。见 docs/wechat-monitor.md。
// 定时器由 main 注入（core 不碰 Electron），这里只管"一轮怎么跑"。
import type { Source } from '../../shared/contract'
import type { Collector } from './collector'
import type { AccountPool } from './account-pool'
import { RATE_LIMIT } from './rate-limit'
import type { IngestProgress } from '../../shared/ipc'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export class Poller {
  private running = false
  private wait: (ms: number) => Promise<void>
  constructor(
    private collector: Collector,
    private pool: AccountPool,
    private opts: {
      sleep?: (ms: number) => Promise<void>
      onProgress?: (p: IngestProgress) => void
    } = {}
  ) {
    this.wait = opts.sleep ?? sleep
  }

  isRunning(): boolean {
    return this.running
  }

  /** 跑一轮：遍历全部 enabled 的号做增量。全账号不可用则中止并报等待时刻。 */
  async runOnce(sources: Source[], nextRunAt?: number): Promise<{ total: number }> {
    if (this.running) return { total: 0 }
    this.running = true
    let total = 0
    const active = sources.filter((s) => s.enabled)
    try {
      for (let i = 0; i < active.length; i++) {
        const source = active[i]
        if (!this.pool.pick()) {
          const waitingUntil = this.pool.earliestRecovery() ?? undefined
          this.opts.onProgress?.({
            phase: 'waiting_quota',
            queued: active.length - i,
            waitingUntil,
            nextRunAt
          })
          break // 无账号可用，本轮剩余留到下轮
        }
        this.opts.onProgress?.({ phase: 'polling', currentSource: source.name, queued: active.length - i, nextRunAt })
        const r = await this.collector.collectSource(source)
        if (r.status === 'ok') total += r.newArticles
        if (i < active.length - 1) await this.wait(RATE_LIMIT.accountIntervalMs)
      }
    } finally {
      this.running = false
      this.opts.onProgress?.({ phase: 'idle', queued: 0, nextRunAt })
    }
    return { total }
  }
}
