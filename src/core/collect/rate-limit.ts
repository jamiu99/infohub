// 采集限流参数。默认值保持极保守；小时上限可由用户在看板中调整并持久化。
// refs 曾观察到约 50/时，但这不是稳定接口承诺，超过该值时 UI 会明确提示风险。
export const WECHAT_HOURLY_LIMIT = {
  default: 20,
  min: 1,
  max: 1000,
  recommendedMax: 50
} as const

export const RATE_LIMIT = {
  hourLimit: WECHAT_HOURLY_LIMIT.default, // 兼容默认值；运行时由 settings.json 覆盖
  requestIntervalMs: 10_000, // 同账号连续请求间隔（拉长到 10s）
  accountIntervalMs: 15_000, // 换账号间隔
  cooldownMs: 2 * 60 * 60 * 1000, // 命中 200013 冷却 2 小时
  incrementalMaxPages: 1, // 联调期单号单次只拉 1 页（尽量少碰接口）
  historyMaxPages: 20, // 历史抓取最大页数（暂不用）
  pageSize: 10
} as const

export function validateWechatHourlyLimit(value: unknown): number {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    value < WECHAT_HOURLY_LIMIT.min ||
    value > WECHAT_HOURLY_LIMIT.max
  ) {
    throw new Error(
      `每账号每小时上限必须是 ${WECHAT_HOURLY_LIMIT.min}–${WECHAT_HOURLY_LIMIT.max} 的整数`
    )
  }
  return value
}
