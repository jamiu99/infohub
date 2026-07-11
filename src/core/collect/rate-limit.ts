// 采集限流参数。联调阶段取【极保守】值以保护真实账号（应 jamiu 要求）。
// refs 实测上限是 50/时、5s 间隔；这里刻意压更低。稳定后再按需放宽。
export const RATE_LIMIT = {
  hourLimit: 20, // 每账号每小时最大请求数（保守，远低于实测 50）
  requestIntervalMs: 10_000, // 同账号连续请求间隔（拉长到 10s）
  accountIntervalMs: 15_000, // 换账号间隔
  cooldownMs: 2 * 60 * 60 * 1000, // 命中 200013 冷却 2 小时
  incrementalMaxPages: 1, // 联调期单号单次只拉 1 页（尽量少碰接口）
  historyMaxPages: 20, // 历史抓取最大页数（暂不用）
  pageSize: 10
} as const
