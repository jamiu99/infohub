// 自动采集只负责“何时触发”，不负责选择信源、配额或实际网络请求。
// 使用单次 setTimeout：每轮完成后再安排下一轮，不追赶、不重叠。

export interface AutoCollectSchedule {
  enabled: boolean
  intervalMs: number
}

export type AutoCollectSkipReason = 'busy' | 'late'

export interface AutoCollectSchedulerOptions {
  run: () => Promise<void> | void
  isBusy?: () => boolean
  now?: () => number
  /** 测试注入点；返回值只会原样传给 clearTimer。 */
  setTimer?: (callback: () => void, delayMs: number) => unknown
  clearTimer?: (timer: unknown) => void
  /** 定时器晚于计划多久后视为睡眠/休眠唤醒，不再补跑。默认 60 秒。 */
  maxLatenessMs?: number
  onScheduled?: (nextRunAt: number | undefined) => void
  onSkipped?: (reason: AutoCollectSkipReason) => void
  onError?: (error: unknown) => void
}

export class AutoCollectScheduler {
  private readonly now: () => number
  private readonly setTimer: (callback: () => void, delayMs: number) => unknown
  private readonly clearTimer: (timer: unknown) => void
  private readonly maxLatenessMs: number

  private timer: unknown | null = null
  private generation = 0
  private enabled = false
  private intervalMs = 0
  private running = false
  private stopped = false
  private plannedAt: number | undefined

  constructor(private readonly options: AutoCollectSchedulerOptions) {
    this.now = options.now ?? Date.now
    this.setTimer =
      options.setTimer ?? ((callback, delayMs) => setTimeout(callback, delayMs))
    this.clearTimer =
      options.clearTimer ??
      ((timer) => clearTimeout(timer as ReturnType<typeof setTimeout>))
    this.maxLatenessMs = options.maxLatenessMs ?? 60_000
    if (!Number.isFinite(this.maxLatenessMs) || this.maxLatenessMs < 0) {
      throw new Error('自动采集定时器允许的延迟必须是非负数')
    }
  }

  /**
   * 应用启动、启用或修改周期时调用。不会立即运行，而是等待一个完整周期。
   * stop() 是最终状态；停止后的实例不会重新启用，避免退出过程中重挂定时器。
   */
  configure(schedule: AutoCollectSchedule): void {
    if (!Number.isFinite(schedule.intervalMs) || schedule.intervalMs <= 0) {
      throw new Error('自动采集间隔必须是正数')
    }
    if (this.stopped) return

    this.generation++
    this.cancelTimer()
    this.enabled = schedule.enabled
    this.intervalMs = schedule.intervalMs
    if (this.enabled) this.scheduleFromNow(this.generation)
    else this.notifyScheduled(undefined)
  }

  /**
   * 系统从睡眠/休眠恢复时重新等待一个完整周期，明确放弃错过的轮次。
   */
  resume(): void {
    if (this.stopped || !this.enabled) return
    this.generation++
    this.cancelTimer()
    this.scheduleFromNow(this.generation)
  }

  /** 永久停止当前实例；在途 run 完成后也不会重新安排。 */
  stop(): void {
    if (this.stopped) return
    this.stopped = true
    this.enabled = false
    this.generation++
    this.cancelTimer()
    this.notifyScheduled(undefined)
  }

  nextRunAt(): number | undefined {
    return this.plannedAt
  }

  isRunning(): boolean {
    return this.running
  }

  private scheduleFromNow(generation: number): void {
    if (this.stopped || !this.enabled || generation !== this.generation) return
    this.cancelTimer()
    const plannedAt = this.now() + this.intervalMs
    this.plannedAt = plannedAt
    this.timer = this.setTimer(() => {
      void this.fire(generation, plannedAt)
    }, this.intervalMs)
    this.notifyScheduled(plannedAt)
  }

  private async fire(generation: number, plannedAt: number): Promise<void> {
    if (
      this.stopped ||
      !this.enabled ||
      generation !== this.generation ||
      plannedAt !== this.plannedAt
    ) {
      return
    }

    this.timer = null
    this.plannedAt = undefined

    // setTimeout 在系统睡眠时不会按墙钟准时执行。过度迟到即视为错过，
    // 从当前时刻重新计时，避免唤醒瞬间补抓。
    if (this.now() - plannedAt > this.maxLatenessMs) {
      this.notifySkipped('late')
      this.scheduleFromNow(generation)
      return
    }

    if (this.running || this.options.isBusy?.()) {
      this.notifySkipped('busy')
      this.scheduleFromNow(generation)
      return
    }

    this.running = true
    try {
      await this.options.run()
    } catch (error) {
      this.notifyError(error)
    } finally {
      this.running = false
      // configure/resume/stop 都会推进 generation；旧任务完成时不能覆盖新计划。
      if (!this.stopped && this.enabled && generation === this.generation) {
        this.scheduleFromNow(generation)
      }
    }
  }

  private cancelTimer(): void {
    if (this.timer !== null) this.clearTimer(this.timer)
    this.timer = null
    this.plannedAt = undefined
  }

  private notifyScheduled(nextRunAt: number | undefined): void {
    try {
      this.options.onScheduled?.(nextRunAt)
    } catch {
      // UI/状态回调不能破坏定时器生命周期。
    }
  }

  private notifySkipped(reason: AutoCollectSkipReason): void {
    try {
      this.options.onSkipped?.(reason)
    } catch {
      // 状态回调不能破坏定时器生命周期。
    }
  }

  private notifyError(error: unknown): void {
    try {
      this.options.onError?.(error)
    } catch {
      // 错误展示回调本身失败时，仍需继续下一轮调度。
    }
  }
}
