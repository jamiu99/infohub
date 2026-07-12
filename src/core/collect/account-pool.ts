// 账号池 + 限流调度。多账号轮换分摊单账号每小时配额。见 docs/wechat-login.md。
// 纯内存状态管理 + 持久化回调，不依赖 Electron（可独立测试）。
import type { WxAccount, WxAccountView, WxCallResult } from '../../shared/wechat'
import { RATE_LIMIT, validateWechatHourlyLimit } from './rate-limit'

const HOUR = 60 * 60 * 1000

export interface AccountPoolOptions {
  now?: () => number // 可注入时钟（测试用）
  hourLimit?: number // 每账号每小时上限；默认 20，可由持久化设置覆盖
  persist?: (accounts: WxAccount[]) => void // 状态变更时落盘
  onChange?: () => void // 通知 UI 刷新
}

export class AccountPool {
  private accounts: WxAccount[] = []
  private now: () => number
  private hourLimit: number
  private persist?: (a: WxAccount[]) => void
  private onChange?: () => void

  constructor(initial: WxAccount[], opts: AccountPoolOptions = {}) {
    // 兼容升级前的账号文件：旧记录没有累计请求字段，以当前窗口计数作为起点。
    this.accounts = initial.map((a) => ({
      ...a,
      totalRequests: Number.isInteger(a.totalRequests) ? a.totalRequests : a.requestsThisHour
    }))
    this.now = opts.now ?? Date.now
    this.hourLimit = validateWechatHourlyLimit(opts.hourLimit ?? RATE_LIMIT.hourLimit)
    this.persist = opts.persist
    this.onChange = opts.onChange
  }

  list(): WxAccount[] {
    return this.accounts
  }

  /** 对外健康快照（脱敏，不含 cookie/token） */
  views(): WxAccountView[] {
    this.refreshWindows()
    return this.accounts.map((a) => ({
      id: a.id,
      nickname: a.nickname,
      status: a.status,
      cooldownUntil: a.cooldownUntil,
      requestsThisHour: a.requestsThisHour,
      hourLimit: this.hourLimit,
      totalRequests: a.totalRequests,
      lastRateLimitedAt: a.lastRateLimitedAt,
      requestsAtLastRateLimit: a.requestsAtLastRateLimit,
      totalRequestsAtLastRateLimit: a.totalRequestsAtLastRateLimit
    }))
  }

  /** 设置新的全局单账号小时上限；当前窗口计数不清零，防止借改配置绕过配额。 */
  setHourLimit(value: number): void {
    const normalized = validateWechatHourlyLimit(value)
    if (normalized === this.hourLimit) return
    this.hourLimit = normalized
    this.onChange?.()
  }

  add(account: WxAccount): void {
    const i = this.accounts.findIndex((a) => a.id === account.id)
    if (i >= 0) this.accounts[i] = account
    else this.accounts.push(account)
    this.flush()
  }

  remove(id: string): void {
    this.accounts = this.accounts.filter((a) => a.id !== id)
    this.flush()
  }

  get(id: string): WxAccount | undefined {
    return this.accounts.find((a) => a.id === id)
  }

  /** 冷却到期 → 恢复 active；小时窗口滚动 → 计数清零 */
  private refreshWindows(): void {
    const t = this.now()
    let changed = false
    for (const a of this.accounts) {
      if (a.status === 'cooldown' && a.cooldownUntil && t >= a.cooldownUntil) {
        a.status = 'active'
        a.cooldownUntil = undefined
        changed = true
      }
      if (t - a.windowStart >= HOUR) {
        a.windowStart = t
        a.requestsThisHour = 0
        changed = true
      }
    }
    if (changed) this.flush()
  }

  /** 挑一个可用账号：active 且未超小时配额，优先用得最少的（负载均衡） */
  pick(): WxAccount | null {
    this.refreshWindows()
    const usable = this.accounts
      .filter((a) => a.status === 'active' && a.requestsThisHour < this.hourLimit)
      .sort((a, b) => a.requestsThisHour - b.requestsThisHour)
    return usable[0] ?? null
  }

  /** 全账号都不可用时，返回最早恢复时刻（供 UI 显示"等待配额恢复至"） */
  earliestRecovery(): number | null {
    this.refreshWindows()
    const times: number[] = []
    for (const a of this.accounts) {
      if (a.status === 'active' && a.requestsThisHour < this.hourLimit) return this.now()
      if (a.status === 'cooldown' && a.cooldownUntil) times.push(a.cooldownUntil)
      if (a.status === 'active') times.push(a.windowStart + HOUR) // 满配额，等下个窗口
    }
    return times.length ? Math.min(...times) : null
  }

  /** 记一次已经发出的请求（无论上游结果如何，计数 +1）。 */
  noteRequest(id: string): void {
    const a = this.get(id)
    if (!a) return
    a.requestsThisHour++
    a.totalRequests++
    a.lastUsedAt = this.now()
    this.flush()
  }

  /** 根据接口返回结果更新账号状态。返回是否应换号重试。 */
  handleResult(id: string, result: WxCallResult<unknown>): { retry: boolean } {
    const a = this.get(id)
    if (!a) return { retry: false }
    if (result.ok) return { retry: false }
    if (result.reason === 'freq_control') {
      a.status = 'cooldown'
      const now = this.now()
      a.cooldownUntil = now + RATE_LIMIT.cooldownMs
      a.lastRateLimitedAt = now
      a.requestsAtLastRateLimit = a.requestsThisHour
      a.totalRequestsAtLastRateLimit = a.totalRequests
      this.flush()
      return { retry: true } // 换下一个账号
    }
    if (result.reason === 'expired') {
      a.status = 'expired'
      this.flush()
      return { retry: true }
    }
    return { retry: false } // 普通错误不换号
  }

  /** 扫码重登后刷新凭证并复活 */
  refreshCredentials(id: string, patch: Partial<WxAccount>): void {
    const a = this.get(id)
    if (!a) return
    Object.assign(a, patch, { status: 'active', cooldownUntil: undefined })
    this.flush()
  }

  private flush(): void {
    this.persist?.(this.accounts)
    this.onChange?.()
  }
}
