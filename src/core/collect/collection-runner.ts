// 批次级采集互斥：把“刷新全部”的多个 source 视为一个任务。
// Collector 仍保留单 source 全局锁，Runner 负责阻止重复批次和统一进度。
import type { Source } from '../../shared/contract'
import type { CollectResult } from './collector'

export type CollectionRunOrigin = 'manual' | 'automatic' | 'initial'

export interface CollectionRunnerProgress {
  phase: 'polling' | 'idle'
  origin: CollectionRunOrigin
  currentSource?: string
  /** 包含当前 source 在内的待处理数量。 */
  queued: number
}

export interface CollectionSourceResult {
  source: Source
  result: CollectResult
}

export interface CollectionBatchResult {
  origin: CollectionRunOrigin
  status: 'completed' | 'skipped_busy'
  results: CollectionSourceResult[]
  /** 因前一个微信 source 返回 no_account 而在本轮跳过的微信 source。 */
  skippedSourceIds: string[]
  metadataErrors: Array<{ sourceId: string; message: string }>
}

export interface CollectionRunnerOptions {
  listSources: () => Source[]
  collectSource: (source: Source) => Promise<CollectResult>
  /** 优雅退出时只等当前 source 完成，不再启动批次中的下一项。 */
  shouldStop?: () => boolean
  /** status=ok 后更新持久化的 lastFetchedAt。 */
  markFetchedAt?: (sourceId: string, fetchedAt: number) => Promise<void> | void
  now?: () => number
  onProgress?: (progress: CollectionRunnerProgress) => void
  onError?: (error: unknown, source: Source) => void
}

function oldestFirst(a: Source, b: Source): number {
  const byTime = (a.lastFetchedAt ?? 0) - (b.lastFetchedAt ?? 0)
  return byTime || a.id.localeCompare(b.id)
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.trim()
  if (typeof error === 'string' && error.trim()) return error.trim()
  return '未知错误'
}

export class CollectionRunner {
  private running = false
  private idleWaiters = new Set<() => void>()
  private readonly now: () => number

  constructor(private readonly options: CollectionRunnerOptions) {
    this.now = options.now ?? Date.now
  }

  isBusy(): boolean {
    return this.running
  }

  /** 等待当前整批 source（含元数据写入）结束；资料库迁移/退出前使用。 */
  waitForIdle(): Promise<void> {
    if (!this.running) return Promise.resolve()
    return new Promise((resolve) => this.idleWaiters.add(resolve))
  }

  /** 手动刷新单个 source；不传 id 时刷新全部 enabled source。 */
  runManual(sourceId?: string): Promise<CollectionBatchResult> {
    return this.runBatch('manual', sourceId)
  }

  /** 自动轮次只处理 enabled source，并按最久未采集优先。 */
  runAutomatic(): Promise<CollectionBatchResult> {
    return this.runBatch('automatic')
  }

  /** 新增 source 后的首次采集；即使 source 后续被标为 disabled，也只按 id 精确选择。 */
  runInitial(sourceId: string): Promise<CollectionBatchResult> {
    return this.runBatch('initial', sourceId)
  }

  /**
   * 新增 source 不能因为另一个批次恰好在运行就永久漏掉首次采集。
   * 等当前批次结束后重试；退出时由 shouldStop 取消等待，不再启动新请求。
   */
  async runInitialWhenIdle(sourceId: string): Promise<CollectionBatchResult> {
    while (!this.options.shouldStop?.()) {
      const result = await this.runInitial(sourceId)
      if (result.status !== 'skipped_busy') return result
      await this.waitForIdle()
    }
    return {
      origin: 'initial',
      status: 'skipped_busy',
      results: [],
      skippedSourceIds: [],
      metadataErrors: []
    }
  }

  private async runBatch(
    origin: CollectionRunOrigin,
    sourceId?: string
  ): Promise<CollectionBatchResult> {
    // JS 在第一次 await 前同步执行，因此并发调用只会有一个批次取得锁。
    if (this.running) {
      return {
        origin,
        status: 'skipped_busy',
        results: [],
        skippedSourceIds: [],
        metadataErrors: []
      }
    }
    this.running = true

    const results: CollectionSourceResult[] = []
    const skippedSourceIds: string[] = []
    const metadataErrors: Array<{ sourceId: string; message: string }> = []

    try {
      const sources = this.options.listSources()
      const targets = sourceId
        ? sources.filter((source) => source.id === sourceId)
        : sources.filter((source) => source.enabled)
      if (origin === 'automatic') targets.sort(oldestFirst)

      let skipRemainingWechat = false
      for (let index = 0; index < targets.length; index++) {
        if (this.options.shouldStop?.()) break
        const source = targets[index]
        if (skipRemainingWechat && source.type === 'wechat') {
          skippedSourceIds.push(source.id)
          continue
        }

        this.notifyProgress({
          phase: 'polling',
          origin,
          currentSource: source.name,
          queued: skipRemainingWechat
            ? targets.slice(index).filter((item) => item.type !== 'wechat').length
            : targets.length - index
        })

        let result: CollectResult
        try {
          result = await this.options.collectSource(source)
        } catch (error) {
          this.notifyError(error, source)
          result = {
            sourceId: source.id,
            newArticles: 0,
            updatedArticles: 0,
            status: 'error',
            message: `采集失败：${errorMessage(error)}`
          }
        }
        results.push({ source, result })

        if (result.status === 'ok' && this.options.markFetchedAt) {
          try {
            await this.options.markFetchedAt(source.id, this.now())
          } catch (error) {
            metadataErrors.push({ sourceId: source.id, message: errorMessage(error) })
            this.notifyError(error, source)
          }
        }

        if (source.type === 'wechat' && result.status === 'no_account') {
          skipRemainingWechat = true
        }
      }

      return {
        origin,
        status: 'completed',
        results,
        skippedSourceIds,
        metadataErrors
      }
    } finally {
      this.running = false
      for (const resolve of this.idleWaiters) resolve()
      this.idleWaiters.clear()
      this.notifyProgress({ phase: 'idle', origin, queued: 0 })
    }
  }

  private notifyProgress(progress: CollectionRunnerProgress): void {
    try {
      this.options.onProgress?.(progress)
    } catch {
      // UI 进度回调不能破坏采集批次。
    }
  }

  private notifyError(error: unknown, source: Source): void {
    try {
      this.options.onError?.(error, source)
    } catch {
      // 日志/状态回调不能破坏其余 source 的采集。
    }
  }
}
