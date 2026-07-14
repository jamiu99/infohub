// 微信后台认证接口的全局请求间隔门。
// 即使搜索与多 source 采集由不同调用方同时触发，请求开始时间也不会形成突发。

export interface WechatRequestGateOptions {
  intervalMs: number
  now?: () => number
  sleep?: (delayMs: number) => Promise<void>
}

export class WechatRequestGate {
  private readonly now: () => number
  private readonly sleep: (delayMs: number) => Promise<void>
  private chain: Promise<void> = Promise.resolve()
  private lastCompletedAt: number | null = null

  constructor(private readonly options: WechatRequestGateOptions) {
    if (!Number.isFinite(options.intervalMs) || options.intervalMs < 0) {
      throw new Error('微信请求间隔必须是非负数')
    }
    this.now = options.now ?? Date.now
    this.sleep =
      options.sleep ??
      ((delayMs) => new Promise((resolve) => setTimeout(resolve, delayMs)))
  }

  /**
   * 排队执行一个需要微信后台登录态的请求。
   * minIntervalBeforeMs 可在换号重试时临时提高到更保守的间隔。
   */
  run<T>(request: () => Promise<T> | T, minIntervalBeforeMs = this.options.intervalMs): Promise<T> {
    if (!Number.isFinite(minIntervalBeforeMs) || minIntervalBeforeMs < 0) {
      return Promise.reject(new Error('微信请求间隔必须是非负数'))
    }

    const execute = async (): Promise<T> => {
      if (this.lastCompletedAt !== null) {
        const waitMs = Math.max(0, this.lastCompletedAt + minIntervalBeforeMs - this.now())
        if (waitMs > 0) await this.sleep(waitMs)
      }
      try {
        return await request()
      } finally {
        // 与旧版“请求完成后 sleep”语义一致，比只控制开始时间更保守。
        this.lastCompletedAt = this.now()
      }
    }

    const result = this.chain.then(execute, execute)
    // 请求失败不能污染队列；后续请求仍需遵守与失败请求之间的间隔。
    this.chain = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}
