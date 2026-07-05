// 限流参数。采纳 refs 实测值（rate_limit_config.py）。见 docs/wechat-login.md。
export const RATE_LIMIT = {
  hourLimit: 50, // 每账号每小时最大请求数（保守可调 30）
  requestIntervalMs: 5_000, // 同账号连续请求间隔
  accountIntervalMs: 10_000, // 换账号间隔
  cooldownMs: 2 * 60 * 60 * 1000, // 命中 200013 冷却 2 小时
  incrementalMaxPages: 3, // 增量轮询每号最大页数
  historyMaxPages: 20, // 历史抓取最大页数
  pageSize: 10
} as const
