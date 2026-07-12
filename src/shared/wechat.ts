// 公众号账号池类型。cookie/token 属敏感数据，加密落盘（见 docs/wechat-login.md）。

export type WxAccountStatus = 'active' | 'cooldown' | 'expired'

export interface WxAccount {
  id: string
  nickname?: string
  token: string
  cookies: Record<string, string>
  fingerprint?: string
  partition: string // 每个号独立分区 persist:wx-<id>（不同微信号，互不覆盖）
  status: WxAccountStatus
  cooldownUntil?: number // 命中限流后恢复时刻 UTC ms
  requestsThisHour: number // 滑动窗口计数
  windowStart: number // 当前小时窗口起点 UTC ms
  totalRequests: number // 本机累计发出的微信接口请求数（包含失败/限流请求）
  lastUsedAt?: number
  lastRateLimitedAt?: number // 最近一次命中 200013 的时刻
  requestsAtLastRateLimit?: number // 命中时在当前小时窗口内的请求序号
  totalRequestsAtLastRateLimit?: number // 命中时的本机累计请求序号
}

/** 账号池对外可见的健康快照（不含敏感 cookie/token） */
export interface WxAccountView {
  id: string
  nickname?: string
  status: WxAccountStatus
  cooldownUntil?: number
  requestsThisHour: number
  hourLimit: number
  totalRequests: number
  lastRateLimitedAt?: number
  requestsAtLastRateLimit?: number
  totalRequestsAtLastRateLimit?: number
}

/** 看板可读取和修改的微信采集设置；不包含任何账号凭据。 */
export interface WechatCollectionSettings {
  hourlyRequestLimit: number
  minHourlyRequestLimit: number
  maxHourlyRequestLimit: number
  recommendedMaxHourlyRequestLimit: number
}

/** searchbiz 搜索候选 */
export interface WxSearchResult {
  fakeid: string
  nickname: string
  alias: string
  signature: string
  roundHeadImg?: string
}

/** 频率控制错误码（base_resp.ret） */
export const WX_FREQ_CONTROL_CODE = 200013

/** 采集接口调用结果的标准化返回 */
export type WxCallResult<T> =
  | { ok: true; data: T }
  | { ok: false; reason: 'freq_control' | 'expired' | 'error'; message: string }
